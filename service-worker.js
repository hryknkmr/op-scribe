/**
 * op-scribe - service worker.
 *
 * Holds no state in module scope except the write queue. The recording lives
 * in chrome.storage.session: it is kept in memory only and disappears when the
 * browser closes, so nothing recorded is written to disk unless the user
 * downloads or sends it.
 *
 * Every step is sanitized again here, whatever the content script already
 * did: URLs are aliased, user keywords masked, and redactions counted.
 */
importScripts('shared/sanitize.js', 'shared/screen.js', 'shared/describe.js', 'shared/units.js', 'shared/narrate.js');

const { scrubText, scrubUrl, defaults, finalScan } = self.OpScribeSanitize;
const { narrate } = self.OpScribeNarrate;
const { buildReproduction, toMarkdown, toGherkin, isPageRewrite } = self.OpScribeDescribe;
const { classifyScreen, describeComponents } = self.OpScribeScreen;

const REC_KEY = 'opsRecording';
// Screen text read by the built-in AI. Kept apart from the recording: it is never
// shown, persisted to disk or sent, and is dropped with the recording.
const UNITS_KEY = 'opsUnits';
// The verbalization: a document made from one revision of the recording, never written onto its
// steps. It is used only while the recording is still at that revision.
const NARRATION_KEY = 'opsNarration';
const SETTINGS_KEY = 'opsSettings';
const SCRIPT_IDS = { recorder: 'opscribe-recorder', webmcp: 'opscribe-webmcp' };
const MAX_STEPS = 500;

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[op-scribe] setPanelBehavior failed', error);
  }
});

// setPanelBehavior is not guaranteed to survive a worker restart on every build.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn('[op-scribe] sidePanel.open failed', error);
  }
});

// ------------------------------------------------------------------ storage

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaults(), ...(stored[SETTINGS_KEY] || {}) };
}

const getRecording = async () => (await chrome.storage.session.get(REC_KEY))[REC_KEY] || null;

// Steps arrive in bursts (blur + click + navigation); serialize read-modify-write.
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const rec = await getRecording();
    const result = await fn(rec);
    if (result?.save) {
      // Every change to the recording is a new revision: a verbalization of an older one is not used.
      result.save.revision = (result.save.revision || 0) + 1;
      await chrome.storage.session.set({ [REC_KEY]: result.save });
    }
    if (result?.remove) await chrome.storage.session.remove([REC_KEY, UNITS_KEY, NARRATION_KEY]);
    if (result?.save || result?.remove) await broadcast({ type: 'REC_CHANGED' });
    return result?.reply;
  });
  queue = run.catch(() => {});
  return run;
}

async function broadcast(message) {
  try {
    await chrome.runtime.sendMessage({ from: 'op-scribe/worker', ...message });
  } catch { /* side panel closed */ }
}

// ----------------------------------------------------------- content scripts

const originPattern = (url) => {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
};

async function syncContentScripts(patterns) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: Object.values(SCRIPT_IDS) });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!patterns.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_IDS.recorder,
      matches: patterns,
      js: ['shared/sanitize.js', 'content/recorder.js'],
      runAt: 'document_start',
      persistAcrossSessions: false
    },
    {
      id: SCRIPT_IDS.webmcp,
      matches: patterns,
      js: ['content/webmcp-tools.js'],
      world: 'MAIN',
      runAt: 'document_start',
      persistAcrossSessions: false
    }
  ]);
}

/** Registered scripts only reach future navigations; the open page needs a direct injection. */
async function injectNow(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/sanitize.js', 'content/recorder.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/webmcp-tools.js'], world: 'MAIN' });
  } catch (error) {
    console.warn('[op-scribe] inject failed', error);
  }
}

async function setBadge(recording) {
  await chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  if (recording) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

// --------------------------------------------------------------- sanitizing

function newId() {
  const random = crypto.getRandomValues(new Uint8Array(3));
  return `rec-${Date.now().toString(36)}-${[...random].map((b) => b.toString(36)).join('')}`;
}

function bump(rec, kinds) {
  for (const kind of kinds) rec.redactions[kind] = (rec.redactions[kind] || 0) + 1;
}

function cleanStep(raw, rec, settings) {
  const ctx = {
    hostAllowlist: settings.hostAllowlist,
    aliases: rec.aliases,
    keywords: settings.keywords
  };
  const kinds = [];
  const text = (value, maxLength) => {
    const r = scrubText(value, { keywords: settings.keywords, maxLength, hosts: ctx });
    kinds.push(...r.kinds);
    return r.text;
  };
  const url = (value) => {
    const r = scrubUrl(value, ctx);
    kinds.push(...r.kinds.filter((k) => k !== 'host'));
    return r.url;
  };

  const step = { type: String(raw.type).slice(0, 16), t: Math.max(0, Date.now() - rec.startedAt), source: raw.source || 'user' };
  if (raw.pageUrl) step.url = url(raw.pageUrl);
  if (raw.target) {
    const t = raw.target;
    step.target = { role: text(t.role, 24), tag: text(t.tag, 16) };
    if (t.name) step.target.name = text(t.name, 80);
    // A selector is a locator, not prose: if anything had to be masked, drop it entirely.
    if (t.selector) {
      const r = scrubText(t.selector, { keywords: settings.keywords });
      if (!r.kinds.length) step.target.selector = r.text.slice(0, 160);
    }
    if (t.href) step.target.href = url(t.href);
    if (t.component?.kind) {
      step.target.component = { kind: text(t.component.kind, 12) };
      if (t.component.name) step.target.component.name = text(t.component.name, 30);
      if (Number.isFinite(t.component.size)) step.target.component.size = t.component.size;
    }
  }
  // Screens are classified from the masked URL, so no raw path ends up in their reasons.
  if (raw.screen) step.screen = cleanScreen({ ...raw.screen, url: step.url }, text);
  if (raw.value !== undefined) step.value = text(raw.value, 200);
  if (raw.checked !== undefined) step.checked = Boolean(raw.checked);
  if (raw.key) step.key = text(raw.key, 24);
  if (['user', 'automation', 'script', 'agent'].includes(raw.actor)) step.actor = raw.actor;
  if (raw.seq) step.seq = String(raw.seq).slice(0, 24);
  if (raw.tool) {
    step.tool = text(raw.tool, 80);
    step.ok = raw.ok !== false;
    step.source = 'agent';
    if (raw.args && typeof raw.args === 'object') {
      const r = scrubText(JSON.stringify(raw.args), { keywords: settings.keywords, hosts: ctx });
      kinds.push(...r.kinds);
      try { step.args = JSON.parse(r.text); } catch { step.args = { masked: '[[value]]' }; }
    }
  }
  if (raw.note) {
    step.note = text(raw.note, 300);
    // A note belongs to the page it was written on; WebMCP only returns notes of the asking site.
    if (!step.url) step.url = [...rec.steps].reverse().find((s) => s.url)?.url;
  }
  bump(rec, [...kinds, ...(raw.valueKinds || [])]);
  return step;
}

/**
 * Masks every label the content script collected, then derives what the
 * screen is for. Only the derived summary and short labels are kept.
 */
function cleanScreen(raw, text) {
  const list = (values, max, limit) => (Array.isArray(values) ? values : []).slice(0, limit).map((v) => text(v, max));
  const features = {
    url: raw.url,
    title: text(raw.title, 80),
    h1: text(raw.h1, 60),
    forms: (Array.isArray(raw.forms) ? raw.forms : []).slice(0, 6).map((form) => ({
      kind: form.kind === 'search' ? 'search' : 'form',
      global: Boolean(form.global),
      name: text(form.name, 30),
      submit: text(form.submit, 30),
      fields: (Array.isArray(form.fields) ? form.fields : []).slice(0, 12)
        .map((field) => ({ type: text(field.type, 16), label: text(field.label, 30) }))
    })),
    buttons: list(raw.buttons, 30, 15),
    navLinks: list(raw.navLinks, 20, 10),
    headings: list(raw.headings, 30, 6),
    dialogs: list(raw.dialogs, 30, 3),
    editor: Boolean(raw.editor),
    article: Boolean(raw.article),
    textLength: Number(raw.textLength) || 0,
    prose: Number(raw.prose) || 0,
    tables: Number(raw.tables) || 0,
    repeated: raw.repeated?.count ? { count: Number(raw.repeated.count) } : null
  };
  const { purposes, summary } = classifyScreen(features);
  return {
    title: features.title,
    h1: features.h1 !== features.title ? features.h1 : '',
    purposes: purposes.map(({ kind, label, reasons }) => ({ kind, label, reasons })),
    summary,
    components: describeComponents(features)
  };
}

function appendStep(rec, step) {
  rec.nextId = (rec.nextId || 0) + 1;
  step.id = `s${rec.nextId}`;
  rec.steps.push(step);
  if (rec.steps.length > MAX_STEPS) rec.steps.splice(0, rec.steps.length - MAX_STEPS);
}

/**
 * A screen described again (after rendering settled, or its title changed)
 * replaces the earlier description as long as no operation happened in between.
 */
function appendScreen(rec, step) {
  for (let i = rec.steps.length - 1; i >= 0; i -= 1) {
    const s = rec.steps[i];
    if (s.type === 'navigate' || s.type === 'note') continue;
    if (s.type === 'screen' && s.url === step.url) {
      rec.steps[i] = { ...step, t: s.t, id: s.id };
      return s.id;
    }
    break;
  }
  appendStep(rec, step);
  return step.id;
}

// Units are up to 40,000 characters a screen; storage.session holds 10 MB in all.
const MAX_UNIT_SCREENS = 40;

/** Keeps the units of the steps still in the recording, the latest MAX_UNIT_SCREENS of them. */
function pruneUnits(stored, rec) {
  const ids = rec.steps.filter((s) => stored[s.id]).map((s) => s.id).slice(-MAX_UNIT_SCREENS);
  return Object.fromEntries(ids.map((id) => [id, stored[id]]));
}

async function saveUnits(rec, id, units, settings) {
  if (!Array.isArray(units) || !units.length) return;
  // URLs in the text follow the URL policy; real hosts written without a URL are aliased too.
  const hosts = { hostAllowlist: settings.hostAllowlist, aliases: rec.aliases };
  // Read at each use: aliases made for URLs in earlier text apply to later text too.
  const known = () => Object.entries(rec.aliases || {}).map(([origin, alias]) => {
    try { return [new URL(origin).hostname, alias]; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b[0].length - a[0].length);
  const hide = (text) => known().reduce((t, [host, alias]) => t.replace(new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), alias), text);
  const clean = units.slice(0, 200).map((u) => ({
    kind: String(u.kind).slice(0, 16),
    name: hide(scrubText(u.name, { keywords: settings.keywords, maxLength: 60, hosts }).text),
    text: hide(scrubText(u.text, { keywords: settings.keywords, hosts }).text),
    order: Number(u.order) || 0,
    ...(Number.isFinite(u.count) ? { count: u.count } : {})
  }));
  const stored = (await chrome.storage.session.get(UNITS_KEY))[UNITS_KEY] || {};
  stored[id] = clean;
  // Only the built-in AI reads units: failing to keep them must not lose the step.
  try {
    await chrome.storage.session.set({ [UNITS_KEY]: pruneUnits(stored, rec) });
  } catch (error) {
    console.warn('[op-scribe] screen text not kept', error);
  }
}

const isRecordingTab = (rec, tabId) => rec?.state === 'recording' && rec.tabId === tabId;

/** What appeared or disappeared right after an operation belongs to that operation. */
function attachChange(rec, detail, settings) {
  const step = rec.steps.find((s) => s.seq && s.seq === String(detail?.seq));
  if (!step) return false;
  const lines = (list) => (Array.isArray(list) ? list : []).slice(0, 8)
    .map((t) => scrubText(t, { keywords: settings.keywords, maxLength: 160, hosts: { hostAllowlist: settings.hostAllowlist, aliases: rec.aliases } }).text);
  step.change = { appeared: lines(detail.change?.appeared), removed: lines(detail.change?.removed) };
  // Shown and gone again before the watch ended (a toast).
  const transient = lines(detail.change?.transient);
  if (transient.length) step.change.transient = transient;
  // Of those, what a notification area (status, alert, toast) showed: the page telling the result.
  const notices = lines(detail.change?.notices).slice(0, 4);
  if (notices.length) step.change.notices = notices;
  return true;
}

// ------------------------------------------------------------------ actions

async function start({ tabId, url }) {
  const settings = await getSettings();
  const pattern = originPattern(url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: 'PERMISSION_DENIED' };  // a reply, not a mutate() result
  }
  return mutate(async (previous) => {
    if (previous?.state === 'recording') await stopTab(previous);
    const rec = {
      id: newId(),
      state: 'recording',
      tabId,
      startedAt: Date.now(),
      endedAt: null,
      privacyLevel: 'strict',
      aliases: {},
      grantedPatterns: [pattern],
      redactions: {},
      webmcpTools: {},
      steps: []
    };
    rec.startUrl = scrubUrl(url, { ...settings, aliases: rec.aliases }).url;
    appendStep(rec, cleanStep({ type: 'navigate', pageUrl: url }, rec, settings));
    await syncContentScripts(rec.grantedPatterns);
    // Persist before injecting: the injected script immediately asks whether it is being recorded.
    await chrome.storage.session.remove([UNITS_KEY, NARRATION_KEY]);
    await chrome.storage.session.set({ [REC_KEY]: rec });
    await injectNow(tabId);
    await setBadge(true);
    return { save: rec, reply: { ok: true } };
  });
}

async function stopTab(rec) {
  await syncContentScripts([]);
  await setBadge(false);
  try {
    await chrome.tabs.sendMessage(rec.tabId, { from: 'op-scribe/worker', type: 'OPS_STOP' });
  } catch { /* tab gone or never injected */ }
}

const stop = async () => {
  const reply = await mutate(async (rec) => {
    if (!rec || rec.state !== 'recording') return { reply: { ok: true, stopped: false } };
    // The last screen may not have been described yet (fast automated runs): ask for it now.
    try {
      const last = await chrome.tabs.sendMessage(rec.tabId, { from: 'op-scribe/worker', type: 'OPS_FLUSH' });
      if (last?.pending) attachChange(rec, last.pending, await getSettings());
      if (last?.screen) {
        const settings = await getSettings();
        await saveUnits(rec, appendScreen(rec, cleanStep({ type: 'screen', ...last }, rec, settings)), last.units, settings);
      }
    } catch { /* tab gone or not injected */ }
    await stopTab(rec);
    rec.state = 'stopped';
    rec.endedAt = Date.now();
    return { save: rec, reply: { ok: true, stopped: true } };
  });
  // Whoever operated - a person or an automated test - the recording is verbalized
  // as soon as it ends, without waiting for anyone to open the side panel.
  if (reply.stopped) verbalize();
  return reply;
};

// ----------------------------------------------------------- verbalizing

/** Words the final scan must not find: the user's list plus every real host that was aliased. */
function scanFor(rec, settings) {
  const hosts = Object.keys(rec.aliases || {}).map((origin) => {
    try { return new URL(origin).hostname; } catch { return ''; }
  });
  const keywords = [...(settings.keywords || []), ...hosts].filter(Boolean);
  return (value) => finalScan(value, { keywords });
}

/**
 * The worker may be stopped after ~30s without extension events, and an
 * on-device generation can take longer; a cheap API call every 20s keeps it alive.
 */
async function withKeepAlive(work) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function verbalize() {
  const rec = await getRecording();
  if (!rec?.steps?.length) return { ok: false, error: 'NO_RECORDING' };
  const settings = await getSettings();
  const source = { recordingId: rec.id, sourceRevision: rec.revision };
  await chrome.storage.session.set({ [NARRATION_KEY]: { ...source, generator: 'pending', markdown: '' } });
  await broadcast({ type: 'NARRATION_STATUS', text: 'Built-in AI で言語化しています…' });
  const units = (await chrome.storage.session.get(UNITS_KEY))[UNITS_KEY] || {};
  const result = await withKeepAlive(() => narrate(rec, {
    LM: self.LanguageModel,
    scan: scanFor(rec, settings),
    unitsOf: (step) => units[step.id] || null,
    onStatus: (text) => broadcast({ type: 'NARRATION_STATUS', text })
  }));
  // Through the queue, so no change to the recording lands between the check and the write.
  const kept = await mutate(async (latest) => {
    // The recording changed while the model was reading: a deleted step may be quoted, an added one missing.
    if (latest?.id !== source.recordingId || latest.revision !== source.sourceRevision) return { reply: false };
    const { generator, markdown, title, summary, reason } = result;
    await chrome.storage.session.set({ [NARRATION_KEY]: { ...source, generator, markdown, title, summary, reason, at: Date.now() } });
    await broadcast({ type: 'REC_CHANGED' });
    return { reply: true };
  });
  if (!kept) return { ok: false, error: 'RECORDING_CHANGED' };
  return { ok: true, generator: result.generator, reason: result.reason };
}

const addPattern = (url) => mutate(async (rec) => {
  if (!rec || rec.state !== 'recording') return { reply: { ok: false, error: 'NOT_RECORDING' } };
  const pattern = originPattern(url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { reply: { ok: false, error: 'PERMISSION_DENIED' } };
  }
  if (!rec.grantedPatterns.includes(pattern)) rec.grantedPatterns.push(pattern);
  await syncContentScripts(rec.grantedPatterns);
  await injectNow(rec.tabId);
  return { save: rec, reply: { ok: true } };
});

/** Origin as it appears in the recording (real if allowlisted, otherwise its alias). */
function siteOf(rec, settings, origin) {
  const { url } = scrubUrl(`${origin}/`, { ...settings, aliases: { ...rec.aliases } });
  try { return new URL(url).origin; } catch { return url; }
}

async function webmcpRequest(rec, sender, { op, args }) {
  if (!isRecordingTab(rec, sender.tab?.id)) return { reply: { ok: false, error: 'NOT_RECORDING' } };
  const settings = await getSettings();
  const site = siteOf(rec, settings, sender.origin);
  // Steps on other sites are never handed to this page. The model's text is not on the steps:
  // it was written from neighbouring screens too, which may be on other sites.
  const own = rec.steps.filter((s) => s.url?.startsWith(`${site}/`));
  const scan = scanFor(rec, settings);

  if (op === 'status') {
    return { reply: { ok: true, recording: true, site, stepsOnThisSite: own.length, totalSteps: rec.steps.length } };
  }
  if (op === 'reproduction') {
    const scoped = { ...rec, steps: own, startUrl: own[0]?.url };
    const reply = { ok: true, site, steps: own.length, markdown: toMarkdown(buildReproduction(scoped)), gherkin: toGherkin(scoped) };
    // Same gate as every other exit: the page gets nothing the final scan would stop.
    if (scan(reply).length) return { reply: { ok: false, error: 'BLOCKED_BY_FINAL_SCAN' } };
    return { reply };
  }
  if (op === 'expect') {
    const note = String(args?.text || '').trim();
    if (!note) return { reply: { ok: false, error: 'EMPTY_TEXT' } };
    appendStep(rec, cleanStep({ type: 'note', note, source: 'agent', pageUrl: `${sender.origin}/` }, rec, settings));
    return { save: rec, reply: { ok: true, added: rec.steps[rec.steps.length - 1].note } };
  }
  return { reply: { ok: false, error: 'UNKNOWN_OP' } };
}

// ------------------------------------------------------------------ messages

async function handle(message, sender) {
  const { type, detail = {} } = message;

  if (message.from === 'op-scribe/panel') {
    switch (type) {
      case 'START': return start(detail);
      case 'STOP': return stop();
      case 'NARRATE': return verbalize();
      case 'ADD_ORIGIN': return addPattern(detail.url);
      case 'CLEAR': return mutate(async (rec) => {
        if (rec?.state === 'recording') await stopTab(rec);
        return { remove: true, reply: { ok: true } };
      });
      case 'DELETE_STEP': return mutate(async (rec) => {
        if (!rec) return { reply: { ok: false } };
        rec.steps.splice(Number(detail.index), 1);
        // The new revision makes the verbalization, which may quote the deleted step, unusable.
        const units = (await chrome.storage.session.get(UNITS_KEY))[UNITS_KEY];
        if (units) await chrome.storage.session.set({ [UNITS_KEY]: pruneUnits(units, rec) });
        return { save: rec, reply: { ok: true } };
      });
      case 'ADD_NOTE': return mutate(async (rec) => {
        if (!rec) return { reply: { ok: false, error: 'NO_RECORDING' } };
        appendStep(rec, cleanStep({ type: 'note', note: String(detail.text || '') }, rec, await getSettings()));
        return { save: rec, reply: { ok: true } };
      });
      default: return { ok: false, error: 'UNKNOWN' };
    }
  }

  if (message.from === 'op-scribe/content') {
    const tabId = sender.tab?.id;
    if (type === 'HELLO') {
      const rec = await getRecording();
      if (!isRecordingTab(rec, tabId)) return { active: false };
      const settings = await getSettings();
      return { active: true, config: { keywords: settings.keywords } };
    }
    return mutate(async (rec) => {
      if (!isRecordingTab(rec, tabId)) return { reply: { ok: false, error: 'NOT_RECORDING' } };
      const settings = await getSettings();
      if (type === 'STEP') {
        const step = cleanStep(detail, rec, settings);
        if (step.type === 'screen') await saveUnits(rec, appendScreen(rec, step), detail.units, settings);
        else appendStep(rec, step);
        return { save: rec, reply: { ok: true } };
      }
      if (type === 'CHANGE') {
        if (!attachChange(rec, detail, settings)) return { reply: { ok: false } };
        return { save: rec, reply: { ok: true } };
      }
      if (type === 'WEBMCP_TOOLS') {
        const site = siteOf(rec, settings, new URL(detail.pageUrl).origin);
        rec.webmcpTools[site] = (detail.names || []).map((n) => scrubText(n, { keywords: settings.keywords, maxLength: 80 }).text);
        return { save: rec, reply: { ok: true } };
      }
      if (type === 'WEBMCP_REQUEST') return webmcpRequest(rec, sender, detail);
      return { reply: { ok: false, error: 'UNKNOWN' } };
    });
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.from !== 'op-scribe/panel' && message?.from !== 'op-scribe/content') return false;
  (async () => {
    try {
      sendResponse(await handle(message, sender));
    } catch (error) {
      console.error('[op-scribe]', message.type, error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});

// Navigations (including SPA history changes) in the recorded tab.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await mutate(async (rec) => {
    if (!isRecordingTab(rec, tabId)) return null;
    const settings = await getSettings();
    const step = cleanStep({ type: 'navigate', pageUrl: changeInfo.url }, rec, settings);
    const last = rec.steps[rec.steps.length - 1];
    if (last?.type === 'navigate' && last.url === step.url) return null;
    // The page rewrote its own URL (tracking parameters, canonical form): not a new step.
    const rewritten = isPageRewrite(rec.steps, step);
    if (rewritten) {
      for (const s of rewritten) s.url = step.url;
      return { save: rec };
    }
    appendStep(rec, step);
    return { save: rec };
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRecording();
  if (isRecordingTab(rec, tabId)) await stop();
});

// The session store is wiped when the browser restarts; so is the badge state.
chrome.runtime.onStartup.addListener(() => setBadge(false));
