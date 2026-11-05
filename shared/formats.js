/**
 * op-scribe - the exit for the readers' formats (ADR 0005): bug tickets and the session record,
 * and the recording as a Playwright test (Issue #2).
 *
 * Built only from a payload that passes checkPayload, and each whole text goes
 * through finalScan with the keywords as they are now and the real hosts behind
 * the aliases (AGENTS.md: every exit runs both). A text with a finding is not
 * returned, only the finding: the side panel copies or saves only what comes back.
 *
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const S = root.OpScribeSanitize || require('./sanitize.js');
  const D = root.OpScribeDescribe || require('./describe.js');
  const P = root.OpScribePayload || require('./payload.js');
  const PW = root.OpScribePlaywright || require('./playwright.js');

  /**
   * payload: what buildPayload made. scan: { keywords, hosts } for finalScan.
   * Returns { problems } when the payload fails the check, else
   * { tickets: [{ ref, text, findings }], session: { text, findings } | null, playwright: { text, findings } },
   * where text is null whenever findings is not empty. A session is null while
   * the recording has not ended.
   */
  function checkedFormats(payload, scan) {
    const problems = P.checkPayload(payload);
    if (problems.length) return { problems };
    // scanned: what to scan when it is more than the text (the Playwright test's literals, unescaped).
    const guard = (text, scanned = text) => {
      const findings = S.finalScan(scanned, scan);
      return { text: findings.length ? null : text, findings };
    };
    // The whole file, and the steps it was made from: in the file a literal escapes the page's text (a doubled
    // backslash), which can hide a keyword from a scan of the file alone (review of #80).
    const guardPlaywright = (recording) => {
      const file = PW.toPlaywright(recording);
      return guard(file, { file, id: recording.id, steps: recording.steps });
    };
    const tickets = D.bugTickets(payload.recording).map(({ ref, text }) => ({ ref, ...guard(text) }));
    const session = D.sessionRecord(payload.recording);
    return { tickets, session: session === null ? null : guard(session), playwright: guardPlaywright(payload.recording) };
  }

  const api = { checkedFormats };
  root.OpScribeFormats = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
