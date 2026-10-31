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
importScripts('shared/sanitize.js', 'shared/describe.js');

const { scrubText, scrubUrl, maskArgs, maskByKind, defaults, finalScan, aliasedHosts, hostAllowed, isPlaceholder } = self.OpScribeSanitize;
const { buildReproduction, toMarkdown, toGherkin } = self.OpScribeDescribe;

const REC_KEY = 'opsRecording';
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
    if (result?.save) await chrome.storage.session.set({ [REC_KEY]: result.save });
    if (result?.remove) await chrome.storage.session.remove(REC_KEY);
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

/**
 * The host lists of a recording, fixed when it started (docs/adr/0001): a change in the settings applies to the
 * next recording. Recordings started before the lists were kept fall back to the settings.
 */
const policyOf = (rec, settings) => ({
  hostAllowlist: rec.policy?.hostAllowlist ?? settings.hostAllowlist,
  productionHosts: rec.policy?.productionHosts ?? settings.productionHosts ?? []
});

const hostOf = (value) => {
  try { return new URL(value).hostname.replace(/\.+$/, ''); } catch { return ''; }
};

const VALUE_CLASSES = new Set(['text', 'search', 'choice', 'secret', 'card', 'email', 'phone', 'id']);

/**
 * origin: where the step came from as Chrome reports it (the sender), not as the page says. A step from a
 * production host is commercial (docs/adr/0001); a navigation is judged by its URL, a note by the step before it.
 */
function cleanStep(raw, rec, settings, origin = null) {
  const policy = policyOf(rec, settings);
  const source = origin || (raw.type === 'navigate' ? raw.pageUrl : null);
  const commercial = source ? hostAllowed(hostOf(source), policy.productionHosts)
    : rec.steps[rec.steps.length - 1]?.privacy?.profile === 'commercial';
  const ctx = {
    hostAllowlist: policy.hostAllowlist,
    productionHosts: policy.productionHosts,
    aliases: rec.aliases,
    keywords: settings.keywords,
    strict: commercial
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
  step.privacy = { profile: commercial ? 'commercial' : 'standard' };
  if (raw.pageUrl) step.url = url(raw.pageUrl);
  if (raw.target) {
    const t = raw.target;
    step.target = { role: text(t.role, 24), tag: text(t.tag, 16) };
    if (t.name) step.target.name = text(t.name, 80);
    // A selector is a locator, not prose: if anything had to be masked, or it holds a URL or a host
    // the policy cannot place, drop it entirely.
    if (t.selector) {
      const r = scrubText(t.selector, { keywords: settings.keywords, hosts: { hostAllowlist: policy.hostAllowlist, aliases: {} } });
      // An id-like number or a host name inside the selector (#user-123456, [data-testid="x.example.test"]) too.
      // A CSS-escaped dot (#private\.example\.test) is a host name in an id.
      const identifying = /\/\/|@|\\|\d{3,}|[0-9a-f]{8,}|["'][^"']*[\w-]\.[a-z]{2,}[^"']*["']/i.test(t.selector);
      if (!r.kinds.length && !identifying) step.target.selector = r.text.slice(0, 160);
    }
    if (t.href) step.target.href = url(t.href);
  }
  if (raw.value !== undefined) {
    // What kind of field the value came from, as the content script classified it; anything unknown is free text.
    step.valueClass = VALUE_CLASSES.has(raw.valueClass) ? raw.valueClass : 'text';
    const value = String(raw.value ?? '');
    // On production free text arrives as its length only ([[text:12]]); anything else is not kept.
    if (commercial && step.valueClass === 'text' && value && !isPlaceholder(value)) step.value = '[[v]]';
    // A contact or id field's value is masked for its kind again here (the content script's partial mask is kept).
    else if (['email', 'phone', 'id', 'secret', 'card'].includes(step.valueClass)) {
      const r = maskByKind(step.valueClass, value, { keywords: settings.keywords, maxLength: 200, trustHidden: true });
      kinds.push(...r.kinds);
      step.value = r.value;
    } else step.value = text(value, 200);
  }
  if (raw.checked !== undefined) step.checked = Boolean(raw.checked);
  if (raw.key) step.key = text(raw.key, 24);
  if (raw.tool) {
    step.tool = text(raw.tool, 80);
    step.ok = raw.ok !== false;
    step.source = 'agent';
    if (raw.args && typeof raw.args === 'object') {
      // Masked by key again here (the page may not have), then as text.
      // The content script masked them already: its partial masks are kept as they are (trustHidden), anything else is masked.
      const r = scrubText(JSON.stringify(maskArgs(raw.args, { keywords: settings.keywords, trustHidden: true, strict: commercial })), { keywords: settings.keywords, hosts: ctx });
      kinds.push(...r.kinds);
      try { step.args = JSON.parse(r.text); } catch { step.args = { masked: '[[value]]' }; }
    }
  }
  if (raw.note) step.note = text(raw.note, 300);
  bump(rec, [...kinds, ...(raw.valueKinds || [])]);
  return step;
}

function appendStep(rec, step) {
  rec.steps.push(step);
  if (rec.steps.length > MAX_STEPS) rec.steps.splice(0, rec.steps.length - MAX_STEPS);
}

const isRecordingTab = (rec, tabId) => rec?.state === 'recording' && rec.tabId === tabId;

// ------------------------------------------------------------------ actions

async function start({ tabId, url }) {
  const settings = await getSettings();
  const pattern = originPattern(url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { reply: { ok: false, error: 'PERMISSION_DENIED' } };
  }
  return mutate(async (previous) => {
    if (previous?.state === 'recording') await stopTab(previous);
    const rec = {
      id: newId(),
      state: 'recording',
      tabId,
      startedAt: Date.now(),
      endedAt: null,
      privacyLevel: 'partial',
      // The host lists as they were when recording started: used until it ends (docs/adr/0001).
      policy: { hostAllowlist: [...settings.hostAllowlist], productionHosts: [...(settings.productionHosts || [])] },
      aliases: {},
      grantedPatterns: [pattern],
      redactions: {},
      webmcpTools: {},
      steps: []
    };
    rec.startUrl = scrubUrl(url, { ...rec.policy, keywords: settings.keywords, aliases: rec.aliases }).url;
    appendStep(rec, cleanStep({ type: 'navigate', pageUrl: url }, rec, settings));
    await syncContentScripts(rec.grantedPatterns);
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

const stop = () => mutate(async (rec) => {
  if (!rec || rec.state !== 'recording') return { reply: { ok: true } };
  await stopTab(rec);
  rec.state = 'stopped';
  rec.endedAt = Date.now();
  return { save: rec, reply: { ok: true } };
});

/** Words the final scan must not find: the user's list plus every real host that was aliased. */
function scanFor(rec, settings) {
  const hosts = aliasedHosts(rec.aliases).map(([host]) => host);
  const keywords = [...(settings.keywords || []), ...hosts].filter(Boolean);
  return (value) => finalScan(value, { keywords, hostAllowlist: policyOf(rec, settings).hostAllowlist, aliases: Object.values(rec.aliases || {}) });
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
  const { url } = scrubUrl(`${origin}/`, { ...policyOf(rec, settings), aliases: { ...rec.aliases } });
  try { return new URL(url).origin; } catch { return url; }
}

async function webmcpRequest(rec, sender, { op, args }) {
  if (!isRecordingTab(rec, sender.tab?.id)) return { reply: { ok: false, error: 'NOT_RECORDING' } };
  const settings = await getSettings();
  const site = siteOf(rec, settings, sender.origin);
  // Steps on other sites are never handed to this page.
  const own = rec.steps.filter((s) => s.url?.startsWith(`${site}/`) || (!s.url && s.type === 'note'));

  if (op === 'status') {
    return { reply: { ok: true, recording: true, site, stepsOnThisSite: own.length, totalSteps: rec.steps.length } };
  }
  if (op === 'reproduction') {
    const scoped = { ...rec, steps: own, startUrl: own[0]?.url };
    const reply = { ok: true, site, steps: own.length, markdown: toMarkdown(buildReproduction(scoped)), gherkin: toGherkin(scoped) };
    // Same gate as every other exit: the page gets nothing the final scan would stop.
    if (scanFor(rec, settings)(reply).length) return { reply: { ok: false, error: 'BLOCKED_BY_FINAL_SCAN' } };
    return { reply };
  }
  if (op === 'expect') {
    const note = String(args?.text || '').trim();
    if (!note) return { reply: { ok: false, error: 'EMPTY_TEXT' } };
    appendStep(rec, cleanStep({ type: 'note', note, source: 'agent' }, rec, settings));
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
      case 'ADD_ORIGIN': return addPattern(detail.url);
      case 'CLEAR': return mutate(async (rec) => {
        if (rec?.state === 'recording') await stopTab(rec);
        return { remove: true, reply: { ok: true } };
      });
      case 'DELETE_STEP': return mutate(async (rec) => {
        if (!rec) return { reply: { ok: false } };
        rec.steps.splice(Number(detail.index), 1);
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
      return { active: true, config: { keywords: settings.keywords, productionHosts: policyOf(rec, settings).productionHosts } };
    }
    return mutate(async (rec) => {
      if (!isRecordingTab(rec, tabId)) return { reply: { ok: false, error: 'NOT_RECORDING' } };
      const settings = await getSettings();
      if (type === 'STEP') {
        appendStep(rec, cleanStep(detail, rec, settings, sender.origin || sender.url));
        return { save: rec, reply: { ok: true } };
      }
      if (type === 'WEBMCP_TOOLS') {
        const site = siteOf(rec, settings, new URL(detail.pageUrl).origin);
        const hosts = { ...policyOf(rec, settings), aliases: rec.aliases };
        rec.webmcpTools[site] = (detail.names || []).map((n) => scrubText(n, { keywords: settings.keywords, maxLength: 80, hosts }).text);
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
    const last = [...rec.steps].reverse().find((s) => s.type === 'navigate');
    if (last?.url === step.url && rec.steps[rec.steps.length - 1] === last) return null;
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
