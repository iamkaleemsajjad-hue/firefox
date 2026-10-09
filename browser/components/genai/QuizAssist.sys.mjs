/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * QuizAssist — native Firefox AI quiz assistant singleton.
 *
 * Coordinates keyboard shortcuts, question extraction (via QuizAssistChild),
 * AI dispatch (via the existing GenAI pipeline or direct REST APIs),
 * overlay management, and history persistence.
 *
 * Keyboard shortcuts (registered in browser-sets.inc.xhtml):
 *   Alt+A          → analyze & answer current question
 *   Alt+S          → toggle answer overlay
 *   Alt+D          → dismiss overlay
 *   Alt+Shift+H    → open history viewer
 *
 * Alt+Shift (hold) → temporarily reveal overlay  [handled in overlay element]
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  EveryWindow: "resource:///modules/EveryWindow.sys.mjs",
  GenAI: "moz-src:///browser/components/genai/GenAI.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  QuizHistory: "moz-src:///browser/components/genai/QuizHistory.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "quizEnabled",
  "browser.quizAssist.enabled",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "apiProvider",
  "browser.quizAssist.apiProvider",
  ""
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "apiKey",
  "browser.quizAssist.apiKey",
  ""
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "autoFill",
  "browser.quizAssist.autoFill",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "historyRetentionDays",
  "browser.quizAssist.historyRetentionDays",
  30
);

const OVERLAY_PANEL_ID = "quiz-assist-overlay-panel";
const HISTORY_SIDEBAR_ID = "viewQuizAssistHistorySidebar";

export const QuizAssist = {
  _initialized: false,

  // Per-window overlay visibility state  (WeakMap<window, boolean>)
  _overlayVisible: new WeakMap(),

  // Last analyzed question per window (WeakMap<window, object>)
  _lastQuestion: new WeakMap(),

  // Last AI answer per window (WeakMap<window, object>)
  _lastAnswer: new WeakMap(),

  // In-flight request cancellation tokens (WeakMap<window, AbortController>)
  _pendingRequests: new WeakMap(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    // Wire the global command handlers to each browser window as it opens
    lazy.EveryWindow.registerCallback(
      "quiz-assist",
      win => this._initWindow(win),
      win => this._uninitWindow(win)
    );
  },

  // ---------------------------------------------------------------------------
  // Per-window lifecycle
  // ---------------------------------------------------------------------------

  _initWindow(_win) {
    // Per-window state is lazily initialized via WeakMap on first use.
    // Keyboard shortcuts are wired in browser-sets.js which directly calls
    // QuizAssist methods — no additional command listeners needed here.
  },


  _uninitWindow(win) {
    this.dismissOverlay(win);
    this._overlayVisible.delete(win);
    this._lastQuestion.delete(win);
    this._lastAnswer.delete(win);
    const ctrl = this._pendingRequests.get(win);
    ctrl?.abort();
    this._pendingRequests.delete(win);
  },

  // ---------------------------------------------------------------------------
  // ALT+A — Analyze and Answer
  // ---------------------------------------------------------------------------

  async analyzeAndAnswer(win) {
    this.init();
    if (!lazy.quizEnabled) {
      return;
    }

    const browser = win.gBrowser?.selectedBrowser;
    if (!browser) {
      return;
    }

    // Cancel any in-flight request
    const oldCtrl = this._pendingRequests.get(win);
    oldCtrl?.abort();
    const ctrl = new AbortController();
    this._pendingRequests.set(win, ctrl);

    const requestId = crypto.randomUUID();
    const startMs = Date.now();
    let questionData = null;
    let aiAnswer = null;
    let errorDetail = "";

    try {
      // Step 1: Extract question from content process
      questionData = await this._extractQuestion(browser);
      if (!questionData || questionData.error) {
        errorDetail = questionData?.error ?? "extraction_failed";
        this._showOverlayMessage(win, `Could not detect a question on this page. (${errorDetail})`);
        return;
      }

      this._lastQuestion.set(win, questionData);

      // Step 2: Build prompt
      const prompt = this._buildPrompt(questionData);

      // Step 3: Send to AI
      aiAnswer = await this._queryAI(questionData, prompt, ctrl.signal);
      if (!aiAnswer) {
        errorDetail = "ai_no_response";
        this._showOverlayMessage(win, "AI provider did not return a response.");
        return;
      }

      this._lastAnswer.set(win, aiAnswer);

      // Step 4: Show overlay
      this.showOverlay(win, questionData, aiAnswer);

      // Step 5: Optional authorized auto-fill
      if (lazy.autoFill && questionData.answer_targets?.length) {
        const fillResult = await this._fillAnswer(browser, questionData, aiAnswer);
        aiAnswer._fillResult = fillResult;
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("QuizAssist analyzeAndAnswer error:", e);
        errorDetail = String(e);
        this._showOverlayMessage(win, "An error occurred: " + e.message);
      }
    } finally {
      // Step 6: Persist to history (skip in private browsing)
      if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win) && questionData) {
        const latencyMs = Date.now() - startMs;
        await lazy.QuizHistory.addRecord({
          requestId,
          origin: browser.currentURI?.host ?? "",
          url: browser.currentURI?.spec ?? "",
          pageTitle: win.gBrowser?.selectedTab?.label ?? "",
          questionType: questionData.type,
          questionText: questionData.question_text,
          options: questionData.options,
          provider: aiAnswer?.provider ?? lazy.apiProvider,
          promptPayload: aiAnswer?._prompt ?? "",
          aiResponse: aiAnswer?._rawResponse ?? "",
          parsedAnswer: aiAnswer,
          fillAttempted: !!(lazy.autoFill && questionData.answer_targets?.length),
          fillResult: aiAnswer?._fillResult?.message ?? "",
          latencyMs,
          confidence: aiAnswer?.confidence ?? -1,
          errorDetail,
        }).catch(ex => console.error("QuizHistory write failed:", ex));
      }
      if (ctrl === this._pendingRequests.get(win)) {
        this._pendingRequests.delete(win);
      }
    }
  },

  // ---------------------------------------------------------------------------
  // Question extraction via JSWindowActor
  // ---------------------------------------------------------------------------

  async _extractQuestion(browser) {
    const wgp = browser.browsingContext?.currentWindowGlobal;
    if (!wgp) {
      return { error: "no_window_global" };
    }
    const actor = wgp.getActor("QuizAssist");
    if (!actor) {
      return { error: "no_actor" };
    }
    return actor.extractQuestion();
  },

  // ---------------------------------------------------------------------------
  // Prompt construction
  // ---------------------------------------------------------------------------

  _buildPrompt(question) {
    const lines = [];
    lines.push("You are an expert quiz assistant. Analyze the following question carefully and provide a precise, well-explained answer.");
    lines.push("");
    lines.push(`Question type: ${question.type}`);
    lines.push(`Question: ${question.question_text}`);

    if (question.options?.length) {
      lines.push("");
      lines.push("Options:");
      question.options.forEach(o => {
        lines.push(`  ${o.id}. ${o.text}`);
      });
    }

    if (question.images?.length) {
      lines.push("");
      lines.push(`Note: This question contains ${question.images.length} image(s).`);
      question.images.forEach(img => {
        if (img.alt) {
          lines.push(`  Image description: ${img.alt}`);
        }
      });
    }

    lines.push("");
    lines.push("Respond with JSON in this exact format:");
    lines.push(JSON.stringify({
      question_type: "<type>",
      selected_option_ids: ["<id>"],
      answer_text: "<answer>",
      explanation: "<explanation>",
      confidence: 0.0,
      uncertainty_notes: [],
    }, null, 2));

    return lines.join("\n");
  },

  // ---------------------------------------------------------------------------
  // AI dispatch
  // ---------------------------------------------------------------------------

  /**
   * Send the question to the configured AI provider.
   * If an API key is configured, calls the REST API directly.
   * Otherwise falls back to the GenAI web-UI dispatch.
   *
   * @param {object} question
   * @param {string} prompt
   * @param {AbortSignal} signal
   * @returns {Promise<object|null>}
   */
  async _queryAI(question, prompt, signal) {
    const apiKey = lazy.apiKey;
    const apiProvider = lazy.apiProvider;

    if (apiKey && apiProvider) {
      return this._queryAPIDirectly(apiProvider, apiKey, prompt, question, signal);
    }

    // Web-UI fallback: open the provider page with the prompt pre-filled.
    // We return a synthetic answer object so the overlay shows helpful text.
    return this._queryViaWebUI(question, prompt);
  },

  /**
   * Direct REST API call (requires user-supplied API key).
   * Supports: openai, gemini, anthropic.
   *
   * @param {string} provider  "openai" | "gemini" | "anthropic"
   * @param {string} apiKey
   * @param {string} prompt
   * @param {object} question
   * @param {AbortSignal} signal
   * @returns {Promise<object|null>}
   */
  async _queryAPIDirectly(provider, apiKey, prompt, question, signal) {
    let url, headers, body;

    switch (provider) {
      case "openai":
        url = "https://api.openai.com/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };
        body = JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: 1024,
        });
        break;

      case "gemini":
        url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        });
        break;

      case "anthropic":
        url = "https://api.anthropic.com/v1/messages";
        headers = {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        };
        body = JSON.stringify({
          model: "claude-opus-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        });
        break;

      default:
        console.warn("QuizAssist: unknown provider:", provider);
        return null;
    }

    const startMs = Date.now();
    let rawText = "";

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }

      const json = await resp.json();

      // Extract content string from provider-specific response envelope
      if (provider === "openai") {
        rawText = json.choices?.[0]?.message?.content ?? "";
      } else if (provider === "gemini") {
        rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      } else if (provider === "anthropic") {
        rawText = json.content?.[0]?.text ?? "";
      }
    } catch (e) {
      if (e.name === "AbortError") {
        throw e;
      }
      console.error("QuizAssist API error:", e);
      return {
        question_type: question.type,
        selected_option_ids: [],
        answer_text: "",
        explanation: `API error: ${e.message}`,
        confidence: -1,
        uncertainty_notes: ["api_error"],
        provider,
        _rawResponse: "",
        _prompt: prompt,
        processing_time_ms: Date.now() - startMs,
      };
    }

    // Parse AI JSON response
    let parsed = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // AI returned non-JSON; surface raw text
      parsed = {
        question_type: question.type,
        answer_text: rawText,
        explanation: rawText,
        selected_option_ids: [],
        confidence: -1,
        uncertainty_notes: ["json_parse_failed"],
      };
    }

    return {
      ...parsed,
      provider,
      _rawResponse: rawText,
      _prompt: prompt,
      processing_time_ms: Date.now() - startMs,
    };
  },

  /**
   * Web-UI fallback: dispatch via GenAI pipeline which opens the provider
   * chat page with the question as the prompt.
   *
   * @param {object} question
   * @param {string} prompt
   * @returns {object} Synthetic answer directing user to check the chat panel.
   */
  async _queryViaWebUI(question, prompt) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      return null;
    }

    const browser = win.gBrowser.selectedBrowser;
    const provider = lazy.GenAI.currentChatProviderInfo?.name || "AI provider";

    // Use the existing GenAI dispatch to open the chat with the question
    await lazy.GenAI.handleAskChat(
      { value: prompt, label: "Quiz Question" },
      {
        window: win,
        entry: "quiz-assist",
        contentType: "selection",
        selection: question.question_text,
        tabTitle: win.gBrowser.selectedTab?.label ?? "",
        pageUrl: browser.currentURI?.asciiHost ?? "",
      }
    );

    return {
      question_type: question.type,
      selected_option_ids: [],
      answer_text: `Question sent to ${provider}. Check the AI chat panel for the answer.`,
      explanation: `The question has been sent to ${provider} via the chat sidebar. Review the response there and come back to fill in the answer manually or with Alt+A once you have the answer.`,
      confidence: -1,
      uncertainty_notes: ["web_ui_fallback"],
      provider: provider,
      _rawResponse: "",
      _prompt: prompt,
      processing_time_ms: 0,
    };
  },


  // ---------------------------------------------------------------------------
  // Form filling
  // ---------------------------------------------------------------------------

  async _fillAnswer(browser, question, answer) {
    const wgp = browser.browsingContext?.currentWindowGlobal;
    if (!wgp) {
      return { filled: false, message: "no_window_global" };
    }
    const actor = wgp.getActor("QuizAssist");
    if (!actor) {
      return { filled: false, message: "no_actor" };
    }
    return actor.fillAnswer({
      type: answer.question_type || question.type,
      selected_option_ids: answer.selected_option_ids ?? [],
      answer_text: answer.answer_text ?? "",
      answer_targets: question.answer_targets ?? [],
    });
  },

  // ---------------------------------------------------------------------------
  // ALT+S — Toggle overlay
  // ---------------------------------------------------------------------------

  toggleOverlay(win) {
    const visible = this._overlayVisible.get(win);
    if (visible) {
      this.dismissOverlay(win);
    } else {
      const answer = this._lastAnswer.get(win);
      const question = this._lastQuestion.get(win);
      if (answer && question) {
        this.showOverlay(win, question, answer);
      } else {
        this._showOverlayMessage(win, "No analysis yet. Press Alt+A to analyze the current question.");
      }
    }
  },

  // ---------------------------------------------------------------------------
  // Overlay management
  // ---------------------------------------------------------------------------

  /**
   * Show the answer overlay panel in the given chrome window.
   *
   * @param {Window} win
   * @param {object} question
   * @param {object} answer
   */
  showOverlay(win, question, answer) {
    const panel = this._getOrCreatePanel(win);
    if (!panel) {
      return;
    }

    const el = panel.querySelector("quiz-overlay");
    if (el) {
      el.setData(question, answer);
    }

    this._overlayVisible.set(win, true);
    this._openPanel(win, panel);
  },

  _showOverlayMessage(win, message) {
    const panel = this._getOrCreatePanel(win);
    if (!panel) {
      return;
    }
    const el = panel.querySelector("quiz-overlay");
    if (el) {
      el.setMessage(message);
    }
    this._overlayVisible.set(win, true);
    this._openPanel(win, panel);
  },

  _openPanel(win, panel) {
    if (panel.state === "open" || panel.state === "showing") {
      return;
    }
    // Anchor to the right side of the browser content area
    const anchor =
      win.document.getElementById("appcontent") ??
      win.document.getElementById("browser") ??
      win.document.documentElement;
    panel.openPopup(anchor, "overlap", -10, 10, false, false);
  },

  // ---------------------------------------------------------------------------
  // ALT+D — Dismiss overlay
  // ---------------------------------------------------------------------------

  dismissOverlay(win) {
    const panel = win.document.getElementById(OVERLAY_PANEL_ID);
    if (panel && (panel.state === "open" || panel.state === "showing")) {
      panel.hidePopup();
    }
    this._overlayVisible.set(win, false);
  },

  // ---------------------------------------------------------------------------
  // ALT+SHIFT+H — Open history viewer
  // ---------------------------------------------------------------------------

  openHistory(win) {
    win.SidebarController?.show(HISTORY_SIDEBAR_ID);
  },

  // ---------------------------------------------------------------------------
  // Panel creation
  // ---------------------------------------------------------------------------

  /**
   * Get or lazily create the overlay panel in the chrome window's popupset.
   *
   * @param {Window} win
   * @returns {Element|null}
   */
  _getOrCreatePanel(win) {
    const doc = win.document;
    let panel = doc.getElementById(OVERLAY_PANEL_ID);
    if (panel) {
      return panel;
    }

    // Load the quiz-overlay custom element definition if not yet loaded
    if (!win.customElements.get("quiz-overlay")) {
      const script = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "script"
      );
      script.setAttribute("type", "module");
      script.setAttribute(
        "src",
        "chrome://browser/content/genai/content/quiz-overlay.mjs"
      );
      doc.head?.appendChild(script);
    }

    // Create the floating panel container
    panel = doc.createXULElement("panel");
    panel.id = OVERLAY_PANEL_ID;
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("noautohide", "true");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Quiz Assistant Answer");
    panel.style.cssText =
      "position:fixed;top:60px;right:12px;z-index:2147483647;" +
      "border:none;background:transparent;padding:0;";

    const overlayEl = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "quiz-overlay"
    );
    panel.appendChild(overlayEl);

    // Append to the main popupset
    const popupset =
      doc.getElementById("mainPopupSet") ??
      doc.querySelector("popupset") ??
      doc.documentElement;
    popupset.appendChild(panel);

    return panel;
  },
};

// Auto-initialize on first import so EveryWindow picks up all open windows.
QuizAssist.init();
