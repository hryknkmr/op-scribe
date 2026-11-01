/**
 * op-scribe - service worker.
 *
 * Holds no state in module scope except the write queue. The recording lives
 * in chrome.storage.session: it is kept in memory only and disappears when the
 * browser closes, so nothing recorded is written to disk unless the user
 * downloads or sends it.
 *
 * Every step is sanitized again here (shared/record.js), whatever the content
 * script already did: the environment is decided again from the sender,
 * typed values are checked, URLs are aliased, user keywords masked, and
 * redactions counted.
 */
importScripts('shared/limits.js', 'shared/sanitize.js', 'shared/describe.js', 'shared/record.js');

const { cleanLine, scrubUrl, defaults } = self.OpScribeSanitize;
const { LIMITS, renderRuns } = self.OpScribeLimits;
const { humanize } = self.OpScribeDescribe;
const { policyOf, envOf, addStep, fitRecord, guardReply, webmcpReply } = self.OpScribeRecord;

const REC_KEY = 'opsRecording';
const SETTINGS_KEY = 'opsSettings';
const NOTICE_KEY = 'opsNotice';
const SCRIPT_IDS = { recorder: 'opscribe-recorder', webmcp: 'opscribe-webmcp' };

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[op-scribe] setPanelBehavior failed', error);
  }
  // Earlier versions were strict everywhere by default. Free text is now kept
  // outside the listed production hosts (ADR 0001), so tell those users once.
  if (reason === 'update') {
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (!stored?.commercialHosts?.length && stored?.privacyLevel !== 'balanced') {
      await chrome.storage.local.set({ [NOTICE_KEY]: 'commercial-hosts' });
    }
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
    // Every save fits the recording's share first (fitRecord); one that still fails is an error
    // to the caller, never a step that silently went missing (reviews R40, R43).
    if (result?.save) {
      fitRecord(result.save);
      await chrome.storage.session.set({ [REC_KEY]: result.save });
    }
    if (result?.remove) await chrome.storage.session.remove(REC_KEY);
    if (result?.save || result?.remove) await broadcast({ type: 'REC_CHANGED' });
    await result?.after?.();
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
      js: ['shared/limits.js', 'shared/sanitize.js', 'shared/target.js', 'content/recorder.js'],
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared/limits.js', 'shared/sanitize.js', 'shared/target.js', 'content/recorder.js'] });
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

/**
 * Every change to the steps bumps the revision, so the panel can tell that a
 * reproduction it generated earlier no longer matches the recording (#16).
 */

const tabIdsOf = (rec) => Array.isArray(rec?.tabIds) ? rec.tabIds : (Number.isInteger(rec?.tabId) ? [rec.tabId] : []);
const pendingTabIdsOf = (rec) => Array.isArray(rec?.pendingTabIds) ? rec.pendingTabIds : [];
const attachedTabIdsOf = (rec) => Array.isArray(rec?.attachedTabIds)
  ? rec.attachedTabIds
  : (rec?.attached && Number.isInteger(rec?.tabId) ? [rec.tabId] : []);
const isRecordingTab = (rec, tabId) => rec?.state === 'recording' && tabIdsOf(rec).includes(tabId);
const isPendingTab = (rec, tabId) => rec?.state === 'recording' && pendingTabIdsOf(rec).includes(tabId);

// ------------------------------------------------------------------ actions

async function start({ tabId, url }) {
  const settings = await getSettings();
  const pattern = originPattern(url);
  // Outside mutate, so this is the reply itself, not a { reply } for mutate to unwrap.
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: 'PERMISSION_DENIED' };
  }
  return mutate(async (previous) => {
    const rec = {
      id: newId(),
      state: 'recording',
      tabId,
      // Browser-only session ownership. None of these fields is in the payload SHAPE.
      tabIds: [tabId],
      pendingTabIds: [],
      attachedTabIds: [],
      startedAt: Date.now(),
      endedAt: null,
      revision: 0,
      // Set by the recorder's own HELLO: a finished injection does not show it is listening.
      attached: false,
      // Host lists are fixed for the whole recording; keywords apply as soon as they are added.
      policy: policyOf(settings),
      aliases: {},
      grantedPatterns: [pattern],
      redactions: {},
      webmcpTools: {},
      steps: []
    };
    const env = envOf([url], rec.policy);
    rec.startUrl = scrubUrl(url, { ...rec.policy, aliases: rec.aliases, keywords: settings.keywords, env }).url;
    addStep(rec, { type: 'navigate', pageUrl: url, source: 'unknown' }, settings, { tabUrl: url });
    try {
      if (previous?.state === 'recording') await stopTab(previous);
      await syncContentScripts(rec.grantedPatterns);
      await setBadge(true);
    } catch (error) {
      if (previous?.state !== 'recording') throw error;
      // stopTab may have ended it already, in part: do not leave it saved as still recording.
      return { save: { ...previous, state: 'stopped', endedAt: Date.now() }, reply: { ok: false, error: String(error?.message || error) } };
    }
    // After the save: the injected script asks at once whether this tab is recording.
    // A failed injection is not a failed start: the registered scripts still reach the next page.
    return { save: rec, reply: { ok: true }, after: () => injectNow(tabId) };
  });
}

async function stopTab(rec) {
  await syncContentScripts([]);
  await setBadge(false);
  await Promise.all(tabIdsOf(rec).map(async (tabId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { from: 'op-scribe/worker', type: 'OPS_STOP' });
    } catch { /* tab gone or never injected */ }
  }));
}

const stop = () => mutate(async (rec) => {
  if (!rec || rec.state !== 'recording') return { reply: { ok: true } };
  await stopTab(rec);
  rec.state = 'stopped';
  rec.endedAt = Date.now();
  return { save: rec, reply: { ok: true } };
});

const addPattern = (url, tabId) => mutate(async (rec) => {
  if (!rec || rec.state !== 'recording') return { reply: { ok: false, error: 'NOT_RECORDING' } };
  const targetTabId = Number.isInteger(tabId) ? tabId : rec.tabId;
  if (!isRecordingTab(rec, targetTabId) && !isPendingTab(rec, targetTabId)) {
    return { reply: { ok: false, error: 'NOT_RECORDING_TAB' } };
  }
  const pattern = originPattern(url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { reply: { ok: false, error: 'PERMISSION_DENIED' } };
  }
  if (!rec.grantedPatterns.includes(pattern)) {
    // As many sites as the alias table holds, no more (E2; review R43).
    if (rec.grantedPatterns.length >= LIMITS.aliases) return { reply: { ok: false, error: 'TOO_MANY_SITES' } };
    rec.grantedPatterns.push(pattern);
  }
  if (isPendingTab(rec, targetTabId)) {
    if (tabIdsOf(rec).length >= LIMITS.tabs) return { reply: { ok: false, error: 'TOO_MANY_TABS' } };
    rec.pendingTabIds = pendingTabIdsOf(rec).filter((id) => id !== targetTabId);
    rec.tabIds = [...tabIdsOf(rec), targetTabId];
    const settings = await getSettings();
    addStep(rec, { type: 'navigate', pageUrl: url, source: 'unknown' }, settings, { tabUrl: url });
  }
  await syncContentScripts(rec.grantedPatterns);
  return { save: rec, reply: { ok: true }, after: () => injectNow(targetTabId) };
});

async function adoptPermittedTab(tabId, url) {
  let pattern;
  try { pattern = originPattern(url); } catch { return false; }
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) return false;
  const result = await addPattern(url, tabId);
  return Boolean(result?.ok);
}

async function noticeChildTab(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.openerTabId)) return;
  const candidate = await mutate(async (rec) => {
    if (!isRecordingTab(rec, tab.openerTabId)) return { reply: false };
    if (isRecordingTab(rec, tab.id) || isPendingTab(rec, tab.id)) return { reply: true };
    if (tabIdsOf(rec).length + pendingTabIdsOf(rec).length >= LIMITS.tabs) return { reply: false };
    rec.pendingTabIds = [...pendingTabIdsOf(rec), tab.id];
    return { save: rec, reply: true };
  });
  // onCreated may have no URL. onUpdated will try again once Chrome supplies it.
  if (candidate && tab.url) await adoptPermittedTab(tab.id, tab.url);
}

/**
 * Origin as it appears in the recording (real if allowlisted, otherwise its alias), or null
 * for a site the recording does not hold (past the alias limit, K5).
 */
function siteOf(rec, settings, origin, aliases = { ...rec.aliases }) {
  const { url } = scrubUrl(`${origin}/`, { ...rec.policy, keywords: settings.keywords, aliases });
  if (url.length !== 1 || typeof url[0] !== 'string') return null;
  try { return new URL(url[0]).origin; } catch { return null; }
}

async function webmcpRequest(rec, sender, { op, args }) {
  if (!isRecordingTab(rec, sender.tab?.id)) return { reply: { ok: false, error: 'NOT_RECORDING' } };
  const settings = await getSettings();
  const site = siteOf(rec, settings, sender.origin);
  // A site past the alias limit is not recorded (K5): there is nothing to tell it or add from it.
  if (!site) return { reply: { ok: false, error: 'NOT_RECORDING' } };
  // Steps on other sites are never handed to this page; every answer goes through the final scan (W8, E6).
  const answer = webmcpReply(rec, settings, site, op);
  if (answer) return { reply: answer };
  if (op === 'expect') {
    const note = String(args?.text || '').trim();
    if (!note) return { reply: { ok: false, error: 'EMPTY_TEXT' } };
    // The note belongs to the page it came from, so only that site gets it back (W8, #17).
    const step = addStep(rec, { type: 'note', note, source: 'agent', pageUrl: sender.url || sender.tab?.url }, settings, fromOf(sender));
    // Past the limit of what the page may report, nothing is added (W7).
    if (!step) return { reply: { ok: false, error: 'NOT_RECORDED' } };
    // The note as the page's agent reads it: rendered with ‹…› labels, never [[…]] (E6, #28).
    const added = humanize(renderRuns(step.note));
    return { save: rec, reply: guardReply({ ok: true, added }, rec, settings) };
  }
  return { reply: { ok: false, error: 'UNKNOWN_OP' } };
}

// ------------------------------------------------------------------ messages

/** Where a content script message came from, as Chrome reports it (not as the page claims). */
const fromOf = (sender) => ({ tabUrl: sender.tab?.url, frameUrl: sender.url });

async function handle(message, sender) {
  const { type, detail = {} } = message;

  if (message.from === 'op-scribe/panel') {
    switch (type) {
      case 'START': return start(detail);
      case 'STOP': return stop();
      case 'ADD_ORIGIN': return addPattern(detail.url, detail.tabId);
      case 'CLEAR': return mutate(async (rec) => {
        if (rec?.state === 'recording') await stopTab(rec);
        return { remove: true, reply: { ok: true } };
      });
      case 'DELETE_STEP': return mutate(async (rec) => {
        if (!rec) return { reply: { ok: false } };
        rec.steps.splice(Number(detail.index), 1);
        rec.revision = (rec.revision || 0) + 1;
        return { save: rec, reply: { ok: true } };
      });
      case 'ADD_NOTE': return mutate(async (rec) => {
        if (!rec) return { reply: { ok: false, error: 'NO_RECORDING' } };
        addStep(rec, { type: 'note', note: String(detail.text || ''), kind: detail.kind }, await getSettings());
        return { save: rec, reply: { ok: true } };
      });
      default: return { ok: false, error: 'UNKNOWN' };
    }
  }

  if (message.from === 'op-scribe/content') {
    const tabId = sender.tab?.id;
    // In the queue, so a recorder of the recording that is ending never gets that recording's policy.
    if (type === 'HELLO') {
      const before = await getRecording();
      if (isPendingTab(before, tabId)) await adoptPermittedTab(tabId, sender.tab?.url || sender.url);
      return mutate(async (rec) => {
        if (!isRecordingTab(rec, tabId)) return { reply: { active: false } };
        const settings = await getSettings();
        const commercial = envOf([sender.tab?.url, sender.url], rec.policy) === 'commercial';
        const reply = { active: true, config: { commercial, keywords: settings.keywords } };
        if (attachedTabIdsOf(rec).includes(tabId)) return { reply };
        rec.attachedTabIds = [...attachedTabIdsOf(rec), tabId];
        if (tabId === rec.tabId) rec.attached = true;
        return { save: rec, reply };
      });
    }
    return mutate(async (rec) => {
      if (!isRecordingTab(rec, tabId)) return { reply: { ok: false, error: 'NOT_RECORDING' } };
      const settings = await getSettings();
      if (type === 'STEP') {
        addStep(rec, detail, settings, fromOf(sender));
        return { save: rec, reply: { ok: true } };
      }
      if (type === 'WEBMCP_TOOLS') {
        // The alias is kept: rec.webmcpTools is stored under it, and the next new site would take it otherwise.
        const site = siteOf(rec, settings, sender.origin, rec.aliases);
        // A site past the alias limit is not recorded (K5): neither are its tools.
        if (!site) return { reply: { ok: true } };
        // The payload holds tools for at most toolList sites (row W6).
        if (!Object.hasOwn(rec.webmcpTools, site) && Object.keys(rec.webmcpTools).length >= LIMITS.toolList) return { reply: { ok: true } };
        rec.webmcpTools[site] = (Array.isArray(detail.names) ? detail.names : []).slice(0, LIMITS.toolList)
          .map((n) => cleanLine(n, { keywords: settings.keywords, maxLength: LIMITS.tool }).runs);
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

chrome.tabs.onCreated.addListener(noticeChildTab);

// Navigations (including SPA history changes) in any tab owned by the recording.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const before = await getRecording();
  if (isPendingTab(before, tabId)) await adoptPermittedTab(tabId, changeInfo.url);
  await mutate(async (rec) => {
    if (!isRecordingTab(rec, tabId)) return null;
    const settings = await getSettings();
    const last = [...rec.steps].reverse().find((s) => s.type === 'navigate');
    const moved = (step) => !(last?.url && renderRuns(last.url) === renderRuns(step.url) && rec.steps[rec.steps.length - 1] === last);
    if (!addStep(rec, { type: 'navigate', pageUrl: changeInfo.url, source: 'unknown' }, settings, { tabUrl: changeInfo.url }, moved)) return null;
    return { save: rec };
  });
});

// A URL change cannot tell a new document from a same-document one, so a loaded page is asked.
// Only the recorder's HELLO sets attached; it is cleared here when no recorder answers.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const asked = await getRecording();
  if (!isRecordingTab(asked, tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { from: 'op-scribe/worker', type: 'OPS_PING' });
  } catch {
    await mutate(async (rec) => {
      if (rec?.id !== asked.id || !isRecordingTab(rec, tabId) || !attachedTabIdsOf(rec).includes(tabId)) return null;
      rec.attachedTabIds = attachedTabIdsOf(rec).filter((id) => id !== tabId);
      if (tabId === rec.tabId) rec.attached = false;
      return { save: rec };
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await mutate(async (rec) => {
    if (!rec || rec.state !== 'recording') return null;
    if (isPendingTab(rec, tabId)) {
      rec.pendingTabIds = pendingTabIdsOf(rec).filter((id) => id !== tabId);
      return { save: rec };
    }
    if (!isRecordingTab(rec, tabId)) return null;
    rec.tabIds = tabIdsOf(rec).filter((id) => id !== tabId);
    rec.attachedTabIds = attachedTabIdsOf(rec).filter((id) => id !== tabId);
    if (rec.tabIds.length) return { save: rec };
    await syncContentScripts([]);
    await setBadge(false);
    rec.state = 'stopped';
    rec.endedAt = Date.now();
    return { save: rec };
  });
});

// The session store is wiped when the browser restarts; so is the badge state.
chrome.runtime.onStartup.addListener(() => setBadge(false));
