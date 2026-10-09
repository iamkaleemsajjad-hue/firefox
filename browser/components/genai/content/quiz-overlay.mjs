/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, css } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * <quiz-overlay> — floating answer panel for the Quiz Assistant.
 *
 * Alt+Shift (hold) = temporarily full-opacity reveal.
 * The panel is keyboard accessible (focusable, Escape closes it).
 */
export class QuizOverlay extends MozLitElement {
  static properties = {
    _question: { state: true },
    _answer: { state: true },
    _message: { state: true },
    _revealed: { state: true },
    _minimized: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      width: 340px;
      max-height: 80vh;
      overflow-y: auto;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }

    .overlay-root {
      background: rgba(20, 20, 35, 0.88);
      backdrop-filter: blur(10px);
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e8e8f0;
      padding: 0;
      transition: opacity 0.25s ease;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
    }

    .overlay-root.dimmed {
      opacity: 0.18;
    }

    .overlay-root.revealed,
    .overlay-root:focus-within {
      opacity: 1;
    }

    .overlay-root.minimized .body {
      display: none;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      cursor: default;
      user-select: none;
    }

    .header-title {
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.04em;
      color: #a0a8d0;
      text-transform: uppercase;
    }

    .header-controls {
      display: flex;
      gap: 6px;
    }

    .ctrl-btn {
      background: none;
      border: none;
      color: #7080a8;
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1;
    }

    .ctrl-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #c8d0f0;
    }

    /* Body */
    .body {
      padding: 12px 14px;
    }

    .hint {
      font-size: 11px;
      color: #6070a0;
      margin-bottom: 8px;
      font-style: italic;
    }

    /* Question type badge */
    .type-badge {
      display: inline-block;
      background: rgba(100, 120, 220, 0.25);
      color: #8898e8;
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    /* Question text */
    .question-text {
      color: #c0c8e8;
      margin-bottom: 10px;
      font-size: 12px;
      border-left: 2px solid rgba(100, 120, 220, 0.4);
      padding-left: 8px;
      max-height: 80px;
      overflow-y: auto;
    }

    /* Answer */
    .answer-section {
      margin-bottom: 10px;
    }

    .answer-label {
      font-size: 11px;
      color: #6070a0;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
    }

    .answer-value {
      color: #78e8a0;
      font-weight: 700;
      font-size: 14px;
    }

    /* Explanation */
    .explanation {
      color: #b0b8d8;
      font-size: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 8px;
      max-height: 140px;
      overflow-y: auto;
    }

    /* Confidence */
    .confidence {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
    }

    .confidence-label {
      font-size: 11px;
      color: #6070a0;
    }

    .confidence-bar-wrap {
      flex: 1;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
    }

    .confidence-bar {
      height: 100%;
      background: linear-gradient(90deg, #5068d8, #78e8a0);
      border-radius: 2px;
      transition: width 0.4s ease;
    }

    .confidence-pct {
      font-size: 11px;
      color: #8898e8;
      min-width: 28px;
      text-align: right;
    }

    /* Message (error / info) */
    .message-text {
      color: #d8c090;
      font-size: 12px;
      padding: 6px 0;
    }

    /* Provider badge */
    .provider-row {
      margin-top: 8px;
      font-size: 10px;
      color: #506080;
    }

    /* Uncertainty notes */
    .uncertainty {
      margin-top: 6px;
      font-size: 11px;
      color: #c08060;
    }
  `;

  constructor() {
    super();
    this._question = null;
    this._answer = null;
    this._message = "";
    this._revealed = false;
    this._minimized = false;
    this._onKeyDown = this.#onKeyDown.bind(this);
    this._onKeyUp = this.#onKeyUp.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("tabindex", "-1");
    this.ownerDocument.addEventListener("keydown", this._onKeyDown, true);
    this.ownerDocument.addEventListener("keyup", this._onKeyUp, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ownerDocument.removeEventListener("keydown", this._onKeyDown, true);
    this.ownerDocument.removeEventListener("keyup", this._onKeyUp, true);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setData(question, answer) {
    this._question = question;
    this._answer = answer;
    this._message = "";
    this._minimized = false;
  }

  setMessage(msg) {
    this._message = msg;
    this._question = null;
    this._answer = null;
    this._minimized = false;
  }

  // ---------------------------------------------------------------------------
  // Alt+Shift reveal behaviour
  // ---------------------------------------------------------------------------

  #onKeyDown(e) {
    if (e.altKey && e.shiftKey) {
      this._revealed = true;
    }
  }

  #onKeyUp(e) {
    if (!e.altKey || !e.shiftKey) {
      this._revealed = false;
    }
    // Escape closes the overlay
    if (e.key === "Escape") {
      this.#dismiss();
    }
  }

  #dismiss() {
    const panel = this.closest("panel");
    if (panel) {
      panel.hidden = true;
    }
  }

  #toggleMinimize() {
    this._minimized = !this._minimized;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render() {
    const rootClass = [
      "overlay-root",
      this._revealed ? "revealed" : "dimmed",
      this._minimized ? "minimized" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return html`
      <div class=${rootClass} role="dialog" aria-label="Quiz Assistant Answer">
        <div class="header">
          <span class="header-title">Quiz Assist</span>
          <div class="header-controls">
            <button
              class="ctrl-btn"
              title="${this._minimized ? "Expand" : "Minimize"}"
              aria-label="${this._minimized ? "Expand overlay" : "Minimize overlay"}"
              @click=${this.#toggleMinimize}
            >
              ${this._minimized ? "▲" : "▼"}
            </button>
            <button
              class="ctrl-btn"
              title="Close (Alt+D)"
              aria-label="Close overlay"
              @click=${this.#dismiss}
            >
              ✕
            </button>
          </div>
        </div>

        <div class="body">
          <div class="hint">Hold Alt+Shift to reveal · Alt+D to close</div>
          ${this._message ? this.#renderMessage() : ""}
          ${this._answer ? this.#renderAnswer() : ""}
        </div>
      </div>
    `;
  }

  #renderMessage() {
    return html`<div class="message-text">${this._message}</div>`;
  }

  #renderAnswer() {
    const q = this._question;
    const a = this._answer;

    const answerDisplay = this.#formatAnswerDisplay(a, q);
    const confidence = a.confidence >= 0 ? a.confidence : null;
    const uncertainties = a.uncertainty_notes?.filter(n => n !== "web_ui_fallback") ?? [];

    return html`
      ${q
        ? html`
            <div class="type-badge">${q.type?.replace(/_/g, " ")}</div>
            <div class="question-text">${q.question_text}</div>
          `
        : ""}

      <div class="answer-section">
        <div class="answer-label">Answer</div>
        <div class="answer-value">${answerDisplay}</div>
      </div>

      ${a.explanation
        ? html`<div class="explanation">${a.explanation}</div>`
        : ""}

      ${confidence !== null
        ? html`
            <div class="confidence">
              <span class="confidence-label">Confidence</span>
              <div class="confidence-bar-wrap">
                <div
                  class="confidence-bar"
                  style="width: ${Math.round(confidence * 100)}%"
                ></div>
              </div>
              <span class="confidence-pct">${Math.round(confidence * 100)}%</span>
            </div>
          `
        : ""}

      ${uncertainties.length
        ? html`<div class="uncertainty">⚠ ${uncertainties.join(", ")}</div>`
        : ""}

      ${a.provider
        ? html`<div class="provider-row">via ${a.provider} · ${a.processing_time_ms ?? 0}ms</div>`
        : ""}
    `;
  }

  #formatAnswerDisplay(answer, question) {
    if (answer.selected_option_ids?.length && question?.options?.length) {
      const matched = answer.selected_option_ids.map(id => {
        const opt = question.options.find(o => o.id === id);
        return opt ? `${opt.id}. ${opt.text}` : id;
      });
      return matched.join(", ");
    }
    return answer.answer_text || "(see explanation)";
  }
}

customElements.define("quiz-overlay", QuizOverlay);
