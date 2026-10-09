/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActorChild that runs in the content process and detects quiz
 * questions on the active page, extracting their text, options, and type.
 */
export class QuizAssistChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    switch (name) {
      case "QuizAssist:ExtractQuestion":
        return this.#extractQuestion(data);
      case "QuizAssist:FillAnswer":
        return this.#fillAnswer(data);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Question extraction
  // ---------------------------------------------------------------------------

  /**
   * Top-level entry point called from the parent.
   *
   * @param {object} opts
   * @param {boolean} opts.fillAnswer  Whether to also attempt form filling.
   * @returns {object} Structured question data.
   */
  async #extractQuestion({ fillAnswer = false } = {}) {
    const doc = this.document;
    if (!doc) {
      return { error: "no_document" };
    }

    const question = this.#detectQuestion(doc);
    if (!question) {
      return { error: "no_question_found" };
    }

    return question;
  }

  /**
   * Walk the DOM looking for the most prominent question on the page.
   * Tries multiple detection strategies in order of specificity.
   *
   * @param {Document} doc
   * @returns {object|null} Structured question or null.
   */
  #detectQuestion(doc) {
    // Strategy 1: look for radio/checkbox groups with an associated question label
    const radioResult = this.#detectRadioQuestion(doc);
    if (radioResult) {
      return radioResult;
    }

    // Strategy 2: look for a <select> with a question nearby
    const selectResult = this.#detectSelectQuestion(doc);
    if (selectResult) {
      return selectResult;
    }

    // Strategy 3: look for textarea / text input with a question label
    const textResult = this.#detectTextQuestion(doc);
    if (textResult) {
      return textResult;
    }

    // Strategy 4: ARIA roles (role="radiogroup", role="listbox", etc.)
    const ariaResult = this.#detectAriaQuestion(doc);
    if (ariaResult) {
      return ariaResult;
    }

    // Strategy 5: heuristic — first element that reads like a question sentence
    return this.#detectHeuristicQuestion(doc);
  }

  // ---- Strategy 1: radio / checkbox groups ----

  #detectRadioQuestion(doc) {
    // Fieldset with legend is the canonical HTML for question groups
    for (const fieldset of doc.querySelectorAll("fieldset")) {
      const legend = fieldset.querySelector("legend");
      if (!legend) {
        continue;
      }
      const questionText = legend.textContent.trim();
      if (!questionText) {
        continue;
      }

      const inputs = [
        ...fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]'),
      ];
      if (!inputs.length) {
        continue;
      }

      const isMulti = inputs.some(i => i.type === "checkbox");
      const options = this.#extractInputOptions(inputs, fieldset);

      return {
        question_id: this.#hashText(questionText),
        type: isMulti ? "multiple_choice" : "single_choice",
        question_text: questionText,
        options,
        images: this.#extractImages(fieldset),
        answer_targets: inputs.map(i => ({
          id: i.id,
          name: i.name,
          value: i.value,
          type: i.type,
        })),
        source_url: doc.location.href,
        extraction_confidence: 0.9,
      };
    }

    // Non-fieldset radio groups: find a radio, walk up to find label text
    const firstRadio = doc.querySelector('input[type="radio"]');
    if (!firstRadio) {
      return null;
    }

    const container = this.#findQuestionContainer(firstRadio);
    if (!container) {
      return null;
    }

    const questionText = this.#extractContainerQuestionText(container);
    if (!questionText) {
      return null;
    }

    const radios = [
      ...container.querySelectorAll('input[type="radio"]'),
      ...container.querySelectorAll('input[type="checkbox"]'),
    ];
    const isMulti = radios.some(r => r.type === "checkbox");
    const options = this.#extractInputOptions(radios, container);

    // True/false detection
    const lowerOptions = options.map(o => o.text.toLowerCase().trim());
    const isTrueFalse =
      lowerOptions.length === 2 &&
      lowerOptions.every(t => ["true", "false", "yes", "no"].includes(t));

    return {
      question_id: this.#hashText(questionText),
      type: isTrueFalse ? "true_false" : isMulti ? "multiple_choice" : "single_choice",
      question_text: questionText,
      options,
      images: this.#extractImages(container),
      answer_targets: radios.map(r => ({
        id: r.id,
        name: r.name,
        value: r.value,
        type: r.type,
      })),
      source_url: doc.location.href,
      extraction_confidence: 0.75,
    };
  }

  // ---- Strategy 2: select dropdown ----

  #detectSelectQuestion(doc) {
    const select = doc.querySelector("select");
    if (!select) {
      return null;
    }

    const container = this.#findQuestionContainer(select);
    const questionText = container
      ? this.#extractContainerQuestionText(container)
      : this.#findLabelText(select, doc);

    if (!questionText) {
      return null;
    }

    const options = [...select.options]
      .filter(o => o.value)
      .map((o, idx) => ({ id: String(idx), text: o.text.trim(), value: o.value }));

    return {
      question_id: this.#hashText(questionText),
      type: "dropdown",
      question_text: questionText,
      options,
      images: container ? this.#extractImages(container) : [],
      answer_targets: [{ id: select.id, name: select.name, type: "select" }],
      source_url: doc.location.href,
      extraction_confidence: 0.8,
    };
  }

  // ---- Strategy 3: textarea / text input ----

  #detectTextQuestion(doc) {
    const field = doc.querySelector("textarea") || doc.querySelector('input[type="text"]');
    if (!field) {
      return null;
    }

    const container = this.#findQuestionContainer(field);
    const questionText = container
      ? this.#extractContainerQuestionText(container)
      : this.#findLabelText(field, doc);

    if (!questionText) {
      return null;
    }

    const tag = field.tagName.toLowerCase();
    const type = tag === "textarea" ? "long_answer" : "short_answer";

    return {
      question_id: this.#hashText(questionText),
      type,
      question_text: questionText,
      options: [],
      images: container ? this.#extractImages(container) : [],
      answer_targets: [{ id: field.id, name: field.name, type: tag }],
      source_url: doc.location.href,
      extraction_confidence: 0.7,
    };
  }

  // ---- Strategy 4: ARIA roles ----

  #detectAriaQuestion(doc) {
    const group = doc.querySelector('[role="radiogroup"], [role="group"], [role="listbox"]');
    if (!group) {
      return null;
    }

    const labelId = group.getAttribute("aria-labelledby");
    let questionText = "";
    if (labelId) {
      questionText = doc.getElementById(labelId)?.textContent.trim() ?? "";
    }
    if (!questionText) {
      questionText = group.getAttribute("aria-label") ?? "";
    }
    if (!questionText) {
      questionText = this.#extractContainerQuestionText(group);
    }
    if (!questionText) {
      return null;
    }

    const items = [
      ...group.querySelectorAll('[role="radio"], [role="option"], [role="checkbox"]'),
    ];
    const options = items.map((el, idx) => ({
      id: String(idx),
      text: (el.textContent || el.getAttribute("aria-label") || "").trim(),
      value: el.getAttribute("data-value") ?? String(idx),
    }));

    return {
      question_id: this.#hashText(questionText),
      type: "single_choice",
      question_text: questionText,
      options,
      images: this.#extractImages(group),
      answer_targets: items.map((el, idx) => ({
        id: el.id,
        index: idx,
        role: el.getAttribute("role"),
      })),
      source_url: doc.location.href,
      extraction_confidence: 0.65,
    };
  }

  // ---- Strategy 5: heuristic question sentence ----

  #detectHeuristicQuestion(doc) {
    // Look for the first element whose text ends with "?" or starts with common
    // question words, skipping navigation and boilerplate elements.
    const candidates = doc.querySelectorAll("p, h1, h2, h3, h4, h5, li, div, span");
    for (const el of candidates) {
      if (el.children.length > 5) {
        continue;
      }
      const text = el.textContent.trim();
      if (text.length < 10 || text.length > 2000) {
        continue;
      }
      if (this.#looksLikeQuestion(text)) {
        return {
          question_id: this.#hashText(text),
          type: "short_answer",
          question_text: text,
          options: [],
          images: this.#extractImages(el),
          answer_targets: [],
          source_url: doc.location.href,
          extraction_confidence: 0.4,
        };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Answer filling
  // ---------------------------------------------------------------------------

  /**
   * Fill answer controls with the AI-chosen answer.
   *
   * @param {object} data
   * @param {string} data.type  Question type.
   * @param {string[]} data.selected_option_ids  Selected option IDs.
   * @param {string} data.answer_text  For text questions.
   * @param {object[]} data.answer_targets  From the original extraction.
   * @returns {{ filled: boolean, message: string }}
   */
  #fillAnswer({ type, selected_option_ids = [], answer_text = "", answer_targets = [] }) {
    try {
      const doc = this.document;
      switch (type) {
        case "single_choice":
        case "true_false":
          return this.#fillRadio(doc, answer_targets, selected_option_ids[0]);
        case "multiple_choice":
          return this.#fillCheckboxes(doc, answer_targets, selected_option_ids);
        case "dropdown":
          return this.#fillSelect(doc, answer_targets, selected_option_ids[0]);
        case "short_answer":
        case "long_answer":
        case "fill_blank":
          return this.#fillText(doc, answer_targets, answer_text);
        default:
          return { filled: false, message: "unsupported_type" };
      }
    } catch (e) {
      return { filled: false, message: String(e) };
    }
  }

  #fillRadio(doc, targets, value) {
    const target = targets.find(t => t.value === value);
    if (!target) {
      return { filled: false, message: "no_matching_radio" };
    }
    const el = target.id
      ? doc.getElementById(target.id)
      : doc.querySelector(`input[name="${target.name}"][value="${target.value}"]`);
    if (!el) {
      return { filled: false, message: "element_not_found" };
    }
    if (!el.checked) {
      el.click();
    }
    return { filled: true, message: "ok" };
  }

  #fillCheckboxes(doc, targets, values) {
    let filledCount = 0;
    for (const value of values) {
      const target = targets.find(t => t.value === value);
      if (!target) {
        continue;
      }
      const el = target.id
        ? doc.getElementById(target.id)
        : doc.querySelector(`input[name="${target.name}"][value="${value}"]`);
      if (el && !el.checked) {
        el.click();
        filledCount++;
      }
    }
    return {
      filled: filledCount > 0,
      message: filledCount > 0 ? "ok" : "no_matching_checkbox",
    };
  }

  #fillSelect(doc, targets, value) {
    const target = targets[0];
    if (!target) {
      return { filled: false, message: "no_target" };
    }
    const el = target.id
      ? doc.getElementById(target.id)
      : doc.querySelector(`select[name="${target.name}"]`);
    if (!el) {
      return { filled: false, message: "element_not_found" };
    }
    const option = [...el.options].find(o => o.value === value || o.text.trim() === value);
    if (!option) {
      return { filled: false, message: "option_not_found" };
    }
    el.value = option.value;
    el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
    return { filled: true, message: "ok" };
  }

  #fillText(doc, targets, text) {
    const target = targets[0];
    if (!target) {
      return { filled: false, message: "no_target" };
    }
    const el = target.id
      ? doc.getElementById(target.id)
      : doc.querySelector(
          `input[name="${target.name}"], textarea[name="${target.name}"]`
        );
    if (!el) {
      return { filled: false, message: "element_not_found" };
    }
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      this.contentWindow.HTMLInputElement.prototype,
      "value"
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      this.contentWindow.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    const setter =
      el.tagName === "TEXTAREA" ? nativeTextareaValueSetter : nativeInputValueSetter;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
    el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
    return { filled: true, message: "ok" };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #findQuestionContainer(el) {
    let node = el.parentElement;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (["form", "section", "article", "main", "div"].includes(tag)) {
        const text = node.textContent.trim();
        if (text.length > 20) {
          return node;
        }
      }
    }
    return null;
  }

  #extractContainerQuestionText(container) {
    // First look for a heading or explicit question element
    for (const selector of [
      "[class*='question']",
      "[class*='prompt']",
      "[class*='stem']",
      "legend",
      "h1",
      "h2",
      "h3",
      "h4",
      "p",
    ]) {
      const el = container.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        if (text.length > 5) {
          return text;
        }
      }
    }
    // Fallback: first text node child
    for (const child of container.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.trim();
        if (text.length > 5) {
          return text;
        }
      }
    }
    return "";
  }

  #findLabelText(el, doc) {
    if (el.id) {
      const label = doc.querySelector(`label[for="${el.id}"]`);
      if (label) {
        return label.textContent.trim();
      }
    }
    const label = el.closest("label");
    if (label) {
      return label.textContent.trim();
    }
    return el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "";
  }

  #extractInputOptions(inputs, container) {
    return inputs.map((input, idx) => {
      const id = input.id;
      let text = "";
      if (id) {
        const label = container.querySelector(`label[for="${id}"]`);
        if (label) {
          text = label.textContent.trim();
        }
      }
      if (!text) {
        text = input.closest("label")?.textContent.trim() ?? "";
      }
      if (!text) {
        text = input.getAttribute("aria-label") ?? input.value ?? "";
      }
      return { id: String(idx), text, value: input.value };
    });
  }

  #extractImages(container) {
    const images = [];
    for (const img of container.querySelectorAll("img")) {
      const src = img.src || img.currentSrc || "";
      const alt = img.alt || "";
      if (src) {
        images.push({ src, alt });
      }
    }
    return images;
  }

  #looksLikeQuestion(text) {
    if (text.endsWith("?")) {
      return true;
    }
    const lower = text.toLowerCase();
    return (
      lower.startsWith("what ") ||
      lower.startsWith("which ") ||
      lower.startsWith("who ") ||
      lower.startsWith("how ") ||
      lower.startsWith("when ") ||
      lower.startsWith("where ") ||
      lower.startsWith("why ") ||
      lower.startsWith("is ") ||
      lower.startsWith("are ") ||
      lower.startsWith("define ") ||
      lower.startsWith("calculate ") ||
      lower.startsWith("solve ") ||
      lower.startsWith("find ")
    );
  }

  /**
   * Simple djb2 hash for deduplication.
   *
   * @param {string} text
   * @returns {string}
   */
  #hashText(text) {
    let hash = 5381;
    for (let i = 0; i < Math.min(text.length, 200); i++) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }
}
