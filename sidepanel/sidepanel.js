/**
 * op-scribe - Side Panel.
 *
 * Side panel clicks do not grant activeTab, so site access is requested as an
 * optional host permission. chrome.permissions.request() must be the first
 * call in the click handler (no await before it), which is why the active
 * tab and the settings are cached here instead of being read on click.
 */
const S = globalThis.OpScribeSanitize;
const D = globalThis.OpScribeDescribe;
const N = globalThis.OpScribeNarrate;

const REC_KEY = 'opsRecording';
const SETTINGS_KEY = 'opsSettings';
const DRAFT_KEY = 'opsDraft';
const NARRATION_KEY = 'opsNarration';

const el = (id) => document.getElementById(id);
const ui = {
  tabStatus: el('tab-status'),
  recState: el('rec-state'),
  start: el('rec-start'),
  stop: el('rec-stop'),
  clear: el('rec-clear'),
  originGate: el('origin-gate'),
  addOrigin: el('add-origin'),
  stepCount: el('step-count'),
  steps: el('steps'),
  noteForm: el('note-form'),
  noteInput: el('note-input'),
  redactions: el('redactions'),
  aiState: el('ai-state'),
  genAi: el('gen-ai'),
  genTemplate: el('gen-template'),
  genStatus: el('gen-status'),
  repro: el('repro'),
  gherkin: el('gherkin'),
  preview: el('preview'),
  copyMd: el('copy-md'),
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
// The user changed the generated text by hand: it is theirs and is never rebuilt over.
let edited = false;
// Edits so far, to tell whether the user typed while the model was writing.
let edits = 0;
// The verbalization's summary, sent with the Markdown it belongs to while that is unedited.
let summary = '';
// The recording (id and revision) the text in the editors was made from, or last confirmed against.
let source = null;
/** The exact JSON string shown in the preview; this is what gets sent. */
let previewed = null;
// The recording (id and revision) the preview was built from: a later change means the preview is stale.
let previewedFrom = null;

const KIND_LABELS = {
  text: '自由入力', secret: '秘匿値', email: 'メール', phone: '電話', card: 'カード', personal: '個人情報',
  keyword: '指定語', postal: '郵便番号', id: 'ID', ip: 'IP', number: '番号', query: 'クエリ値',
  hash: 'フラグメント', user: 'ユーザー名', host: 'ホスト'
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

/** Words the final scan must not find: the user's list plus every real host that was aliased. */
function scanKeywords(rec) {
  const hosts = S.aliasedHosts(rec?.aliases).map(([host]) => host);
  return [...settings.keywords, ...hosts].filter(Boolean);
}

const scanWith = (rec) => (value) => S.finalScan(value, { keywords: scanKeywords(rec) });

function describeFindings(findings) {
  return findings.slice(0, 8).map((f) => `${f.path}: ${f.kinds.map((k) => KIND_LABELS[k] || k).join(', ')}`);
}

function environment() {
  const brands = navigator.userAgentData?.brands || [];
  const brand = brands.find((b) => /Chrome|Chromium/.test(b.brand));
  return {
    browser: brand ? `${brand.brand} ${brand.version}` : 'unknown',
    platform: navigator.userAgentData?.platform || '',
    language: navigator.language
  };
}

// ------------------------------------------------------------------- render

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

function renderStatus() {
  const url = activeTab?.url || '';
  if (!pagePattern(url)) {
    ui.tabStatus.textContent = 'このタブは記録できません（http / https のページのみ）';
    return;
  }
  const isRecTab = recording?.state === 'recording' && recording.tabId === activeTab.id;
  ui.tabStatus.textContent = isRecTab ? `記録中: ${new URL(url).host}` : new URL(url).host;
}

function render() {
  const rec = recording;
  const isRecording = rec?.state === 'recording';
  ui.recState.textContent = isRecording ? '記録中' : rec ? '停止（記録あり）' : '停止中';
  ui.recState.classList.toggle('live', isRecording);
  ui.start.disabled = isRecording || !pagePattern(activeTab?.url);
  ui.stop.disabled = !isRecording;
  ui.clear.disabled = !rec;

  const pattern = pagePattern(activeTab?.url);
  ui.originGate.hidden = !(isRecording && activeTab?.id === rec.tabId && pattern && !rec.grantedPatterns.includes(pattern));

  const steps = rec?.steps || [];
  ui.stepCount.textContent = String(steps.length);
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
    remove.addEventListener('click', async () => {
      if ((await send('DELETE_STEP', { index }))?.ok) await afterDelete();
    });
    li.append(text, remove);
    ui.steps.append(li);
  });

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
    const result = await send('START', { tabId: tab.id, url: tab.url });
    if (!result?.ok) ui.tabStatus.textContent = `記録を開始できません (${result?.error || 'unknown'})`;
    ui.repro.value = '';
    ui.gherkin.value = '';
    generator = 'none';
    edited = false;
    summary = '';
    source = null;
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
    if (await granted) await send('ADD_ORIGIN', { url: tab.url });
    await refresh();
  })();
});

ui.stop.addEventListener('click', async () => {
  await send('STOP');
  await refresh();
});

ui.clear.addEventListener('click', async () => {
  if (!confirm('記録を破棄します。元に戻せません。')) return;
  await send('CLEAR');
  ui.repro.value = '';
  ui.gherkin.value = '';
  generator = 'none';
  edited = false;
  summary = '';
  source = null;
  await chrome.storage.session.remove(DRAFT_KEY);
  await refresh();
});

ui.noteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = ui.noteInput.value.trim();
  if (!text) return;
  const result = await send('ADD_NOTE', { text });
  if (result?.ok) ui.noteInput.value = '';
});

// ------------------------------------------------------------ reproduction

const saveDraft = () => chrome.storage.session.set({
  [DRAFT_KEY]: { markdown: ui.repro.value, gherkin: ui.gherkin.value, generator, edited, summary, source }
});

/** Markdown may come from the model; Gherkin is always rebuilt from the recording. */
async function setRepro(rec, markdown, by, about = '') {
  ui.repro.value = markdown;
  ui.gherkin.value = D.toGherkin(rec);
  generator = by;
  edited = false;
  summary = about;
  source = { recordingId: rec.id, revision: rec.revision };
  await saveDraft();
}

/** The text in the editors may quote a deleted step: rebuild what was generated, flag what the user wrote. */
async function afterDelete() {
  if (!ui.repro.value.trim() && !ui.gherkin.value.trim()) return;
  if (edited) {
    ui.genStatus.textContent = '操作を削除しました。手順の文に削除した操作が残っていないか確認してください';
    return;
  }
  const rec = await loadRecording();
  if (!rec?.steps?.length) {
    ui.repro.value = '';
    ui.gherkin.value = '';
    generator = 'none';
    summary = '';
    await saveDraft();
    return;
  }
  await generateTemplate('操作を削除したため');
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

/**
 * Same path as the automatic verbalization when recording stops: the worker
 * runs the built-in AI, validates it and stores the result on the recording.
 */
/**
 * Chrome downloads the model only when a person asks for it: start the download here, in the click,
 * so that the worker finds the model available. Returns false if it could not be had.
 */
async function ensureModel() {
  const LM = globalThis.LanguageModel;
  const state = await N.availability(LM);
  if (state !== 'downloadable' && state !== 'downloading') return true;
  ui.genStatus.textContent = 'Built-in AI のモデルをダウンロードしています…';
  try {
    const session = await LM.create({
      ...N.LANGUAGES,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          ui.genStatus.textContent = `Built-in AI のモデルをダウンロードしています（${Math.round(e.loaded * 100)}%）`;
        });
      }
    });
    session.destroy();
    return true;
  } catch (error) {
    ui.genStatus.textContent = `Built-in AI のモデルをダウンロードできませんでした（${error?.name || error}）`;
    return false;
  }
}

async function generateAi() {
  const rec = await loadRecording();
  if (!rec?.steps?.length) {
    ui.genStatus.textContent = 'まだ操作が記録されていません';
    return;
  }
  ui.genAi.disabled = true;
  const editsBefore = edits;
  try {
    if (!(await ensureModel())) return;
    const result = await send('NARRATE');
    if (result?.error === 'RECORDING_CHANGED') {
      ui.genStatus.textContent = '言語化の途中で記録が変わったため、結果を使いませんでした。もう一度実行してください';
      return;
    }
    // A newer run (stop's automatic one, or another click) is kept instead; it shows itself when done.
    if (result?.error === 'SUPERSEDED') return;
    // Text typed while the model was writing is the user's: it is not replaced.
    if (edits !== editsBefore) {
      ui.genStatus.textContent = '言語化の間に手順の文が編集されたため、欄は書き換えませんでした。置き換えるには、もう一度押してください';
      return;
    }
    await showNarration(await loadRecording(), true);
  } finally {
    ui.genAi.disabled = false;
  }
}

const GENERATOR_LABELS = { 'built-in-ai': 'Built-in AI で言語化しました。内容を確認してください。', template: 'テンプレートで生成しました' };

/** The verbalization, if it was made from the recording as it is now (not before a step was deleted). */
async function loadNarration(rec) {
  const narration = (await chrome.storage.session.get(NARRATION_KEY))[NARRATION_KEY];
  return narration && rec && narration.recordingId === rec.id && narration.sourceRevision === rec.revision ? narration : null;
}

/** Shows the stored verbalization unless the user already has text of their own in the editor. */
async function showNarration(rec, force = false) {
  const narration = await loadNarration(rec);
  if (!narration) return;
  if (narration.generator === 'pending') {
    ui.genStatus.textContent = 'Built-in AI で言語化しています…';
    return;
  }
  // Hand-edited text (in either field) is never replaced unasked; nor is text already generated.
  if (!force && (edited || (ui.repro.value.trim() && generator !== 'none'))) return;
  await setRepro(rec, narration.markdown, narration.generator, narration.summary);
  ui.genStatus.textContent = narration.reason
    ? `${GENERATOR_LABELS[narration.generator]}（${narration.reason}）`
    : GENERATOR_LABELS[narration.generator] || '';
}

ui.genAi.addEventListener('click', generateAi);
ui.genTemplate.addEventListener('click', () => generateTemplate());
const onEdit = () => {
  edited = true;
  edits += 1;
  return saveDraft();
};
ui.repro.addEventListener('input', onEdit);
ui.gherkin.addEventListener('input', onEdit);

// ------------------------------------------------------------------ output

const STALE_MESSAGE = '手順の文を確認してから、もう一度実行してください';

/** Text made before the recording changed may still quote a deleted step: it leaves only once confirmed. */
async function confirmFresh(rec) {
  const stale = (ui.repro.value.trim() || ui.gherkin.value.trim())
    && (source?.recordingId !== rec.id || source?.revision !== rec.revision);
  if (!stale) return true;
  if (!confirm('手順の文は、操作の追加・削除の前に作ったか書いたものです。削除した操作の内容が残っていないことを確認しましたか？')) return false;
  source = { recordingId: rec.id, revision: rec.revision };
  await saveDraft();
  return true;
}

/** Builds the payload and runs the final gate. Send and save go through here; copy has the same gates in copyText. */
async function preparePayload() {
  const rec = await loadRecording();
  if (!rec) return { error: '記録がありません' };
  if (!(await confirmFresh(rec))) return { error: STALE_MESSAGE };
  const reproduction = {
    generator: ui.repro.value.trim() ? (generator === 'none' ? 'manual' : generator) : 'none',
    markdown: ui.repro.value,
    // Empty means "not generated yet": buildPayload then renders it from the recording.
    gherkin: ui.gherkin.value,
    ...(summary && !edited ? { summary } : {})
  };
  const payload = D.buildPayload(rec, reproduction, environment());
  const findings = scanWith(rec)(payload);
  return { rec, payload, findings };
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
  previewedFrom = { id: prepared.rec.id, revision: prepared.rec.revision };
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
  ui.sendTarget.textContent = target
    ? `送信先: ${settings.endpoint}${settings.authHeader ? '（Authorization ヘッダ付き。ヘッダはプレビューに含みません）' : ''}`
    : '送信先が未設定です（「プライバシーと送信先」で設定）';
  ui.send.disabled = Boolean(prepared.findings.length) || !target;
  ui.sendStatus.textContent = '';
  ui.dialog.showModal();
});

ui.send.addEventListener('click', () => {
  const pattern = endpointPattern(settings.endpoint);
  if (!pattern || !previewed) return;
  const granted = chrome.permissions.request({ origins: [pattern] });
  const body = previewed;
  (async () => {
    ui.send.disabled = true;
    try {
      if (!(await granted)) {
        ui.sendStatus.textContent = '送信先へのアクセスが許可されませんでした';
        return;
      }
      // Re-check the exact bytes about to leave, not a rebuilt object.
      const rec = await loadRecording();
      // Recorded on after the preview (the page is still being operated): what was shown is not what would go.
      if (!rec || rec.id !== previewedFrom?.id || rec.revision !== previewedFrom?.revision) {
        ui.sendStatus.textContent = 'プレビューの後で記録が変わりました。閉じて、もう一度プレビューしてから送信してください';
        return;
      }
      const findings = scanWith(rec)(JSON.parse(body));
      if (findings.length) {
        ui.sendStatus.textContent = blockedMessage(findings);
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (settings.authHeader) headers.Authorization = settings.authHeader;
      const response = await fetch(settings.endpoint, {
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

async function copyText(label, text) {
  const rec = await loadRecording();
  if (!text.trim()) {
    ui.outputStatus.textContent = '再現手順がまだありません（「再現手順」で生成してください）';
    return;
  }
  if (!(await confirmFresh(rec))) {
    ui.outputStatus.textContent = STALE_MESSAGE;
    return;
  }
  const findings = scanWith(rec)({ [label]: text });
  if (findings.length) {
    ui.outputStatus.textContent = blockedMessage(findings);
    return;
  }
  await navigator.clipboard.writeText(text);
  ui.outputStatus.textContent = `${label} をコピーしました`;
}

ui.copyMd.addEventListener('click', () => copyText('Markdown', ui.repro.value));
ui.copyGherkin.addEventListener('click', () => copyText('Gherkin', ui.gherkin.value));

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
    ui.settingsStatus.textContent = '送信先は https、または http://localhost のみ指定できます';
    return;
  }
  // Ask for the endpoint now, while we still hold the click.
  const granted = pattern ? chrome.permissions.request({ origins: [pattern] }) : Promise.resolve(true);
  const next = {
    privacyLevel: 'strict',
    hostAllowlist: lines(form.hostAllowlist.value).map((h) => h.toLowerCase()),
    keywords: [...new Set(lines(form.keywords.value))],
    endpoint,
    authHeader: form.authHeader.value.trim()
  };
  (async () => {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    settings = { ...S.defaults(), ...next };
    const short = next.keywords.filter((k) => k.length < 2);
    ui.settingsStatus.textContent = (await granted)
      ? `保存しました${short.length ? '（1 文字の語は誤検出が多いため無視します）' : ''}`
      : '保存しました（送信先へのアクセスは未許可です）';
  })();
});

// ------------------------------------------------------------------ wiring

chrome.runtime.onMessage.addListener((message) => {
  if (message?.from !== 'op-scribe/worker') return;
  if (message.type === 'REC_CHANGED') refresh().then(() => showNarration(recording));
  if (message.type === 'NARRATION_STATUS') ui.genStatus.textContent = message.text;
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
      ui.gherkin.value = draft.gherkin || '';
      generator = draft.generator;
      edited = Boolean(draft.edited);
      summary = draft.summary || '';
      source = draft.source || null;
    }
    await refresh();
  } catch (error) {
    reportFatal('init failed', error);
  }
  // The panel must work even if the model never answers.
  await showNarration(recording);
  N.availability(globalThis.LanguageModel).then((state) => {
    ui.aiState.textContent = state === 'available' ? 'AI 利用可' : `AI: ${state}`;
  });
})();
