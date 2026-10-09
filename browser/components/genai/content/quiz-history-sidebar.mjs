/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, css } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const { QuizHistory } = ChromeUtils.importESModule(
  "moz-src:///browser/components/genai/QuizHistory.sys.mjs"
);

/**
 * <quiz-history-sidebar> — sidebar panel for Alt+Shift+H.
 *
 * Displays all QuizAssist history records with search, filter, export and
 * delete capabilities. Loaded from quiz-history.html.
 */
export class QuizHistorySidebar extends MozLitElement {
  static properties = {
    _records: { state: true },
    _search: { state: true },
    _loading: { state: true },
    _expanded: { state: true },
    _error: { state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      background: #1a1a2e;
      color: #e0e0f0;
      overflow: hidden;
    }

    .toolbar {
      padding: 10px 12px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }

    .toolbar-title {
      font-size: 14px;
      font-weight: 700;
      color: #a0a8e0;
      letter-spacing: 0.03em;
    }

    .toolbar-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    input[type="search"] {
      flex: 1;
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.06);
      color: #e0e0f0;
      font-size: 12px;
      outline: none;
    }

    input[type="search"]:focus {
      border-color: rgba(100, 120, 220, 0.5);
      background: rgba(100, 120, 220, 0.08);
    }

    .btn {
      padding: 4px 10px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
      color: #a0b0d0;
      cursor: pointer;
      font-size: 11px;
      white-space: nowrap;
    }

    .btn:hover {
      background: rgba(100, 120, 220, 0.2);
      color: #c8d8ff;
    }

    .btn-danger {
      border-color: rgba(220, 80, 80, 0.3);
      color: #e07070;
    }

    .btn-danger:hover {
      background: rgba(220, 80, 80, 0.2);
      color: #ff9090;
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .empty {
      text-align: center;
      color: #506080;
      padding: 40px 20px;
      font-style: italic;
    }

    .loading {
      text-align: center;
      color: #506080;
      padding: 40px;
    }

    .error-msg {
      color: #e07070;
      padding: 10px 12px;
      font-size: 12px;
    }

    .record {
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }

    .record-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.04);
      user-select: none;
    }

    .record-header:hover {
      background: rgba(100, 120, 220, 0.1);
    }

    .type-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: rgba(100, 120, 220, 0.2);
      color: #8898e8;
      padding: 1px 5px;
      border-radius: 3px;
      white-space: nowrap;
    }

    .record-question {
      flex: 1;
      font-size: 12px;
      color: #c0c8e8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .record-ts {
      font-size: 10px;
      color: #506080;
      white-space: nowrap;
    }

    .record-chevron {
      color: #506080;
      font-size: 10px;
    }

    .record-body {
      padding: 10px 12px;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .field {
      margin-bottom: 8px;
    }

    .field-label {
      font-size: 10px;
      color: #506080;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 2px;
    }

    .field-value {
      font-size: 12px;
      color: #b8c8e8;
      word-break: break-word;
    }

    .answer-value {
      color: #78e8a0;
      font-weight: 600;
    }

    .confidence-bar-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .conf-track {
      flex: 1;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
    }

    .conf-fill {
      height: 100%;
      background: linear-gradient(90deg, #5068d8, #78e8a0);
      border-radius: 2px;
    }

    .conf-pct {
      font-size: 11px;
      color: #8898e8;
      min-width: 28px;
    }

    .record-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 8px;
    }

    .url-link {
      color: #6888d8;
      text-decoration: none;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }

    .url-link:hover {
      text-decoration: underline;
    }
  `;

  constructor() {
    super();
    this._records = [];
    this._search = "";
    this._loading = true;
    this._expanded = new Set();
    this._error = "";
  }

  connectedCallback() {
    super.connectedCallback();
    this.#loadRecords();
  }

  async #loadRecords() {
    this._loading = true;
    this._error = "";
    try {
      this._records = await QuizHistory.getRecords({
        search: this._search,
        limit: 200,
        offset: 0,
      });
    } catch (e) {
      this._error = `Failed to load history: ${e.message}`;
    } finally {
      this._loading = false;
    }
  }

  #onSearchInput(e) {
    this._search = e.target.value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.#loadRecords(), 300);
  }

  async #exportAll() {
    try {
      const json = await QuizHistory.exportJson();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quiz-assist-history-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      this._error = `Export failed: ${e.message}`;
    }
  }

  async #clearAll() {
    if (!window.confirm("Delete all quiz assist history? This cannot be undone.")) {
      return;
    }
    try {
      await QuizHistory.clearAll();
      this._records = [];
    } catch (e) {
      this._error = `Clear failed: ${e.message}`;
    }
  }

  async #deleteRecord(id) {
    try {
      await QuizHistory.deleteRecord(id);
      this._records = this._records.filter(r => r.id !== id);
    } catch (e) {
      this._error = `Delete failed: ${e.message}`;
    }
  }

  #toggleExpand(id) {
    const next = new Set(this._expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this._expanded = next;
  }

  #formatTs(ts) {
    return new Date(ts).toLocaleString();
  }

  #formatAnswer(r) {
    try {
      const a = r.parsedAnswer;
      if (a?.selected_option_ids?.length) {
        const opts = r.options ?? [];
        return a.selected_option_ids
          .map(id => {
            const o = opts.find(x => x.id === id);
            return o ? `${o.id}. ${o.text}` : id;
          })
          .join(", ");
      }
      return a?.answer_text || a?.explanation || "—";
    } catch {
      return "—";
    }
  }

  render() {
    return html`
      <div class="toolbar">
        <span class="toolbar-title">Quiz Assist History</span>
        <div class="toolbar-row">
          <input
            type="search"
            placeholder="Search questions or URLs…"
            .value=${this._search}
            @input=${this.#onSearchInput}
          />
        </div>
        <div class="toolbar-row">
          <button class="btn" @click=${() => this.#loadRecords()}>↻ Refresh</button>
          <button class="btn" @click=${this.#exportAll}>⬇ Export JSON</button>
          <button class="btn btn-danger" @click=${this.#clearAll}>✕ Clear All</button>
        </div>
      </div>

      ${this._error ? html`<div class="error-msg">${this._error}</div>` : ""}

      <div class="list">
        ${this._loading
          ? html`<div class="loading">Loading…</div>`
          : this._records.length === 0
          ? html`<div class="empty">No quiz history yet.<br/>Press Alt+A on any quiz page to get started.</div>`
          : this._records.map(r => this.#renderRecord(r))}
      </div>
    `;
  }

  #renderRecord(r) {
    const expanded = this._expanded.has(r.id);
    const confidence = r.confidence >= 0 ? r.confidence : null;
    const answer = this.#formatAnswer(r);

    return html`
      <div class="record">
        <div class="record-header" @click=${() => this.#toggleExpand(r.id)}>
          <span class="type-badge">${(r.questionType || "?").replace(/_/g, " ")}</span>
          <span class="record-question" title=${r.questionText}>${r.questionText || "(no text)"}</span>
          <span class="record-ts">${this.#formatTs(r.ts)}</span>
          <span class="record-chevron">${expanded ? "▲" : "▼"}</span>
        </div>

        ${expanded
          ? html`
              <div class="record-body">
                ${r.url
                  ? html`
                      <div class="field">
                        <div class="field-label">Page</div>
                        <a class="url-link" href=${r.url} title=${r.url} target="_blank"
                          >${r.pageTitle || r.url}</a>
                      </div>
                    `
                  : ""}

                <div class="field">
                  <div class="field-label">Answer</div>
                  <div class="field-value answer-value">${answer}</div>
                </div>

                ${r.options?.length
                  ? html`
                      <div class="field">
                        <div class="field-label">Options</div>
                        <div class="field-value">
                          ${r.options.map(o => html`<div>${o.id}. ${o.text}</div>`)}
                        </div>
                      </div>
                    `
                  : ""}

                ${confidence !== null
                  ? html`
                      <div class="field">
                        <div class="field-label">Confidence</div>
                        <div class="confidence-bar-wrap">
                          <div class="conf-track">
                            <div class="conf-fill" style="width:${Math.round(confidence * 100)}%"></div>
                          </div>
                          <span class="conf-pct">${Math.round(confidence * 100)}%</span>
                        </div>
                      </div>
                    `
                  : ""}

                <div class="field">
                  <div class="field-label">Provider · Latency</div>
                  <div class="field-value">${r.provider || "—"} · ${r.latencyMs ?? 0}ms</div>
                </div>

                ${r.errorDetail
                  ? html`
                      <div class="field">
                        <div class="field-label">Error</div>
                        <div class="field-value" style="color:#e07070">${r.errorDetail}</div>
                      </div>
                    `
                  : ""}

                ${r.promptPayload
                  ? html`
                      <div class="field">
                        <div class="field-label">Prompt (truncated)</div>
                        <div class="field-value" style="font-size:11px;opacity:0.7">
                          ${r.promptPayload.slice(0, 300)}${r.promptPayload.length > 300 ? "…" : ""}
                        </div>
                      </div>
                    `
                  : ""}

                <div class="record-actions">
                  <button
                    class="btn btn-danger"
                    @click=${(e) => { e.stopPropagation(); this.#deleteRecord(r.id); }}
                  >Delete</button>
                </div>
              </div>
            `
          : ""}
      </div>
    `;
  }
}

customElements.define("quiz-history-sidebar", QuizHistorySidebar);
