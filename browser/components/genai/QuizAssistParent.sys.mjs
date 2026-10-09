/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parent-side JSWindowActor for QuizAssist.
 * Forwards requests to the content process and delivers results back
 * to the QuizAssist singleton running in the parent.
 */
export class QuizAssistParent extends JSWindowActorParent {
  /**
   * Ask the content process to extract the current question.
   *
   * @returns {Promise<object>} Structured question data.
   */
  extractQuestion() {
    return this.sendQuery("QuizAssist:ExtractQuestion", {});
  }

  /**
   * Ask the content process to fill the answer controls.
   *
   * @param {object} answerData  Structured answer from AI.
   * @returns {Promise<{filled: boolean, message: string}>}
   */
  fillAnswer(answerData) {
    return this.sendQuery("QuizAssist:FillAnswer", answerData);
  }
}
