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
const { TOTALS } = globalThis.OpScribeLimits;
const D = globalThis.OpScribeDescribe;
const P = globalThis.OpScribePayload;

const REC_KEY = 'opsRecording';
const SETTINGS_KEY = 'opsSettings';
const DRAFT_KEY = 'opsDraft';
const NOTICE_KEY = 'opsNotice';

const el = (id) => document.getElementById(id);
const ui = {
  tabStatus: el('tab-status'),
  recState: el('rec-state'),
  start: el('rec-start'),
  stop: el('rec-stop'),
  clear: el('rec-clear'),
  originGate: el('origin-gate'),
  policyNotice: el('policy-notice'),
  policyNoticeOk: el('policy-notice-ok'),
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
/**
 * The recording revision the Markdown was generated (or first hand-written)
 * from. When the steps change after that - a step deleted, more recorded - the
 * Markdown may still hold what was deleted, so no exit takes it until it is
 * generated again or cleared (#16, ADR 0003 row E4).
 */
let basis = null;
/** The exact JSON string shown in the preview; this is what gets sent. */
let previewed = null;
let previewedRevision = null;

const STALE = '記録が変わったため（ステップの削除・追加）、この再現手順は出力できません。作り直すか、手順の欄を空にしてください';
const isStale = (rec) => Boolean(ui.repro.value.trim()) && basis !== (rec?.revision ?? 0);

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

/** Every real host that was aliased (row K5): the final scan must not find them, whatever their length. */
function aliasedHosts(rec) {
  return Object.keys(rec?.aliases || {}).map((origin) => {
    try { return new URL(origin).hostname; } catch { return ''; }
  }).filter(Boolean);
}

const scanWith = (rec) => (value) => S.finalScan(value, { keywords: settings.keywords, hosts: aliasedHosts(rec) });

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
    remove.addEventListener('click', () => send('DELETE_STEP', { index }));
    li.append(text, remove);
    ui.steps.append(li);
  });

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
    const result = await send('START', { tabId: tab.id, url: tab.url });
    if (!result?.ok) ui.tabStatus.textContent = `記録を開始できません (${result?.error || 'unknown'})`;
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
  basis = null;
  generator = 'none';
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
  [DRAFT_KEY]: { markdown: ui.repro.value, generator, basis }
});

/** Markdown may come from the model; Gherkin is always rebuilt from the recording (render). */
async function setRepro(rec, markdown, by) {
  ui.repro.value = markdown;
  generator = by;
  basis = rec.revision ?? 0;
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
    const start = D.startUrlOf(rec);
    const { output, input: prompt } = await rewrite(input, start === '[[url:none]]' ? '' : start, (text) => { ui.genStatus.textContent = text; });
    const problems = validate(output, prompt, scanWith(rec));
    if (problems.length) {
      await generateTemplate(`AI の出力を採用しませんでした: ${problems[0]}`);
      return;
    }
    const merged = {
      title: output.title,
      preconditions: [...new Set([...base.preconditions, ...(output.preconditions || [])])],
      steps: output.steps.map((s) => ({ action: s.action, expected: s.expected || undefined })),
      notes: [...new Set([...(output.notes || []), ...base.notes])]
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
  if (basis === null) basis = recording?.revision ?? 0;
  if (!ui.repro.value.trim()) basis = null;
  saveDraft();
});

// ------------------------------------------------------------------ output

/** Builds the payload and runs the final gate. Every exit (send, copy, save) goes through here. */
async function preparePayload() {
  const rec = await loadRecording();
  if (!rec) return { error: '記録がありません' };
  if (isStale(rec)) return { error: STALE };
  const reproduction = {
    generator: ui.repro.value.trim() ? (generator === 'none' ? 'manual' : generator) : 'none',
    markdown: ui.repro.value
  };
  // The Gherkin in the payload is rebuilt from the recording here, never taken from the panel.
  const payload = P.buildPayload(rec, reproduction, environment());
  return { rec, payload, findings: exitFindings(rec, payload) };
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
  previewedRevision = prepared.rec.revision ?? 0;
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
      if ((rec?.revision ?? 0) !== previewedRevision) {
        ui.sendStatus.textContent = 'プレビューの後に記録が変わりました。もう一度プレビューしてください';
        return;
      }
      const findings = exitFindings(rec, JSON.parse(body));
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
    ui.settingsStatus.textContent = '送信先は https、または http://localhost のみ指定できます';
    return;
  }
  // Ask for the endpoint now, while we still hold the click.
  const granted = pattern ? chrome.permissions.request({ origins: [pattern] }) : Promise.resolve(true);
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
      ? `保存しました${unused.length ? `（1 文字の語と、伏せ字の名前の一部になる語は使いません: ${unused.slice(0, 5).join('、')}）` : ''}`
      : '保存しました（送信先へのアクセスは未許可です）';
  })();
});

async function dismissNotice() {
  await chrome.storage.local.remove(NOTICE_KEY);
  ui.policyNotice.hidden = true;
}

ui.policyNoticeOk.addEventListener('click', dismissNotice);

// ------------------------------------------------------------------ wiring

chrome.runtime.onMessage.addListener((message) => {
  if (message?.from === 'op-scribe/worker' && message.type === 'REC_CHANGED') refresh();
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
    ui.policyNotice.hidden = !(await chrome.storage.local.get(NOTICE_KEY))[NOTICE_KEY];
    await refresh();
  } catch (error) {
    reportFatal('init failed', error);
  }
  // The panel must work even if the model never answers.
  availability().then((state) => {
    ui.aiState.textContent = state === 'available' ? 'AI 利用可' : `AI: ${state}`;
  });
})();
