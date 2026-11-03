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
const { policyOf, envOf, addStep, fitRecord, guardReply, webmcpReply, setVerdict, setRecordingText, endAt, countKinds } = self.OpScribeRecord;

const REC_KEY = 'opsRecording';
const SETTINGS_KEY = 'opsSettings';
const SCRIPT_IDS = { recorder: 'opscribe-recorder', webmcp: 'opscribe-webmcp' };

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

// The tabs a recording records (#40): the one it started in (tabId) and the ones the person added from
// the panel, and the tabs opened from them that wait to be added. Browser-only: never in the payload.
const tabsOf = (rec) => (Array.isArray(rec?.tabIds) ? rec.tabIds : (Number.isInteger(rec?.tabId) ? [rec.tabId] : []));
const waitingOf = (rec) => (Array.isArray(rec?.waitingTabIds) ? rec.waitingTabIds : []);
// Tabs opened from the recording whose first page Chrome has not given yet (window.open): the first one decides.
const openingOf = (rec) => (Array.isArray(rec?.openingTabIds) ? rec.openingTabIds : []);
const isRecordingTab = (rec, tabId) => rec?.state === 'recording' && tabsOf(rec).includes(tabId);
const isWaitingTab = (rec, tabId) => rec?.state === 'recording' && waitingOf(rec).includes(tabId);
const httpUrl = (url) => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };

// ------------------------------------------------------------------ actions

async function start({ tabId, url, scope, targetVersion }) {
  const pattern = originPattern(url);
  // Outside mutate, so this is the reply itself, not a { reply } for mutate to unwrap.
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: 'PERMISSION_DENIED' };
  }
  return mutate(async (previous) => {
    // Keywords added while this start waited apply to what it masks now (K2; ADR 0005).
    const settings = await getSettings();
    const rec = {
      id: newId(),
      state: 'recording',
      tabId,
      tabIds: [tabId],
      waitingTabIds: [],
      openingTabIds: [],
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
    // What the tester writes at the start, masked like a note (ADR 0005).
    setRecordingText(rec, 'scope', scope, settings);
    setRecordingText(rec, 'targetVersion', targetVersion, settings);
    addStep(rec, { type: 'navigate', pageUrl: url, source: 'unknown' }, settings, { tabUrl: url });
    try {
      if (previous?.state === 'recording') await stopTab(previous);
      await syncContentScripts(rec.grantedPatterns);
      await setBadge(true);
    } catch (error) {
      if (previous?.state !== 'recording') throw error;
      // stopTab may have ended it already, in part: do not leave it saved as still recording.
      return { save: { ...previous, state: 'stopped', endedAt: endAt(previous) }, reply: { ok: false, error: String(error?.message || error) } };
    }
    // After the save: the injected script asks at once whether this tab is recording.
    // A failed injection is not a failed start: the registered scripts still reach the next page.
    return { save: rec, reply: { ok: true }, after: () => injectNow(tabId) };
  });
}

async function stopTab(rec) {
  await syncContentScripts([]);
  await setBadge(false);
  await Promise.all(tabsOf(rec).map(async (tabId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { from: 'op-scribe/worker', type: 'OPS_STOP' });
    } catch { /* tab gone or never injected */ }
  }));
}

// What is typed into a field becomes a step on change or blur; the page commits it before the
// recording ends (#9). Outside the queue, which its step needs; never longer than FLUSH_MS.
const FLUSH_MS = 2000;
// The recording being flushed: a recorder that says hello meanwhile is not given its policy.
let stopping = null;
async function flushTab(rec) {
  let timer;
  try {
    // Every tab of the recording at once, all within the one FLUSH_MS.
    await Promise.race([
      Promise.all(tabsOf(rec).map((tabId) => chrome.tabs.sendMessage(tabId, { from: 'op-scribe/worker', type: 'OPS_FLUSH' }).catch(() => {}))),
      new Promise((resolve) => { timer = setTimeout(resolve, FLUSH_MS); })
    ]);
  } catch { /* tab gone or never injected */ } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops the recording the panel showed (recordingId, ADR 0005), with what the tester
 * did not test. Without recordingId it stops the one recording now, as before.
 */
const stop = async ({ recordingId, notTested } = {}) => {
  const rec = await getRecording();
  if (recordingId !== undefined && rec?.id !== recordingId) return { ok: false, reason: 'OTHER_RECORDING' };
  // Nothing to stop: a recording started meanwhile is not the one asked to stop.
  if (rec?.state !== 'recording') return { ok: true };
  stopping = rec.id;
  try {
    await flushTab(rec);
    // A recording started while this one was flushing is not the one asked to stop.
    return await stopNow(rec.id, notTested);
  } finally {
    if (stopping === rec.id) stopping = null;
  }
};

async function end(rec, notTested) {
  await stopTab(rec);
  rec.state = 'stopped';
  rec.endedAt = endAt(rec);
  setRecordingText(rec, 'notTested', notTested, await getSettings());
}

const stopNow = (id, notTested) => mutate(async (rec) => {
  if (!rec || rec.state !== 'recording' || rec.id !== id) return { reply: { ok: true } };
  await end(rec, notTested);
  return { save: rec, reply: { ok: true } };
});

/**
 * Lets the recording reach the site of url, in the tab tabId (the tab it started in when none
 * is named). A waiting tab joins the recording here, the person's choice in the panel, with the
 * page it is on (url) as a navigation (#40).
 */
const addPattern = (pageUrl, tabId) => mutate(async (rec) => {
  let url = pageUrl;
  if (!rec || rec.state !== 'recording') return { reply: { ok: false, error: 'NOT_RECORDING' } };
  const target = Number.isInteger(tabId) ? tabId : rec.tabId;
  const waiting = isWaitingTab(rec, target);
  if (!waiting && !isRecordingTab(rec, target)) return { reply: { ok: false, error: 'NOT_RECORDING_TAB' } };
  // A waiting tab joins at the page it is on now, not one the panel saw earlier (a redirect since).
  if (waiting) url = (await chrome.tabs.get(target).catch(() => null))?.url || url;
  if (!httpUrl(url)) return { reply: { ok: false, error: 'NOT_HTTP' } };
  const pattern = originPattern(url);
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { reply: { ok: false, error: 'PERMISSION_DENIED' } };
  }
  if (!rec.grantedPatterns.includes(pattern)) {
    // As many sites as the alias table holds, no more (E2; review R43).
    if (rec.grantedPatterns.length >= LIMITS.aliases) return { reply: { ok: false, error: 'TOO_MANY_SITES' } };
    rec.grantedPatterns.push(pattern);
  }
  if (waiting) {
    rec.waitingTabIds = waitingOf(rec).filter((id) => id !== target);
    rec.tabIds = [...tabsOf(rec), target];
    addStep(rec, { type: 'navigate', pageUrl: url, source: 'unknown' }, await getSettings(), { tabUrl: url });
  }
  await syncContentScripts(rec.grantedPatterns);
  await injectNow(target);
  return { save: rec, reply: { ok: true } };
});


/**
 * A tab opened from a tab of the recording to a page of the web (a link with target="_blank",
 * window.open) waits to join it; a tab opened any other way never does. What decides is the page the
 * tab opens to: one that starts at the browser's new tab page (Ctrl+T), even with an opener, is not a
 * candidate. A waiting tab joins only when the person adds it in the panel, with the page it is on
 * then, whether or not the extension can already reach the site (owner decisions on #72). Up to
 * LIMITS.tabs tabs at a time, waiting and opening ones included.
 */
async function noticeOpenedTab(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.openerTabId)) return;
  const given = tab.pendingUrl || tab.url;
  if (given && !httpUrl(given)) return;
  // Kept as opening first, in the queue, so its close and its first update are handled after this
  // whatever the order Chrome sends them in; its first page then decides (firstPage).
  const kept = await mutate(async (rec) => {
    if (!isRecordingTab(rec, tab.openerTabId) || isRecordingTab(rec, tab.id) || isWaitingTab(rec, tab.id) || openingOf(rec).includes(tab.id)) return { reply: false };
    if (tabsOf(rec).length + waitingOf(rec).length + openingOf(rec).length >= LIMITS.tabs) return { reply: false };
    rec.openingTabIds = [...openingOf(rec), tab.id];
    return { save: rec, reply: true };
  });
  if (!kept) return;
  // Chrome gives the page to open in url or pendingUrl, or only when asked (a link), or only in the
  // tab's first update (window.open), which firstPage handles when it comes.
  const asked = given ? null : await chrome.tabs.get(tab.id).catch(() => null);
  const url = given || asked?.pendingUrl || asked?.url;
  if (url) await firstPage(tab.id, url);
}

/** The first page of an opening tab: a page of the web makes it wait to join, anything else drops it (#72). */
const firstPage = (tabId, url) => mutate(async (rec) => {
  if (rec?.state !== 'recording' || !openingOf(rec).includes(tabId)) return null;
  rec.openingTabIds = openingOf(rec).filter((id) => id !== tabId);
  if (httpUrl(url)) rec.waitingTabIds = [...waitingOf(rec), tabId];
  return { save: rec };
});

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
    const { step, changed } = addStep(rec, { type: 'note', note, source: 'agent', pageUrl: sender.url || sender.tab?.url }, settings, fromOf(sender));
    // Past the limit of what the page may report, nothing is added (W7); the recording keeps its trimmed mark (ADR 0005).
    if (!step) return { ...(changed && { save: rec }), reply: { ok: false, error: 'NOT_RECORDED' } };
    // The note as the page's agent reads it: rendered with ‹…› labels, never [[…]] (E6, #28).
    const added = humanize(renderRuns(step.note));
    return { save: rec, reply: guardReply({ ok: true, added }, rec, settings) };
  }
  return { reply: { ok: false, error: 'UNKNOWN_OP' } };
}

// ------------------------------------------------------------------ messages

/** Where a content script message came from, as Chrome reports it (not as the page claims). */
const fromOf = (sender) => ({ tabUrl: sender.tab?.url, frameUrl: sender.url });

/**
 * The answer to a recorder that says hello: whether its tab is recorded, and how. In the queue, so a
 * recorder of the recording that is ending never gets that recording's policy. attached is about the
 * tab the recording started in, which the panel reports on.
 */
const hello = (tabId, sender) => mutate(async (rec) => {
  if (!isRecordingTab(rec, tabId) || rec.id === stopping) return { reply: { active: false } };
  const settings = await getSettings();
  const commercial = envOf([sender.tab?.url, sender.url], rec.policy) === 'commercial';
  // Which recording: every later message names it, so one sent for an earlier recording never lands in this one (#9).
  const reply = { active: true, config: { recording: rec.id, commercial, keywords: settings.keywords } };
  if (tabId !== rec.tabId || rec.attached) return { reply };
  rec.attached = true;
  return { save: rec, reply };
});

async function handle(message, sender) {
  const { type, detail = {} } = message;

  if (message.from === 'op-scribe/panel') {
    switch (type) {
      case 'START': return start(detail);
      case 'STOP': return stop(detail);
      // The tester's verdict on an expectation (ADR 0005): by the recording and the ref only.
      case 'SET_VERDICT': return mutate(async (rec) => {
        const reply = setVerdict(rec, detail, await getSettings());
        return reply.ok ? { save: rec, reply } : { reply };
      });
      case 'ADD_ORIGIN': return addPattern(detail.url, detail.tabId);
      case 'CLEAR': return mutate(async (rec) => {
        if (rec?.state === 'recording') await stopTab(rec);
        return { remove: true, reply: { ok: true } };
      });
      case 'DELETE_STEP': return mutate(async (rec) => {
        const index = detail?.index;
        // Only a step of the recording the panel showed (its id and revision, as the panel's basisOf
        // writes them): after another delete or a new step, the same index is another step.
        if (!rec || detail?.basis !== `${rec.id}@${rec.revision ?? 0}`) return { reply: { ok: false, error: 'STALE' } };
        // Only a number the recording has: splice() reads NaN, null, '' or [] as 0, the first step.
        if (!Number.isInteger(index) || index < 0 || index >= rec.steps.length) return { reply: { ok: false } };
        rec.steps.splice(index, 1);
        rec.revision = (rec.revision || 0) + 1;
        return { save: rec, reply: { ok: true } };
      });
      case 'ADD_NOTE': return mutate(async (rec) => {
        if (!rec) return { reply: { ok: false, error: 'NO_RECORDING' } };
        const { step, changed } = addStep(rec, { type: 'note', note: String(detail.text || ''), kind: detail.kind }, await getSettings());
        // A note a limit kept out still marks the recording trimmed (ADR 0005).
        if (!step) return { ...(changed && { save: rec }), reply: { ok: false, error: 'NOT_RECORDED' } };
        return { save: rec, reply: { ok: true } };
      });
      default: return { ok: false, error: 'UNKNOWN' };
    }
  }

  if (message.from === 'op-scribe/content') {
    const tabId = sender.tab?.id;
    // A waiting tab joins only from the panel (ADD_ORIGIN), never on a hello (#72).
    if (type === 'HELLO') return hello(tabId, sender);
    return mutate(async (rec) => {
      if (!isRecordingTab(rec, tabId) || message.recording !== rec.id) return { reply: { ok: false, error: 'NOT_RECORDING' } };
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
        // What masking the names needed is counted like any other field of the recording (M1).
        rec.webmcpTools[site] = (Array.isArray(detail.names) ? detail.names : []).slice(0, LIMITS.toolList).map((n) => {
          const r = cleanLine(n, { keywords: settings.keywords, maxLength: LIMITS.tool });
          countKinds(rec, r.kinds);
          return r.runs;
        });
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

chrome.tabs.onCreated.addListener(noticeOpenedTab);

// Navigations (including SPA history changes) in the tabs the recording records.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await mutate(async (rec) => {
    if (!isRecordingTab(rec, tabId)) return null;
    const settings = await getSettings();
    const last = [...rec.steps].reverse().find((s) => s.type === 'navigate');
    const moved = (step) => !(last?.url && renderRuns(last.url) === renderRuns(step.url) && rec.steps[rec.steps.length - 1] === last);
    // A navigation a limit kept out still marks the recording trimmed (ADR 0005): saved on any change.
    const { changed } = addStep(rec, { type: 'navigate', pageUrl: changeInfo.url, source: 'unknown' }, settings, { tabUrl: changeInfo.url }, moved);
    return changed ? { save: rec } : null;
  });
  // After the navigations of the recorded tabs, so none of theirs waits on this.
  await firstPage(tabId, changeInfo.url);
});

// A URL change cannot tell a new document from a same-document one, so a loaded page is asked.
// Only the recorder's HELLO sets attached; it is cleared here when no recorder answers.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const asked = await getRecording();
  // Every tab of the recording is asked, so a recorder that never got its answer says hello again (#72).
  if (!isRecordingTab(asked, tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { from: 'op-scribe/worker', type: 'OPS_PING' });
  } catch {
    await mutate(async (rec) => {
      if (rec?.id !== asked.id || !isRecordingTab(rec, tabId) || tabId !== rec.tabId || !rec.attached) return null;
      rec.attached = false;
      return { save: rec };
    });
  }
});

// A closed tab leaves the recording; the recording ends with its last tab (#40). Nothing to flush: the page is gone.
chrome.tabs.onRemoved.addListener((tabId) => mutate(async (rec) => {
  if (isWaitingTab(rec, tabId) || (rec?.state === 'recording' && openingOf(rec).includes(tabId))) {
    rec.waitingTabIds = waitingOf(rec).filter((id) => id !== tabId);
    rec.openingTabIds = openingOf(rec).filter((id) => id !== tabId);
    return { save: rec };
  }
  if (!isRecordingTab(rec, tabId)) return null;
  rec.tabIds = tabsOf(rec).filter((id) => id !== tabId);
  if (!rec.tabIds.length) await end(rec);
  return { save: rec };
}));

// The session store is wiped when the browser restarts; so is the badge state.
chrome.runtime.onStartup.addListener(() => setBadge(false));
