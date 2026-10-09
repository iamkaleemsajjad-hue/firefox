/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * QuizHistory — lightweight SQLite-backed audit log for quiz assist sessions.
 *
 * Each record stores all pipeline data needed for the history viewer
 * (ALT+SHIFT+H). The schema intentionally omits passwords and auth tokens.
 */

import { Sqlite } from "resource://gre/modules/Sqlite.sys.mjs";

const DB_PATH = PathUtils.join(PathUtils.profileDir, "quizAssistHistory.sqlite");

const SCHEMA_VERSION = 1;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    origin      TEXT,
    url         TEXT,
    page_title  TEXT,
    question_type TEXT,
    question_text TEXT,
    options_json  TEXT,
    provider    TEXT,
    prompt_payload TEXT,
    ai_response TEXT,
    parsed_answer TEXT,
    fill_attempted INTEGER DEFAULT 0,
    fill_result TEXT,
    latency_ms  INTEGER,
    confidence  REAL,
    error_detail TEXT
  )
`;

export const QuizHistory = {
  _db: null,

  async getDb() {
    if (this._db) {
      return this._db;
    }
    this._db = await Sqlite.openConnection({ path: DB_PATH });
    await this._db.execute(CREATE_TABLE_SQL);
    await this._db.execute(
      `PRAGMA user_version = ${SCHEMA_VERSION}`
    );
    return this._db;
  },

  /**
   * Persist one quiz assist event.
   *
   * @param {object} record
   */
  async addRecord(record) {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO history
         (request_id, ts, origin, url, page_title, question_type,
          question_text, options_json, provider, prompt_payload,
          ai_response, parsed_answer, fill_attempted, fill_result,
          latency_ms, confidence, error_detail)
       VALUES
         (:request_id, :ts, :origin, :url, :page_title, :question_type,
          :question_text, :options_json, :provider, :prompt_payload,
          :ai_response, :parsed_answer, :fill_attempted, :fill_result,
          :latency_ms, :confidence, :error_detail)`,
      {
        request_id: record.requestId ?? crypto.randomUUID(),
        ts: Date.now(),
        origin: record.origin ?? "",
        url: record.url ?? "",
        page_title: record.pageTitle ?? "",
        question_type: record.questionType ?? "",
        question_text: record.questionText ?? "",
        options_json: JSON.stringify(record.options ?? []),
        provider: record.provider ?? "",
        prompt_payload: record.promptPayload ?? "",
        ai_response: record.aiResponse ?? "",
        parsed_answer: JSON.stringify(record.parsedAnswer ?? {}),
        fill_attempted: record.fillAttempted ? 1 : 0,
        fill_result: record.fillResult ?? "",
        latency_ms: record.latencyMs ?? 0,
        confidence: record.confidence ?? -1,
        error_detail: record.errorDetail ?? "",
      }
    );
  },

  /**
   * Query history records with optional filtering.
   *
   * @param {object} opts
   * @param {string} opts.search   Text to match against question_text or url.
   * @param {number} opts.limit
   * @param {number} opts.offset
   * @returns {Promise<object[]>}
   */
  async getRecords({ search = "", limit = 50, offset = 0 } = {}) {
    const db = await this.getDb();
    let sql = `SELECT * FROM history`;
    const params = {};

    if (search) {
      sql += ` WHERE question_text LIKE :search OR url LIKE :search`;
      params.search = `%${search}%`;
    }
    sql += ` ORDER BY ts DESC LIMIT :limit OFFSET :offset`;
    params.limit = limit;
    params.offset = offset;

    const rows = await db.execute(sql, params);
    return rows.map(r => ({
      id: r.getResultByName("id"),
      requestId: r.getResultByName("request_id"),
      ts: r.getResultByName("ts"),
      origin: r.getResultByName("origin"),
      url: r.getResultByName("url"),
      pageTitle: r.getResultByName("page_title"),
      questionType: r.getResultByName("question_type"),
      questionText: r.getResultByName("question_text"),
      options: JSON.parse(r.getResultByName("options_json") || "[]"),
      provider: r.getResultByName("provider"),
      promptPayload: r.getResultByName("prompt_payload"),
      aiResponse: r.getResultByName("ai_response"),
      parsedAnswer: JSON.parse(r.getResultByName("parsed_answer") || "{}"),
      fillAttempted: !!r.getResultByName("fill_attempted"),
      fillResult: r.getResultByName("fill_result"),
      latencyMs: r.getResultByName("latency_ms"),
      confidence: r.getResultByName("confidence"),
      errorDetail: r.getResultByName("error_detail"),
    }));
  },

  /**
   * Delete a single record by id.
   *
   * @param {number} id
   */
  async deleteRecord(id) {
    const db = await this.getDb();
    await db.execute(`DELETE FROM history WHERE id = :id`, { id });
  },

  /** Delete all records. */
  async clearAll() {
    const db = await this.getDb();
    await db.execute(`DELETE FROM history`);
  },

  /** Export all records as a JSON string. */
  async exportJson() {
    const records = await this.getRecords({ limit: 10000 });
    return JSON.stringify(records, null, 2);
  },

  async close() {
    if (this._db) {
      await this._db.close();
      this._db = null;
    }
  },
};
