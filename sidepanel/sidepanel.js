/**
 * op-scribe - Side Panel.
 *
 * Side panel clicks do not grant activeTab, so site access is requested as an
 * optional host permission. chrome.permissions.request() must be the first
 * call in the click handler (no await before it), which is why the active
 * tab and the settings are cached here instead of being read on click.
 */
import { availability, rewrite, validate, MAX_AI_STEPS } from './ai.js';

const S = globalThis.OpScribeSanitize;
const { LIMITS, TOTALS } = globalThis.OpScribeLimits;
const D = globalThis.OpScribeDescribe;
const P = globalThis.OpScribePayload;
const F = globalThis.OpScribeFormats;

const REC_KEY = 'opsRecording';
const SETTINGS_KEY = 'opsSettings';
const DRAFT_KEY = 'opsDraft';

const el = (id) => document.getElementById(id);
const ui = {
  tabStatus: el('tab-status'),
  recState: el('rec-state'),
  start: el('rec-start'),
  stop: el('rec-stop'),
  scope: el('scope'),
  targetVersion: el('target-version'),
  notTested: el('not-tested'),
  recMeta: el('rec-meta'),
  clear: el('rec-clear'),
  originGate: el('origin-gate'),
  addOrigin: el('add-origin'),
  stepCount: el('step-count'),
  steps: el('steps'),
  noteForm: el('note-form'),
  noteInput: el('note-input'),
  noteKind: el('note-kind'),
  redactions: el('redactions'),
  aiState: el('ai-state'),
  genAi: el('gen-ai'),
  genTemplate: el('gen-template'),
  genStatus: el('gen-status'),
  repro: el('repro'),
  gherkin: el('gherkin'),
  preview: el('preview'),
  copyMd: el('copy-md'),
  ticketRef: el('ticket-ref'),
  copyTicket: el('copy-ticket'),
  saveTicket: el('save-ticket'),
  copySession: el('copy-session'),
  saveSession: el('save-session'),
  formatHint: el('format-hint'),
  copyGherkin: el('copy-gherkin'),
  download: el('download'),
  outputStatus: el('output-status'),
  settingsForm: el('settings-form'),
  settingsStatus: el('settings-status'),
  dialog: el('preview-dialog'),
  findings: el('findings'),
  payload: el('payload'),
  sendTarget: el('send-target'),
  send: el('send'),
  sendStatus: el('send-status')
};

/** Cached so permission requests can run synchronously inside a click. */
let settings = S.defaults();
let activeTab = null;
let recording = null;
/** Who produced the Markdown currently in the textarea (it may have been edited since). */
let generator = 'none';
/**
 * The recording revision the Markdown was generated (or first hand-written)
 * from. When the steps change after that - a step deleted, more recorded - the
 * Markdown may still hold what was deleted, so no exit takes it until it is
 * generated again or cleared (#16, ADR 0003 row E4).
 */
let basis = null;
/** The exact JSON string shown in the preview; this is what gets sent. */
let previewed = null;
let previewedBasis = null;
/** What the previewed payload was built from (reproduction, environment, sentAt): sending builds it again to compare. */
let previewedInputs = null;
/** Where the previewed body goes, as shown in the preview: sending uses exactly this. */
let previewedTarget = null;

const STALE = '記録が変わったため（ステップの削除・追加）、この再現手順は出力できません。作り直すか、手順の欄を空にしてください';
/**
 * The recording and revision something was made from. The recording id matters: another
 * window's panel can start a new recording, whose revisions count from 0 again.
 */
const basisOf = (rec) => (rec ? `${rec.id}@${rec.revision ?? 0}` : null);
const isStale = (rec) => Boolean(ui.repro.value.trim()) && basis !== basisOf(rec);

const KIND_LABELS = {
  text: '自由入力', secret: '秘匿値', email: 'メール', phone: '電話', card: 'カード', personal: '個人情報',
  keyword: '指定語', postal: '郵便番号', id: 'ID', ip: 'IP', number: '番号', query: 'クエリ値',
  hash: 'フラグメント', user: 'ユーザー名', host: 'ホスト', v: '値', url: 'URL', masked: '伏せ字',
  nested: '入れ子の値', value: '値', file: 'ファイル'
};

// ------------------------------------------------------------------ helpers

const send = (type, detail) => chrome.runtime.sendMessage({ from: 'op-scribe/panel', type, detail });

function pagePattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

function endpointPattern(value) {
  try {
    const u = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return `${u.protocol}//${u.hostname}/*`;
  } catch { /* fall through */ }
  return null;
}

const lines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);

// Every real host that was aliased (row K5): the final scan must not find them, whatever their length.
const scanWith = (rec) => (value) => S.finalScan(value, { keywords: settings.keywords, hosts: S.aliasedHosts(rec?.aliases) });

/**
 * Every exit runs both checks on the exact payload (ADR 0003, rows E1-E6):
 * the structural check, which does not share any judgment with the masking,
 * and the best-effort pattern scan.
 */
function exitFindings(rec, payload) {
  const shape = P.checkPayload(payload).map((p) => ({ path: p.path, kinds: [`形: ${p.problem}`] }));
  return [...shape, ...scanWith(rec)(payload)];
}

function describeFindings(findings) {
  return findings.slice(0, 8).map((f) => `${f.path}: ${f.kinds.map((k) => KIND_LABELS[k] || k).join(', ')}`);
}

/** The browser as the payload carries it: each field masked and then cut, never cut first (M3). */
function environment() {
  const brands = navigator.userAgentData?.brands || [];
  const brand = brands.find((b) => /Chrome|Chromium/.test(b.brand));
  const raw = {
    browser: brand ? `${brand.brand} ${brand.version}` : 'unknown',
    platform: navigator.userAgentData?.platform || '',
    language: navigator.language || ''
  };
  const clean = (v) => S.cleanLine(v, { keywords: settings.keywords, maxLength: LIMITS.environment }).runs;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]));
}

// ------------------------------------------------------------------- render

async function loadSettings() {
  settings = { ...S.defaults(), ...((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {}) };
  return settings;
}

async function loadRecording() {
  recording = (await chrome.storage.session.get(REC_KEY))[REC_KEY] || null;
  return recording;
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
  } catch {
    activeTab = null;
  }
}

// Why the last START or STOP failed; a plain status line would be rewritten by the next render.
let startError = '';
let stopError = '';

function renderStatus() {
  const url = activeTab?.url || '';
  if (!pagePattern(url)) {
    ui.tabStatus.textContent = 'このタブは記録できません（http / https のページのみ）';
    return;
  }
  const live = recording?.state === 'recording';
  // The tabs the recording records, and those opened from them that wait to be added here (#40, #72).
  const isRecTab = live && (recording.tabIds || [recording.tabId]).includes(activeTab.id);
  const waits = live && (recording.waitingTabIds || []).includes(activeTab.id);
  ui.tabStatus.textContent = isRecTab ? `記録中: ${new URL(url).host}` : new URL(url).host;
  if (waits) ui.tabStatus.textContent = `記録中のタブから開いたタブです。記録に加えるには、下の「このタブも記録する」を押してください: ${new URL(url).host}`;
  if (isRecTab && activeTab.id === recording.tabId && !recording.attached) ui.tabStatus.textContent = 'このページの記録を確認しています。表示が続くときは、サイトの追加かページの再読み込みをお試しください';
  if (startError) ui.tabStatus.textContent = startError;
  if (stopError) ui.tabStatus.textContent = stopError;
}

/** The tester's expectation (ADR 0005): a note without a kind, written in this panel, with its ref. */
const isExpectation = (step) => step.type === 'note' && !step.kind && step.source === 'user' && typeof step.ref === 'string';

const VERDICT_LABELS = { ok: 'OK', ng: 'NG', '': '未判定' };
const VERDICT_REASONS = {
  OTHER_RECORDING: '別の記録に変わったため保存しませんでした',
  NO_REF: 'この期待結果は記録から消えています',
  NO_ACTUAL: 'NG には実際の結果が必要です',
  BAD_VERDICT: '判定を読み取れませんでした'
};
/**
 * What the tester changed in a verdict form and has not saved, by recording and ref: the list is
 * drawn again whenever a step arrives, and only a change of theirs is carried over. A form with
 * no change shows what the worker kept, so a verdict saved in another panel is what is seen.
 * The recording id is in the key, a ref may come back in another recording (ADR 0005); neither
 * has a space in it.
 */
const verdictDrafts = new Map();
const draftKey = (rec, step) => `${rec.id} ${step.ref}`;

/**
 * The verdict of one expectation (ADR 0005): not judged, OK or NG, and for an NG the actual
 * result. Saved by the recording id and the ref only; the panel shows what the worker kept,
 * not what it sent. The saved actual result is shown, never put back into the field: its masked
 * parts would go back as plain text. A new one replaces it; none keeps it.
 */
function verdictForm(rec, step) {
  const key = draftKey(rec, step);
  const saved = step.verdict || '';
  const draft = verdictDrafts.get(key);
  const form = document.createElement('form');
  form.className = 'verdict';
  form.dataset.ref = step.ref;
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = `判定（${step.ref}）: ${VERDICT_LABELS[saved]}`;
  fieldset.append(legend);
  for (const value of ['', 'ok', 'ng']) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'verdict';
    radio.value = value;
    radio.checked = (draft ? draft.verdict : saved) === value;
    label.append(radio, ` ${VERDICT_LABELS[value]}`);
    fieldset.append(label);
  }
  const actualLabel = document.createElement('label');
  actualLabel.className = 'field';
  const caption = document.createElement('span');
  const actual = document.createElement('input');
  actual.type = 'text';
  actual.name = 'actual';
  actual.maxLength = LIMITS.actual;
  actual.value = draft?.actualEdited ? draft.actual : '';
  actualLabel.append(caption, actual);
  if (saved === 'ng' && step.actual) {
    const kept = document.createElement('small');
    kept.textContent = `保存済み: ${D.humanize(S.renderRuns(step.actual))}`;
    actualLabel.append(kept);
    caption.textContent = '実際の結果（書くと保存済みの文を置き換える）';
  } else {
    caption.textContent = '実際の結果（NG のとき必須）';
  }
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'secondary';
  save.textContent = '判定を保存';
  const status = document.createElement('p');
  status.className = 'hint';
  status.id = `verdict-status-${step.ref}`;
  status.setAttribute('role', 'status');
  form.setAttribute('aria-describedby', status.id);
  fieldset.append(actualLabel, save);
  form.append(fieldset, status);

  const choice = () => form.querySelector('[name="verdict"]:checked')?.value ?? '';
  const edited = () => Boolean(verdictDrafts.get(key)?.actualEdited);
  // An actual result is needed for an NG chosen now, or one whose text was changed; a saved NG keeps its own.
  const needsActual = () => choice() === 'ng' && (saved !== 'ng' || edited());
  const show = () => {
    const ng = choice() === 'ng';
    // Hidden and disabled unless NG, so a check it failed as an NG never holds back an OK.
    actualLabel.hidden = !ng;
    actual.disabled = !ng;
    actual.required = needsActual();
    if (!actual.required) actual.setCustomValidity('');
  };
  show();
  // Only what the tester does becomes a draft; drawing the form never does.
  const remember = (actualEdited) => {
    verdictDrafts.set(key, { verdict: choice(), actual: actual.value, actualEdited });
    show();
  };
  form.addEventListener('change', (event) => { if (event.target.name === 'verdict') remember(edited()); });
  actual.addEventListener('input', () => {
    actual.setCustomValidity('');
    remember(true);
  });
  actual.addEventListener('invalid', () => actual.setCustomValidity(VERDICT_REASONS.NO_ACTUAL));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const verdict = choice();
    if (needsActual() && !actual.value.trim()) {
      actual.value = '';
      actual.reportValidity();
      return;
    }
    // Nothing changed: the same verdict, and for a saved NG no new actual result.
    if (verdict === saved && !(verdict === 'ng' && edited())) {
      verdictDrafts.delete(key);
      status.textContent = '変更はありません';
      return;
    }
    save.disabled = true;
    // What is sent: a change made while the reply is awaited is a draft of its own and stays.
    const sent = JSON.stringify(verdictDrafts.get(key));
    const replace = verdict === 'ng' && edited();
    const reply = await send('SET_VERDICT', {
      recordingId: rec.id, ref: step.ref, verdict: verdict || null, ...(replace && { actual: actual.value })
    });
    save.disabled = false;
    if (reply?.ok && JSON.stringify(verdictDrafts.get(key)) === sent) verdictDrafts.delete(key);
    // What the worker kept is drawn from the recording read again, whatever the reply.
    await refresh();
    if (!reply?.ok) {
      const shown = [...ui.steps.querySelectorAll('.verdict')].find((f) => f.dataset.ref === step.ref);
      const line = shown?.querySelector('[role="status"]') || ui.outputStatus;
      line.textContent = VERDICT_REASONS[reply?.reason] || `保存できませんでした (${reply?.reason || reply?.error || 'unknown'})`;
    }
  });
  return form;
}

/**
 * The recording the panel showed last. What is written for a recording (what was not tested) is
 * for that recording only: when another one is shown - discarded, a new start, another panel's
 * stop and start - the field is emptied, whichever way it changed (ADR 0005).
 */
let shownRecordingId;

function render() {
  const rec = recording;
  if ((rec?.id ?? null) !== shownRecordingId) {
    shownRecordingId = rec?.id ?? null;
    ui.notTested.value = '';
    stopError = '';
  }
  const isRecording = rec?.state === 'recording';
  ui.recState.textContent = isRecording ? '記録中' : rec ? '停止（記録あり）' : '停止中';
  ui.recState.classList.toggle('live', isRecording);
  ui.start.disabled = isRecording || !pagePattern(activeTab?.url);
  ui.stop.disabled = !isRecording;
  ui.clear.disabled = !rec;
  // Written at the start and at the stop (ADR 0005): each field only when it can still be sent.
  ui.scope.disabled = isRecording;
  ui.targetVersion.disabled = isRecording;
  ui.notTested.disabled = !isRecording;
  const meta = [['対象と範囲', rec?.scope], ['対象のバージョン', rec?.targetVersion], ['やっていないこと', rec?.notTested]]
    .filter(([, runs]) => runs).map(([label, runs]) => `${label}: ${D.humanize(S.renderRuns(runs))}`);
  ui.recMeta.textContent = meta.join(' / ');

  const pattern = pagePattern(activeTab?.url);
  const ofRecording = isRecording && [...(rec.tabIds || [rec.tabId]), ...(rec.waitingTabIds || [])].includes(activeTab?.id);
  // A waiting tab joins only from here, even on a site the recording already has (#72).
  const waits = isRecording && (rec.waitingTabIds || []).includes(activeTab?.id);
  ui.originGate.hidden = !(ofRecording && pattern && (waits || !rec.grantedPatterns.includes(pattern)));
  ui.addOrigin.textContent = waits ? 'このタブも記録する' : 'このサイトも記録する';

  const steps = rec?.steps || [];
  ui.stepCount.textContent = String(steps.length);
  // The list is drawn again whenever a step arrives: a verdict being written keeps its focus.
  const focused = document.activeElement?.closest?.('.verdict') ? document.activeElement : null;
  const refocus = focused && { ref: focused.closest('.verdict').dataset.ref, name: focused.name, value: focused.value, at: focused.selectionStart };
  ui.steps.replaceChildren();
  steps.forEach((step, index) => {
    const li = document.createElement('li');
    li.className = `step ${step.type}`;
    const text = document.createElement('span');
    text.textContent = D.humanize(D.describeStep(step));
    if (step.source === 'agent') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'agent';
      li.append(tag);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon';
    remove.title = 'この操作を削除';
    remove.textContent = '×';
    // The recording as shown: a second click before the list is drawn again removes nothing.
    remove.addEventListener('click', () => send('DELETE_STEP', { index, basis: basisOf(rec) }));
    li.append(text, remove);
    if (isExpectation(step)) li.append(verdictForm(rec, step));
    ui.steps.append(li);
  });
  if (refocus) {
    const form = [...ui.steps.querySelectorAll('.verdict')].find((f) => f.dataset.ref === refocus.ref);
    const field = refocus.name && form?.querySelector(refocus.name === 'actual' ? '[name="actual"]' : `[name="${refocus.name}"][value="${refocus.value}"]`);
    if (field) {
      field.focus();
      if (refocus.name === 'actual' && refocus.at !== null) field.setSelectionRange(refocus.at, refocus.at);
    }
  }

  renderFormats(rec);
  ui.gherkin.value = rec ? D.toGherkin(rec) : '';
  if (isStale(rec)) ui.genStatus.textContent = STALE;

  const redactions = Object.entries(rec?.redactions || {});
  ui.redactions.textContent = redactions.length
    ? `伏せた箇所: ${redactions.map(([k, n]) => `${KIND_LABELS[k] || k} ${n}`).join(' / ')}`
    : '';
  renderStatus();
}

async function refresh() {
  await Promise.all([refreshActiveTab(), loadRecording()]);
  render();
}

// --------------------------------------------------------------- recording

ui.start.addEventListener('click', () => {
  const tab = activeTab;
  const pattern = pagePattern(tab?.url);
  if (!pattern) return;
  // First statement of the gesture: nothing may be awaited before this.
  const granted = chrome.permissions.request({ origins: [pattern] });
  (async () => {
    if (!(await granted)) {
      ui.tabStatus.textContent = 'サイトへのアクセスが許可されなかったため記録を開始できません';
      return;
    }
    const result = await send('START', { tabId: tab.id, url: tab.url, scope: ui.scope.value, targetVersion: ui.targetVersion.value });
    startError = result?.ok ? '' : `記録を開始できません (${result?.error || 'unknown'})`;
    if (result?.ok) {
      ui.scope.value = '';
      ui.targetVersion.value = '';
      verdictDrafts.clear();
    }
    ui.repro.value = '';
    generator = 'none';
    basis = null;
    await chrome.storage.session.remove(DRAFT_KEY);
    await refresh();
  })();
});

ui.addOrigin.addEventListener('click', () => {
  const tab = activeTab;
  const pattern = pagePattern(tab?.url);
  if (!pattern) return;
  const granted = chrome.permissions.request({ origins: [pattern] });
  (async () => {
    if (await granted) await send('ADD_ORIGIN', { url: tab.url, tabId: tab.id });
    await refresh();
  })();
});

ui.stop.addEventListener('click', async () => {
  // The recording this panel shows, with what was not tested (ADR 0005).
  const reply = await send('STOP', { recordingId: recording?.id, notTested: ui.notTested.value });
  const STOP_REASONS = {
    OTHER_RECORDING: '別の記録に変わったため停止しませんでした',
    ALREADY_STOPPED: 'すでに停止していたため、やっていないことは保存しませんでした'
  };
  stopError = reply?.ok ? '' : STOP_REASONS[reply?.reason] || `停止できませんでした (${reply?.reason || reply?.error || 'unknown'})`;
  if (reply?.ok) ui.notTested.value = '';
  await refresh();
});

ui.clear.addEventListener('click', async () => {
  if (!confirm('記録を破棄します。元に戻せません。')) return;
  await send('CLEAR');
  verdictDrafts.clear();
  ui.repro.value = '';
  basis = null;
  generator = 'none';
  await chrome.storage.session.remove(DRAFT_KEY);
  await refresh();
});

ui.noteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ui.noteInput.value.trim();
  if (!text) return;
  const result = await send('ADD_NOTE', { text, kind: ui.noteKind.value || undefined });
  if (result?.ok) ui.noteInput.value = '';
});

// ------------------------------------------------------------ reproduction

/** The draft is kept only within its share of the session storage (draftBytes; review R43). */
async function saveDraft() {
  const draft = { markdown: ui.repro.value, generator, basis };
  if (new TextEncoder().encode(JSON.stringify(draft)).length > LIMITS.draftBytes) {
    await chrome.storage.session.remove(DRAFT_KEY);
    ui.genStatus.textContent = '再現手順が大きすぎるため、パネルを閉じると残りません';
    return;
  }
  await chrome.storage.session.set({ [DRAFT_KEY]: draft });
}

/** Markdown may come from the model; Gherkin is always rebuilt from the recording (render). */
async function setRepro(rec, markdown, by) {
  ui.repro.value = markdown;
  generator = by;
  basis = basisOf(rec);
  await saveDraft();
}

async function generateTemplate(reason = '') {
  const rec = await loadRecording();
  if (!rec?.steps?.length) {
    ui.genStatus.textContent = 'まだ操作が記録されていません';
    return;
  }
  await setRepro(rec, D.toMarkdown(D.buildReproduction(rec)), 'template');
  ui.genStatus.textContent = reason ? `テンプレートで生成しました（${reason}）` : 'テンプレートで生成しました';
}

async function generateAi() {
  const rec = await loadRecording();
  if (!rec?.steps?.length) {
    ui.genStatus.textContent = 'まだ操作が記録されていません';
    return;
  }
  const base = D.buildReproduction(rec);
  if (base.steps.length > MAX_AI_STEPS) {
    await generateTemplate(`${MAX_AI_STEPS} ステップを超えるため AI は使いません`);
    return;
  }
  ui.genAi.disabled = true;
  try {
    const input = base.steps.map((s) => (s.expected ? `${s.action}（確認）${s.expected}` : s.action));
    const start = D.rendered(D.startUrlOf(rec));
    // The model reads what the Markdown shows: ‹…› labels, never [[…]] (#28).
    const { output, input: prompt } = await rewrite(input, start === '[[url:none]]' ? '' : D.humanize(start), (text) => { ui.genStatus.textContent = text; });
    const problems = validate(output, prompt, scanWith(rec));
    if (problems.length) {
      await generateTemplate(`AI の出力を採用しませんでした: ${problems[0]}`);
      return;
    }
    const merged = {
      title: output.title,
      preconditions: [...new Set([...base.preconditions, ...(output.preconditions || [])])],
      steps: output.steps.map((s) => ({ action: s.action, expected: s.expected || undefined })),
      notes: [...new Set([...(output.notes || []), ...base.notes])],
      // The AI may merge steps, so a step number would no longer point at the right one.
      findings: base.findings.map(({ kind, note }) => ({ kind, note }))
    };
    await setRepro(rec, D.toMarkdown(merged), 'on-device-ai');
    ui.genStatus.textContent = 'オンデバイス AI で整理しました。内容を確認してください。';
  } catch (error) {
    await generateTemplate(`AI を使えません: ${error.message}`);
  } finally {
    ui.genAi.disabled = false;
  }
}

ui.genAi.addEventListener('click', generateAi);
ui.genTemplate.addEventListener('click', () => generateTemplate());
// The same bound the payload check applies to the Markdown (shared/limits.js).
ui.repro.maxLength = TOTALS.markdown;
ui.repro.addEventListener('input', () => {
  // Hand-written from scratch: it describes the recording as it is now.
  if (basis === null) basis = basisOf(recording);
  if (!ui.repro.value.trim()) basis = null;
  saveDraft();
});

// ------------------------------------------------------------------ output

/** Builds the payload and runs the final gate. Every exit (send, copy, save) goes through here. */
async function preparePayload() {
  // Keywords added in another window's panel apply now (row K2): read the settings at every exit.
  await loadSettings();
  const rec = await loadRecording();
  if (!rec) return { error: '記録がありません' };
  if (isStale(rec)) return { error: STALE };
  const reproduction = {
    generator: ui.repro.value.trim() ? (generator === 'none' ? 'manual' : generator) : 'none',
    markdown: ui.repro.value
  };
  // The Gherkin in the payload is rebuilt from the recording here, never taken from the panel.
  const env = environment();
  const payload = P.buildPayload(rec, reproduction, env);
  return { rec, payload, findings: exitFindings(rec, payload), inputs: { reproduction, environment: env, sentAt: payload.sentAt } };
}

function blockedMessage(findings) {
  return `伏せ忘れの疑いがあるため中止しました: ${describeFindings(findings).join(' / ')}`;
}

ui.preview.addEventListener('click', async () => {
  const prepared = await preparePayload();
  if (prepared.error) {
    ui.outputStatus.textContent = prepared.error;
    return;
  }
  previewed = JSON.stringify(prepared.payload, null, 2);
  previewedBasis = basisOf(prepared.rec);
  previewedInputs = prepared.inputs;
  ui.payload.textContent = previewed;
  ui.findings.replaceChildren();
  for (const line of describeFindings(prepared.findings)) {
    const p = document.createElement('p');
    p.className = 'bad';
    p.textContent = line;
    ui.findings.append(p);
  }
  if (prepared.findings.length) {
    const p = document.createElement('p');
    p.textContent = '該当箇所を操作ログから削除するか、再現手順を編集してからもう一度プレビューしてください。';
    ui.findings.append(p);
  }
  const target = endpointPattern(settings.endpoint);
  previewedTarget = { endpoint: settings.endpoint, authHeader: settings.authHeader };
  ui.sendTarget.textContent = target
    ? `送信先: ${settings.endpoint}${settings.authHeader ? '（Authorization ヘッダ付き。ヘッダはプレビューに含みません）' : ''}`
    : '送信先が未設定です（「プライバシーと送信先」で設定）';
  ui.send.disabled = Boolean(prepared.findings.length) || !target;
  ui.sendStatus.textContent = '';
  ui.dialog.showModal();
});

ui.send.addEventListener('click', () => {
  const target = previewedTarget;
  const pattern = target && endpointPattern(target.endpoint);
  if (!pattern || !previewed) return;
  const granted = chrome.permissions.request({ origins: [pattern] });
  const body = previewed;
  const inputs = previewedInputs;
  (async () => {
    ui.send.disabled = true;
    try {
      if (!(await granted)) {
        ui.sendStatus.textContent = '送信先へのアクセスが許可されませんでした';
        return;
      }
      // Re-check the exact bytes about to leave, not a rebuilt object. The settings first: from
      // reading the recording to starting the request nothing waits, so a verdict or a stop saved
      // meanwhile is either in what is compared or comes after the send began (ADR 0005). What is
      // saved between that read and the request itself is not seen: a known limit, short of
      // sending from the worker's queue.
      await loadSettings();
      const rec = await loadRecording();
      // A verdict, the stop or a tool list changes the payload but not the revision (ADR 0005):
      // the recording as it is now, built from what was previewed, must be the previewed text.
      if (basisOf(rec) !== previewedBasis || !inputs
        || JSON.stringify(P.buildPayload(rec, inputs.reproduction, inputs.environment, inputs.sentAt), null, 2) !== body) {
        ui.sendStatus.textContent = 'プレビューの後に記録が変わりました。もう一度プレビューしてください';
        return;
      }
      // The destination shown in the preview, or nothing: settings changed in another window are not used silently.
      if (settings.endpoint !== target.endpoint || settings.authHeader !== target.authHeader) {
        ui.sendStatus.textContent = 'プレビューの後に送信先の設定が変わりました。もう一度プレビューしてください';
        return;
      }
      const findings = exitFindings(rec, JSON.parse(body));
      if (findings.length) {
        ui.sendStatus.textContent = blockedMessage(findings);
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (target.authHeader) headers.Authorization = target.authHeader;
      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers,
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(15000)
      });
      ui.sendStatus.textContent = response.ok
        ? `送信しました (HTTP ${response.status})`
        : `送信先がエラーを返しました (HTTP ${response.status})`;
    } catch (error) {
      ui.sendStatus.textContent = `送信できませんでした: ${error.message}`;
    } finally {
      ui.send.disabled = false;
    }
  })();
});

/** Copies one rendering of the payload, after the same checks as sending it. */
async function copyFromPayload(label, pick) {
  const prepared = await preparePayload();
  if (prepared.error) {
    ui.outputStatus.textContent = prepared.error;
    return;
  }
  const text = pick(prepared.payload);
  if (!text.trim()) {
    ui.outputStatus.textContent = '再現手順がまだありません（「再現手順」で生成してください）';
    return;
  }
  if (prepared.findings.length) {
    ui.outputStatus.textContent = blockedMessage(prepared.findings);
    return;
  }
  await navigator.clipboard.writeText(text);
  ui.outputStatus.textContent = `${label} をコピーしました`;
}

ui.copyMd.addEventListener('click', () => copyFromPayload('Markdown', (p) => p.reproduction.markdown));

// ------------------------------------------------------------ the readers' formats (ADR 0005)

/** The NG expectations to make a ticket of, and whether a session record can be made yet. */
function renderFormats(rec) {
  const ngs = (rec?.steps || []).filter((s) => isExpectation(s) && s.verdict === 'ng');
  const chosen = ui.ticketRef.value;
  ui.ticketRef.replaceChildren(...ngs.map((s) => {
    const option = document.createElement('option');
    option.value = s.ref;
    option.textContent = `${s.ref} ${D.humanize(S.renderRuns(s.note))}`;
    return option;
  }));
  if (ngs.some((s) => s.ref === chosen)) ui.ticketRef.value = chosen;
  const noTicket = !ngs.length;
  ui.ticketRef.disabled = noTicket;
  ui.copyTicket.disabled = noTicket;
  ui.saveTicket.disabled = noTicket;
  const noSession = !rec?.endedAt;
  ui.copySession.disabled = noSession;
  ui.saveSession.disabled = noSession;
  ui.formatHint.textContent = [
    noTicket ? 'バグチケットは、期待結果を NG にすると作れます。' : '',
    noSession ? '実施記録は、記録を止めると作れます。' : ''
  ].filter(Boolean).join(' ');
}

/**
 * One format, made now from the recording through the exit (shared/formats.js): the checked
 * payload, then the whole text scanned with the keywords as they are now. Never the hand-edited
 * Markdown, so a stale draft does not stop it. Returns { rec, text } or { error }.
 */
async function formatNow(which) {
  await loadSettings();
  const rec = await loadRecording();
  if (!rec) return { error: '記録がありません' };
  const payload = P.buildPayload(rec, { generator: 'none', markdown: '' }, environment());
  const made = F.checkedFormats(payload, { keywords: settings.keywords, hosts: S.aliasedHosts(rec.aliases) });
  if (made.problems) return { error: blockedMessage(made.problems.map((p) => ({ path: p.path, kinds: [`形: ${p.problem}`] }))) };
  const out = which === 'session' ? made.session : made.tickets.find((t) => t.ref === ui.ticketRef.value);
  if (!out) return { error: which === 'session' ? '実施記録は、記録を止めてから作れます' : 'この NG の期待結果は記録にありません' };
  if (out.findings.length) return { error: blockedMessage(out.findings) };
  return { rec, text: out.text, name: which === 'session' ? `${rec.id}-session.md` : `${rec.id}-${out.ref}.md` };
}

async function copyFormat(which, label) {
  const made = await formatNow(which);
  if (made.error) {
    ui.outputStatus.textContent = made.error;
    return;
  }
  await navigator.clipboard.writeText(made.text);
  ui.outputStatus.textContent = `${label}をコピーしました`;
}

async function saveFormat(which) {
  const made = await formatNow(which);
  if (made.error) {
    ui.outputStatus.textContent = made.error;
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([made.text], { type: 'text/markdown' }));
  link.download = made.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  ui.outputStatus.textContent = `${link.download} を保存しました`;
}

ui.copyTicket.addEventListener('click', () => copyFormat('ticket', 'バグチケット'));
ui.saveTicket.addEventListener('click', () => saveFormat('ticket'));
ui.copySession.addEventListener('click', () => copyFormat('session', '実施記録'));
ui.saveSession.addEventListener('click', () => saveFormat('session'));
ui.copyGherkin.addEventListener('click', () => copyFromPayload('Gherkin', (p) => p.reproduction.gherkin));

ui.download.addEventListener('click', async () => {
  const prepared = await preparePayload();
  if (prepared.error) {
    ui.outputStatus.textContent = prepared.error;
    return;
  }
  if (prepared.findings.length) {
    ui.outputStatus.textContent = blockedMessage(prepared.findings);
    return;
  }
  const blob = new Blob([JSON.stringify(prepared.payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${prepared.rec.id}.opscribe.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  ui.outputStatus.textContent = `${link.download} を保存しました`;
});

// ---------------------------------------------------------------- settings

function fillSettingsForm() {
  const form = ui.settingsForm.elements;
  form.commercialHosts.value = settings.commercialHosts.join('\n');
  form.hostAllowlist.value = settings.hostAllowlist.join('\n');
  form.keywords.value = settings.keywords.join('\n');
  form.endpoint.value = settings.endpoint;
  form.authHeader.value = settings.authHeader;
}

ui.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = ui.settingsForm.elements;
  const endpoint = form.endpoint.value.trim();
  const pattern = endpoint ? endpointPattern(endpoint) : null;
  if (endpoint && !pattern) {
    ui.settingsStatus.textContent = '送信先は https、または手元の http://localhost・http://127.0.0.1・http://[::1] のみ指定できます';
    return;
  }
  // Ask for the endpoint now, while we still hold the click.
  const granted = pattern ? chrome.permissions.request({ origins: [pattern] }) : Promise.resolve(true);
  const tooMany = [form.commercialHosts, form.hostAllowlist].some((f) => lines(f.value).length > LIMITS.hosts
    || lines(f.value).some((h) => [...h].length > LIMITS.host));
  if (tooMany) {
    ui.settingsStatus.textContent = `ホストは 1 つの一覧に ${LIMITS.hosts} 件まで、1 件 ${LIMITS.host} 字までです`;
    return;
  }
  const next = {
    commercialHosts: lines(form.commercialHosts.value).map((h) => h.toLowerCase()),
    hostAllowlist: lines(form.hostAllowlist.value).map((h) => h.toLowerCase()),
    keywords: [...new Set(lines(form.keywords.value))],
    endpoint,
    authHeader: form.authHeader.value.trim()
  };
  (async () => {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    settings = { ...S.defaults(), ...next };
    if (next.commercialHosts.length) await dismissNotice();
    const unused = next.keywords.filter((k) => !S.usableKeyword(k));
    ui.settingsStatus.textContent = (await granted)
      ? `保存しました${unused.length ? `（1 文字の語は使いません: ${unused.slice(0, 5).join('、')}）` : ''}`
      : '保存しました（送信先へのアクセスは未許可です）';
  })();
});

// ------------------------------------------------------------------ wiring

chrome.runtime.onMessage.addListener((message) => {
  if (message?.from === 'op-scribe/worker' && message.type === 'REC_CHANGED') refresh();
});
// Settings saved in another window's panel.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) settings = { ...S.defaults(), ...(changes[SETTINGS_KEY].newValue || {}) };
});
chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTab?.id && (changeInfo.url || changeInfo.status === 'complete')) refresh();
});

function reportFatal(label, error) {
  ui.tabStatus.textContent = `${label}: ${error?.message || error}`;
  ui.tabStatus.classList.add('bad');
  console.error('[op-scribe]', label, error);
}
window.addEventListener('error', (event) => reportFatal('script error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => reportFatal('unhandled rejection', event.reason));

(async () => {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    settings = { ...S.defaults(), ...(stored[SETTINGS_KEY] || {}) };
    fillSettingsForm();
    const draft = (await chrome.storage.session.get(DRAFT_KEY))[DRAFT_KEY];
    if (draft) {
      ui.repro.value = draft.markdown || '';
      generator = draft.generator;
      basis = draft.basis ?? null;
    }
    await refresh();
  } catch (error) {
    reportFatal('init failed', error);
  }
  // The panel must work even if the model never answers.
  availability().then((state) => {
    ui.aiState.textContent = state === 'available' ? 'AI 利用可' : `AI: ${state}`;
  });
})();
