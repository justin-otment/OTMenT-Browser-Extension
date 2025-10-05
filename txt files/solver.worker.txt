// solver.worker.js
// MV3 service worker module for solving Cloudflare Turnstile and Google reCAPTCHA via 2Captcha.
// Import at top of background.js: import './solver.worker.js';

const DEBUG = true;

// --- 2Captcha endpoints ---
const API_BASE = 'https://2captcha.com';
const API_IN   = `${API_BASE}/in.php`;
const API_RES  = `${API_BASE}/res.php`;

// --- polling / timeout ---
const POLL_MIN_MS     = 3000;
const POLL_MAX_MS     = 5500;
const HARD_TIMEOUT_MS = 120000;

// Per-tab metadata we learn from network/iframes (Turnstile)
const cfChallengeMeta = new Map(); // tabId => { sitekey, cdata, rayId, pageUrl, ifUrl }

// Runtime state
const state = {
  apiKey: '',
  tasks: new Map(), // key => { promise, startedAt }
};

// Load API key at startup and keep it in sync
chrome.storage.local.get('solver_api_key', ({ solver_api_key }) => {
  state.apiKey = solver_api_key || '';
  dlog('[init] loaded apiKey?', !!state.apiKey);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.solver_api_key) {
    state.apiKey = changes.solver_api_key.newValue || '';
    dlog('[init] apiKey updated?', !!state.apiKey);
  }
});

async function createTurnstileProxylessTask({ sitekey, url }) {
  const params = new URLSearchParams({
    key: API_KEY,
    method: 'turnstile',
    sitekey,
    pageurl: url,
    json: 1
  });
  const res = await fetch(`${API_IN}?${params}`);
  const data = await res.json();
  if (data.status !== 1) throw new Error(`Failed to create task: ${JSON.stringify(data)}`);
  return data.request;
}


// --- Helpers ---
function sanitizePageUrl(input) {
  try {
    const u = new URL(input);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith('__cf_') || k.startsWith('cf_chl_')) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return input;
  }
}
function dlog(...args) { if (DEBUG) console.log('[solver.worker]', ...args); }
function wlog(...args) { if (DEBUG) console.warn('[solver.worker]', ...args); }
function redact(token) { if (!token || token.length < 8) return '***'; return token.slice(0, 4) + '...' + token.slice(-4); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(min + Math.random() * (max - min)); }

async function tabStillOnHost(tabId, originalUrl) {
  if (tabId == null) return true;
  try {
    const targetHost = new URL(originalUrl).hostname;
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return false;
    return new URL(tab.url).hostname === targetHost;
  } catch {
    return false;
  }
}

function assertApiKey() {
  if (!state.apiKey || typeof state.apiKey !== 'string' || state.apiKey.trim() === '') {
    throw new Error('Missing 2Captcha API key (storage.local.solver_api_key)');
  }
}

function taskKey(payload) {
  try {
    const host = new URL(payload.pageUrl).hostname;
    return `${host}|${payload.method}|${payload.sitekey}|${payload.rayId || ''}`;
  } catch {
    return `${payload.pageUrl}|${payload.method}|${payload.sitekey}|${payload.rayId || ''}`;
  }
}

// --- Capture Turnstile params from iframe URL ---
chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    const tabId = details.tabId;
    if (typeof tabId !== 'number' || tabId < 0) return;

    const meta = cfChallengeMeta.get(tabId) || {};

    // Match /rcv/<cdata>/<sitekey>/<pagedata>/
    const m = details.url.match(
      /\/turnstile\/if\/[^/]+\/[^/]+\/rcv\/([^/]+)\/(0x[0-9A-Za-z]+)\/([^/]+)\//
    );
    if (m) {
      const [, cdata, sitekey, pagedata] = m;
      meta.cdata    = cdata;
      meta.sitekey  = sitekey;
      meta.pagedata = pagedata;
      cfChallengeMeta.set(tabId, meta);
      dlog('[cfMeta] extracted Turnstile params', { sitekey, cdata, pagedata });
    }

    // Ray ID capture (optional)
    const rayMatch = details.url.match(/ray=([0-9a-f]{16})/i);
    if (rayMatch) {
      meta.rayId = rayMatch[1];
      cfChallengeMeta.set(tabId, meta);
      dlog('[cfMeta] rayId set from URL', meta.rayId);
    }
  },
  { urls: ['<all_urls>'] },
  ['extraHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.__solver || msg.type !== 'captcha:solve') return;

  if (msg.payload.method === 'turnstile' && sender.tab?.id != null) {
    const meta = cfChallengeMeta.get(sender.tab.id) || {};

    if (meta.sitekey   && !msg.payload.sitekey)   msg.payload.sitekey   = meta.sitekey;
    if (meta.cdata     && !msg.payload.cdata)     msg.payload.cdata     = meta.cdata;
    if (meta.pagedata  && !msg.payload.pagedata)  msg.payload.pagedata  = meta.pagedata;
    if (meta.action    && !msg.payload.action)    msg.payload.action    = meta.action;
    if (meta.rayId     && !msg.payload.rayId)     msg.payload.rayId     = meta.rayId;

    // Capture UA from the tab if not already set
    if (!msg.payload.userAgent) {
      msg.payload.userAgent = navigator.userAgent;
    }

    // Always prefer the real page URL over CF iframe URL
    const cand =
      !msg.payload.pageUrl || msg.payload.pageUrl.includes('challenges.cloudflare.com')
        ? (meta.pageUrl || sender.tab.url)
        : msg.payload.pageUrl;

    if (cand) {
      msg.payload.pageUrl = sanitizePageUrl(cand);
    }

    // Pass tabId through so create2CaptchaTask can inject into the right tab
    msg.payload.tabId = sender.tab.id;
  }

  solveCaptcha(msg.payload, sender)
    .then(token => sendResponse(token))
    .catch(err => {
      console.warn('[solver.worker] solve error:', err);
      sendResponse(null);
    });

  return true; // keep channel open for async
});

function waitForVisibleActive(selector, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null && !el.disabled) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for visible/active element: ${selector}`));
        return;
      }
      requestAnimationFrame(check);
    }

    check();
  });
}

// --- Optional: cleanup when extension is unloaded ---
self.addEventListener('beforeunload', () => {
  cfChallengeMeta.clear();
  state.tasks.clear();
  dlog('[solver.worker] cleared state on unload');
});

async function create2CaptchaTask(payload) {
  const {
    method,
    sitekey,
    pageUrl: rawPageUrl,
    action,
    cdata,
    pagedata,
    userAgent,
    tabId,
    version, min_score, variant, enterprise, dataS
  } = payload;

  // Ensure we never send a CF iframe URL
  let safeUrl = rawPageUrl;
  if (!safeUrl || safeUrl.includes('challenges.cloudflare.com')) {
    safeUrl = payload.metaPageUrl || payload.pageUrl || rawPageUrl;
  }
  const pageUrl = sanitizePageUrl(safeUrl);

  dlog('[solver] create2CaptchaTask payload', {
    method, sitekey, pageUrl, action, cdata, pagedata, userAgent, tabId
  });

  const params = new URLSearchParams();
  params.set('key',     state.apiKey);
  params.set('method',  method === 'turnstile' ? 'turnstile' : 'userrecaptcha');
  params.set(method === 'turnstile' ? 'sitekey' : 'googlekey', sitekey);
  params.set('pageurl', pageUrl);

  if (method === 'turnstile') {
    // Wait for the checkbox to be visible/active before proceeding
    if (tabId != null) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: waitForVisibleActive,
        args: ['.cb-lb input', 15000]
      });
    } else {
      throw new Error('No tabId provided for Turnstile wait');
    }

    // Required params
    if (typeof cdata === 'string' && cdata.trim()) {
      params.set('data', cdata.trim());
    } else {
      throw new Error('Missing required Turnstile cData');
    }

    if (typeof pagedata === 'string' && pagedata.trim()) {
      params.set('pagedata', pagedata.trim());
    } else {
      throw new Error('Missing required Turnstile pageData');
    }

    // Optional params
    if (typeof action === 'string' && action.trim()) {
      params.set('action', action.trim());
    }
    if (typeof userAgent === 'string' && userAgent.trim()) {
      params.set('userAgent', userAgent.trim());
    }

    dlog('[solver] including Turnstile params', {
      data: params.get('data'),
      pagedata: params.get('pagedata'),
      action: params.get('action'),
      userAgent: params.get('userAgent')
    });

  } else if (method === 'recaptcha') {
    if (version === 'v3') {
      params.set('version', 'v3');
      if (action)    params.set('action',    action);
      if (min_score) params.set('min_score', String(min_score));
    } else if (variant === 'invisible') {
      params.set('invisible', '1');
    }
    if (enterprise) params.set('enterprise', '1');
    if (dataS)      params.set('data-s',     dataS);
  } else {
    throw new Error(`Unsupported captcha method: ${method}`);
  }

  if (DEBUG) {
    const dbg = {};
    for (const [k, v] of params.entries()) dbg[k] = v;
    dlog('[solver] 2Captcha in.php body →', dbg);
  }

  const resp = await fetch(API_IN, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString()
  });
  const raw = (await resp.text()).trim();
  dlog('[solver] in.php raw →', raw);

  if (!raw.startsWith('OK|')) {
    throw new Error(`2Captcha in.php error: ${raw}`);
  }
  return raw.split('|', 2)[1];
}

// --- Core solve ---
async function solveCaptcha(payload, sender) {
  assertApiKey();

  if (payload.method === 'turnstile' && sender?.tab?.id != null) {
    const meta = cfChallengeMeta.get(sender.tab.id);
    if (!payload.sitekey && meta?.sitekey) payload.sitekey = meta.sitekey;
    if (!payload.pageUrl) {
      const candidate = meta?.pageUrl || sender.tab?.url;
      if (candidate && !candidate.includes('challenges.cloudflare.com')) {
        payload.pageUrl = sanitizePageUrl(candidate);
      }
    }
  }

  if (!payload.sitekey) throw new Error('Missing sitekey for captcha task');
  if (!payload.pageUrl) throw new Error('Missing pageUrl for captcha task');

  // ✅ If pageUrl is still CF iframe, fallback to meta.pageUrl if we have it
  if (payload.pageUrl.includes('challenges.cloudflare.com')) {
    const fixed = cfChallengeMeta.get(sender?.tab?.id)?.pageUrl;
    if (fixed) {
      dlog('[solver] fixed iframe pageUrl ->', fixed);
      payload.pageUrl = sanitizePageUrl(fixed);
    } else {
      throw new Error(`Invalid pageUrl for 2Captcha: ${payload.pageUrl}`);
    }
  }

  const k = taskKey(payload);
  if (state.tasks.has(k)) {
    dlog('join in-flight task', k);
    return state.tasks.get(k).promise;
  }

  const prom = (async () => {
    const id = await create2CaptchaTask(payload);
    const token = await pollForSolution(id, payload, sender);
    return token;
  })();

  state.tasks.set(k, { promise: prom, startedAt: Date.now() });
  try {
    return await prom;
  } finally {
    state.tasks.delete(k);
  }
}

// inside solver-worker.js

// helper to reload a tab and wait for it to finish loading
function reloadTabAndWait(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;

    // listener for tab update
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    }

    // timeout guard
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for tab ${tabId} to reload`));
    }, timeoutMs);

    function cleanup() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
    }

    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.reload(tabId);
  });
}

async function pollForSolution(id, payload, sender) {
  const tabId = sender?.tab?.id;
  const startTime = () => Date.now();
  let started = startTime();
  let attempts = 0;
  let didReload = false;

  // Track tab removal/cancellation
  let tabClosed = false;
  const onTabRemoved = (closedTabId) => {
    if (closedTabId === tabId) {
      tabClosed = true;
    }
  };
  chrome.tabs.onRemoved.addListener(onTabRemoved);

  try {
    for (;;) {
      attempts++;
      await sleep(jitter(POLL_MIN_MS, POLL_MAX_MS));

      // Stop if tab closed or navigated away
      if (tabClosed || !(await tabStillOnHost(tabId, payload.pageUrl))) {
        wlog(`[solver] Tab ${tabId} navigated away or closed, cancelling solve`);
        return null; // gracefully exit instead of throwing
      }

      const url = `${API_RES}?key=${encodeURIComponent(state.apiKey)}&action=get&id=${encodeURIComponent(id)}`;
      let text;
      try {
        const resp = await fetch(url);
        text = (await resp.text()).trim();
      } catch (err) {
        wlog(`poll attempt #${attempts} failed (network)`, err);
        continue;
      }

      if (text.startsWith('OK|')) {
        const token = text.split('|', 2)[1];
        dlog(`solution received after ${attempts} polls`, redact(token));
        return token;
      }

      if (text === 'CAPCHA_NOT_READY') {
        dlog(`poll #${attempts}: still solving…`);
      } else {
        switch (text) {
          case 'ERROR_WRONG_USER_KEY':
            throw new Error('2Captcha: invalid API key');
          case 'ERROR_ZERO_BALANCE':
            throw new Error('2Captcha: insufficient balance');
          case 'ERROR_BAD_PARAMETERS':
            throw new Error('2Captcha: bad request parameters');
          case 'ERROR_NO_SLOT_AVAILABLE':
            wlog('2Captcha: no workers available, retrying...');
            break;
          default:
            throw new Error(`2Captcha res.php error: ${text}`);
        }
      }

      // On overall timeout, reload + retry once
      if (Date.now() - started > HARD_TIMEOUT_MS) {
        if (tabId != null && !didReload) {
          wlog(`[solver] polling timed out after ${attempts} attempts; reloading tab ${tabId} and retrying`);
          didReload = true;
          await reloadTabAndWait(tabId);
          started = startTime();
          attempts = 0;
          continue;
        }
        throw new Error(`captcha solve timeout after ${attempts} polls`);
      }
    }
  } finally {
    // Cleanup listener
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
  }
}

// --- Optional: cleanup when tabs are removed ---
chrome.tabs.onRemoved.addListener(tabId => {
  if (cfChallengeMeta.has(tabId)) {
    cfChallengeMeta.delete(tabId);
    dlog('[cfMeta] cleaned up for closed tab', tabId);
  }
});

// --- End of solver-worker.js ---