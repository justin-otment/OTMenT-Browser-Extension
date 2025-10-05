// background.js
// Chrome MV3 service worker ("type": "module" in manifest.json")
// @ts-nocheck
// --- 2Captcha solver integration ---
import './solver.worker.js';

import {
  importKeyFromPem,
  signRS256,
  sha256Hex,
} from './crypto-utils.js';
import { genSigningKey } from './crypto-utils.js';

// At top of background.js
const urlRetries = new Map();
const rateLimitRetries = new Map();

// ---- FLEXIBLE REQUEST QUEUE ----
class RequestQueue {
  /**
   * @param {Object} [cfg] Optional config object. Example: { fastMode: true }
   */
  constructor(cfg = null) {
    // Use passed config, else fallback to global config, else default
    const effectiveConfig =
      cfg || (typeof config !== "undefined" ? config : { fastMode: false });

    const isFast = effectiveConfig.fastMode === true;

    this.queue = [];
    this.activeCount = 0;
    this.concurrency = isFast ? 10 : 3;
    this.baseDelay = isFast ? 300 : 1500;
    this.dynamicDelay = this.baseDelay;
    this.capDelay = isFast ? 5000 : 15000;
    this.paused = false;

    console.log(
      `📌 RequestQueue initialized — concurrency=${this.concurrency}, baseDelay=${this.baseDelay}ms, cap=${this.capDelay}ms`
    );
  }

  setDelay(ms) {
    this.dynamicDelay = Math.min(ms, this.capDelay);
  }

  pause(reason = "Server busy") {
    if (this.paused) return; // already paused
    this.paused = true;
    console.warn(
      `⏸ Queue paused: ${reason} — resuming in ${this.dynamicDelay}ms`
    );
    setTimeout(() => {
      console.log(`▶ Queue resumed`);
      this.paused = false;
      this._next();
    }, this.dynamicDelay);
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._next();
    });
  }

  async _next() {
    if (
      this.activeCount >= this.concurrency ||
      this.queue.length === 0 ||
      this.paused
    )
      return;

    const { fn, resolve, reject } = this.queue.shift();
    this.activeCount++;

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }

    this.activeCount--;
    setTimeout(() => this._next(), this.dynamicDelay);
  }
}

// --- USAGE EXAMPLES ---

// 1️⃣ Using explicit config
const requestQueue1 = new RequestQueue({ fastMode: true });

// 2️⃣ Using global config (if exists)
const config = { fastMode: false };
const requestQueue2 = new RequestQueue();

// 3️⃣ Without any config (defaults to normal speeds)
const requestQueue3 = new RequestQueue();

// Example request
requestQueue1.add(async () => {
  console.log("⏳ Running request...");
  return "done";
}).then(console.log);

//_____________________________________

let rsaPrivateKey;
let serviceAccount;
let keyPair = null;
const seen = new Set();

// --- globals & imports
const cfChallengeMeta = new Map();

let globalCooldownUntil = 0; // timestamp in ms

// Helper: delay with Promise
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: set global cooldown
function setGlobalCooldown(ms, reason = "Unknown") {
  const until = Date.now() + ms;
  if (until > globalCooldownUntil) {
    globalCooldownUntil = until;
    console.warn(`⏸ Global cooldown triggered for ${ms}ms (${reason})`);
  }
}

// Helper: wait if global cooldown is active
async function maybeWaitForCooldown() {
  const now = Date.now();
  if (now < globalCooldownUntil) {
    const waitMs = globalCooldownUntil - now;
    console.log(`⏳ Waiting ${waitMs}ms due to active cooldown...`);
    await delay(waitMs);
  }
}

// Attach listener for outgoing requests
chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    const headers = details.requestHeaders
      ? Object.fromEntries(details.requestHeaders.map(h => [h.name.toLowerCase(), h.value]))
      : {};

    // Detect Turnstile requests
    const isCfTurnstile =
      headers['origin'] === 'https://challenges.cloudflare.com' &&
      headers['referer']?.includes('/cdn-cgi/challenge-platform/') &&
      headers['content-type']?.startsWith('text/plain');

    // Store Turnstile sitekey & iframe URL if detected
    if (typeof details.tabId === 'number' && details.tabId >= 0) {
      if (/\/turnstile\/if\//.test(details.url)) {
        console.warn(`⚠️ Turnstile detected on tab ${details.tabId}`);
        
        chrome.runtime.sendNativeMessage(
          "ahk.host",
          { action: "callAHK" },
          (resp) => {
            console.log("AHK script triggered:", resp);
          }
        );
      }


      // Store Ray ID if found in URL
      if (/ray=/.test(details.url)) {
        const u = new URL(details.url);
        const meta = cfChallengeMeta.get(details.tabId) || {};
        meta.rayId = u.searchParams.get('ray');
        cfChallengeMeta.set(details.tabId, meta);

        console.log(`🔎 Captured CF Ray ID for tab ${details.tabId}: ${meta.rayId}`);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// Attach listener for completed responses — detect 429s & Retry-After
chrome.webRequest.onCompleted.addListener(
  details => {
    if (details.statusCode === 429) {
      console.warn(`🚫 429 Too Many Requests detected on ${details.url}`);
    }

    // Check for Retry-After header (not always provided, but if it is, obey it)
    if (details.responseHeaders) {
      const retryAfter = details.responseHeaders.find(
        h => h.name.toLowerCase() === 'retry-after'
      );
      if (retryAfter) {
        const retryMs = isNaN(retryAfter.value)
          ? 30_000 // fallback if non-numeric value
          : Number(retryAfter.value) * 1;

        console.warn(`⏳ Server requested retry-after: ${retryMs}ms`);
        setGlobalCooldown(retryMs, "Retry-After header");
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ─────────────────────────────────────────────
// Message bridge for retrieving stored metadata
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.__solverGetTurnstileMeta) {
    if (sender.tab && typeof sender.tab.id === 'number' && sender.tab.id >= 0) {
      sendResponse(cfChallengeMeta.get(sender.tab.id) || null);
    } else {
      sendResponse(null);
    }
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "reloadSelf") {
        chrome.management.setEnabled(chrome.runtime.id, false, () => {
            chrome.management.setEnabled(chrome.runtime.id, true, () => {
                sendResponse({ success: true });
            });
        });
        return true; // Keeps sendResponse alive
    }
});

async function handleVignette(tabId) {
  try {
    // Step 1: Fix URL if #google_vignette is present
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.location.href
    });
    let currentUrl = res.result;
    if (currentUrl.includes("#google_vignette")) {
      const cleanUrl = currentUrl.split("#")[0];
      await chrome.tabs.update(tabId, { url: cleanUrl });
      await waitForTabComplete(tabId);
      console.log("✅ Reloaded without vignette hash");
    }

    // Step 2: Try to detect vignette iframe / close button
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const iframe = document.querySelector('iframe[src*="google_vignette"]');
        if (iframe) {
          const closeBtn =
            iframe.contentDocument?.querySelector('div[role="button"], button[aria-label*="Close"]');
          if (closeBtn) {
            closeBtn.click();
            return "closed";
          }
        }
        return "none";
      }
    });
  } catch (err) {
    console.log("ℹ️ No vignette handling needed:", err.message);
  }
}

// ─────────────────────────────────────────────
// Export cooldown-aware delay function for scrapers
async function safeDelay(ms) {
  // First respect any global cooldown
  await maybeWaitForCooldown();
  // Then apply your normal per-request delay
  await delay(ms);
}

// ─────────────────────────────
// Fibonacci delay system (no repeats per session, auto fastMode)
let fibDelayPool = null;         // current pool
const usedFibDelays = new Set(); // tracks all used delays globally

/**
 * Generate a Fibonacci sequence up to a maximum value.
 * Each value is scaled by `scale` for finer control.
 */
function generateFibonacci(max, scale = 1) {
  const fib = [1, 1];
  while (true) {
    const next = fib[fib.length - 1] + fib[fib.length - 2];
    if (next * scale > max) break;
    fib.push(next);
  }
  return fib.map(n => n * scale);
}

/**
 * Initialize or reset the Fibonacci delay pool.
 * In fastMode we shrink the maximum delay automatically.
 */
function initFibDelayPool() {
  const isFast = (typeof config !== "undefined" && config.fastMode === true);

  // fallback if config not loaded yet
  const fibConfig = (typeof config !== "undefined" && config.requestOptions?.fibDelays)
    ? config.requestOptions.fibDelays
    : { max: 10000, scale: 1 };

  const { max = 10000, scale = 1 } = fibConfig;
  const effectiveMax = isFast ? 2000 : max;

  fibDelayPool = generateFibonacci(effectiveMax, scale);

  // Shuffle for randomness
  for (let i = fibDelayPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fibDelayPool[i], fibDelayPool[j]] = [fibDelayPool[j], fibDelayPool[i]];
  }

  console.log(
    `📌 Fibonacci pool initialized — max=${effectiveMax}ms, scale=${scale}, fastMode=${isFast}`
  );
}

/**
 * Return a Fibonacci-based delay.
 * Guarantees no repeats in the current session.
 * Auto-resets the pool if exhausted, skipping already-used values.
 */
function getFibDelay() {
  if (!fibDelayPool || fibDelayPool.length === 0) {
    console.warn('Fibonacci pool exhausted, reinitializing...');
    initFibDelayPool();
  }

  while (fibDelayPool.length) {
    const delay = fibDelayPool.pop();
    if (!usedFibDelays.has(delay)) {
      usedFibDelays.add(delay);
      return delay;
    }
  }

  // All values used → reset
  console.warn('All unique Fibonacci delays have been used, resetting session history...');
  usedFibDelays.clear();
  initFibDelayPool();
  return getFibDelay(); // retry after reset
}

/**
 * Manual reset of the Fibonacci delay pool and used delays.
 */
function resetFibDelayPool() {
  fibDelayPool = null;
  usedFibDelays.clear();
}

// ─────────────────────────────
// Default error patterns
const defaultErrorPatterns = {
  noResults: ['no results found', 'nothing matched', 'no listings found'],
  captcha: ['g-recaptcha', 'turnstile', 'captcha', 'bot-check'],
  rateLimit: ['rate limit', 'too many requests', 'temporarily blocked']
};

// Global solver lock to avoid race conditions
globalThis.solverLock = null;

// Track retries per row
const rowRetries = new Map();

async function handleTimeoutError(tabId, row, opts = {}) {
  const { heartbeat = false, lastError = '', url = '' } = opts;
  let text = '';

  // Track retries per URL (generic retries)
  let retries = 0;
  if (url) {
    retries = (urlRetries.get(url) || 0) + 1;
    urlRetries.set(url, retries);
  }

  // Grab diagnostic text safely
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        (document.body?.innerText || document.documentElement?.innerText || '').slice(0, 20000)
    });
    text = result || '';
  } catch (err) {
    console.warn(`[Row ${row}] Failed to grab page text:`, err);
  }

  const patterns = config?.errorPatterns || defaultErrorPatterns;
  const noRe   = new RegExp(patterns.noResults.join('|'), 'i');
  const capRe  = new RegExp(patterns.captcha.join('|'), 'i');
  const rateRe = new RegExp(patterns.rateLimit.join('|'), 'i');

  console.warn(`🧪 [Row ${row}] Error snapshot (first 5k chars):`, text.slice(0, 500));

  // 1) No results → skip
  if (noRe.test(text)) {
    console.warn(`⚪ [Row ${row}] detected NO_RESULTS – skipping`);
    await chrome.tabs.remove(tabId).catch(() => {});
    if (url) { urlRetries.delete(url); rateLimitRetries.delete(url); }
    return 'skip';
  }

  // 2) Captcha / challenge → retry via solver lock
  if (capRe.test(text)) {
    console.warn(`🚧 [Row ${row}] CAPTCHA detected`);
    ensureSolverLock();
    return 'retry';
  }

  // 3) 429 / rate-limit → exponential backoff + global/site signaling
  if (rateRe.test(text) || /(^|[^0-9])429([^0-9]|$)/.test(String(lastError))) {
    const rl = (rateLimitRetries.get(url) || 0) + 1;
    rateLimitRetries.set(url, rl);

    // Exponential backoff: 30s → 60s → 120s → … (60_000cap 5m)
    const backoffMs = Math.min(15_000 * Math.pow(2, rl - 1), 150_000);

    // Signal globally & pause queue briefly
    setGlobalCooldown(Math.max(backoffMs, ), "Hit 429 rate-limit");
    if (typeof requestQueue?.pause === 'function') {
      // Let the queue breathe while cooldown is in effect
      requestQueue.setDelay(Math.min(Math.max(requestQueue.dynamicDelay * 2, 1500), 10000));
      requestQueue.pause("HTTP 429 Too Many Requests");
    }

    console.warn(`🐌 [Row ${row}] RATE_LIMIT → waiting ${Math.round(backoffMs / 1000)}s then retry`);
    await chrome.tabs.remove(tabId).catch(() => {});
    await safeDelay(backoffMs); // respects global cooldown internally
    return 'retry';
  }

  // 4) Selector timeout → Fibonacci backoff
  if (lastError?.toLowerCase()?.includes('timeout waiting for any selector')) {
    console.warn(`⏱ [Row ${row}] Selector timeout → Fibonacci backoff`);
    ensureSolverLock();
    await safeDelay(getFibDelay());
    return 'skip';
  }

  // 5) Cloudflare / Turnstile metadata hints
  const meta = cfChallengeMeta.get(tabId) || {};
  if (meta.sitekey || meta.rayId) {
    console.warn(`🚧 [Row ${row}] Likely CAPTCHA (sitekey=${meta.sitekey || 'n/a'}, rayId=${meta.rayId || 'n/a'})`);
    ensureSolverLock();
    return 'retry';
  }

  // 6) Empty body → slow retry
  if (!text.trim()) {
    console.warn(`🌫️ [Row ${row}] Empty body → retry after 30s`);
    await safeDelay(15_000);
    return 'skip';
  }

  // 7) Unclassified → bounded retries (generic)
  if (retries < 1) {
    const wait = getFibDelay() * 1;
    console.warn(`🔄 [Row ${row}] Unclassified timeout → retry ${retries}/${MAX_TOTAL_RETRIES} after ${wait}ms`);
    await safeDelay(wait);
    return 'retry';
  }

  // 8) Final give up
  console.warn(`⚠️ [Row ${row}] Final timeout — skipping permanently`);
  await chrome.tabs.remove(tabId).catch(() => {});
  if (url) { urlRetries.delete(url); rateLimitRetries.delete(url); }
  return 'skip';
}

// ─────────────────────────────
// Ensure a single solverLock exists globally
function ensureSolverLock(timeoutMs = 120_000) {
  if (!globalThis.solverLock) {
    let releaseFn;

    const lock = new Promise(resolve => {
      releaseFn = () => {
        if (globalThis.solverLock === lock) {
          globalThis.solverLock = null;
        }
        resolve(); // <- resolves the lock
      };
    });

    // Attach the release function
    lock.release = releaseFn;

    // Auto-release after timeout to avoid deadlocks
    setTimeout(() => {
      if (globalThis.solverLock === lock) {
        console.warn("⚠️ Solver lock timed out, auto-releasing");
        lock.release();
      }
    }, timeoutMs);

    globalThis.solverLock = lock;
  }

  return globalThis.solverLock;
}

function toColumnLetter(num) {
  let s = '', n = num;
  while (n > 0) {
    let m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Configurable options (tweak if desired)
const NAME_SIM_OPTIONS = {
  dropSingleLetterTokens: true,   // remove middle initials like "J"
  useTokenOverlapWeight: 0.55,    // weight for token overlap
  useFullStringWeight: 0.35,      // weight for full-string similarity
  useFirstLastBoost: 0.10         // small boost if first/last tokens align
};

// Memory-efficient Levenshtein (two-row) - returns integer edit distance
function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;

  // Ensure b is the shorter one to minimize row length
  if (n < m) [a, b] = [b, a];

  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    // copy cur -> prev for next iteration (faster than swapping refs in some environments)
    for (let k = 0; k <= b.length; k++) prev[k] = cur[k];
  }
  return prev[b.length];
}

// Stronger normalization for name comparison
function _normalizeForName(s) {
  if (!s) return '';
  // keep unicode letters and spaces only, replace other chars with spaces
  const cleaned = String(s)
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const toks = cleaned.split(' ').filter(t => t.length);
  if (NAME_SIM_OPTIONS.dropSingleLetterTokens) {
    return toks.filter(t => t.length > 1).join(' ');
  }
  return toks.join(' ');
}

// Token list helper
function _nameTokens(s) {
  const n = _normalizeForName(s);
  return n ? n.split(' ') : [];
}

// Backwards-compatible similarity: returns 0..1 where 1 is exact
// Enhanced: combines normalized full-string similarity with token-overlap and first/last heuristics
function similarity(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();

  // If either is empty, fallback to simple behavior
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const aNorm = _normalizeForName(a);
  const bNorm = _normalizeForName(b);

  // Short-circuit exact normalized match
  if (aNorm && aNorm === bNorm) return 1;

  // Full-string similarity (based on normalized strings)
  const maxLen = Math.max(aNorm.length, bNorm.length);
  const fullSim = maxLen ? 1 - levenshtein(aNorm, bNorm) / maxLen : 0;

  // Token-level overlap
  const aT = _nameTokens(a);
  const bT = _nameTokens(b);
  const aSet = new Set(aT);
  let common = 0;
  for (const t of bT) if (aSet.has(t)) common++;
  const tokenOverlap = (aT.length + bT.length) ? (2 * common) / (aT.length + bT.length) : 0;

  // First/last token heuristic (helps with transposed first/last)
  const firstLastMatch =
    (aT.length && bT.length &&
      (aT[0] === bT[0] || aT[aT.length - 1] === bT[bT.length - 1] ||
       aT[0] === bT[bT.length - 1] || aT[aT.length - 1] === bT[0])) ? 1 : 0;

  // Weighted combination
  const score =
    (NAME_SIM_OPTIONS.useTokenOverlapWeight * tokenOverlap) +
    (NAME_SIM_OPTIONS.useFullStringWeight * fullSim) +
    (NAME_SIM_OPTIONS.useFirstLastBoost * firstLastMatch);

  // Clamp to 0..1
  return Math.max(0, Math.min(1, score));
}

// ─────────────────────────────
// Normalize hrefs
function normalizeHrefs(rawHrefs = [], baseUrl = '') {
  if (!Array.isArray(rawHrefs)) return [];
  const out = [];
  for (const raw of rawHrefs) {
    if (typeof raw !== 'string') continue;
    const href = raw.trim();
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (abs.startsWith('http')) out.push(abs);
    } catch {
      console.warn('Skipping invalid href:', href);
    }
  }
  return out;
}

// helper: wait for a tab to reach “complete” status (no timeout)
async function waitForTabComplete(tabId) {
  return new Promise(resolve => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// helper: poll for any one of a list of selectors in a frame
async function waitForAnySelector(tabId, selectors, timeout) {

  // ⬇️ Handle vignette overlays before scraping
  await handleVignette(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sels, to) => {
      return new Promise((resolve, reject) => {
        let done = false;
        const observers = [];
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            observers.forEach(mo => mo.disconnect());
            reject(new Error(`Timeout waiting for selectors: ${sels.join(', ')}`));
          }
        }, to);

        function checkAll() {
          for (const sel of sels) {
            if (document.querySelector(sel)) {
              return sel;
            }
          }
          return null;
        }

        const first = checkAll();
        if (first) {
          clearTimeout(timer);
          resolve(first);
          return;
        }

        for (const sel of sels) {
          const mo = new MutationObserver(() => {
            if (done) return;
            const found = document.querySelector(sel);
            if (found) {
              done = true;
              clearTimeout(timer);
              observers.forEach(o => o.disconnect());
              resolve(sel);
            }
          });
          mo.observe(document, { childList: true, subtree: true });
          observers.push(mo);
        }
      });
    },
    args: [selectors, timeout]
  });

  return result;
}

// ───────────────────────────────────────────────────────────
// Follow detail links and scrape, with solver integration (robust)
async function followAndScrapeDetail(url, row) {
  // Helpers
  const isTabAlive = async (id) => {
    try { return !!(await chrome.tabs.get(id)); }
    catch { return true; }
  };

  const safeRemoveTab = async (id) => {
    if (!id) return;
    try { await chrome.tabs.remove(id); } catch {}
  };

  const SELECTORS = [
    '.list-results-header strong',
    '.no-results-message',
    '.error-message'
  ];

  // 1) Ensure absolute URL
  if (!/^https?:\/\//i.test(url)) {
    try { url = new URL(url, config.baseUrl).href; }
    catch { throw new Error(`[row ${row}] Invalid detail URL: ${url}`); }
  }

  let tabId = null;
  try {
    // 2) Backoff before opening
    await delay(getFibDelay());

    // 3) Create tab + attach network logging
    const created = await chrome.tabs.create({ url, active: false });
    tabId = created?.id;
    if (!tabId) throw new Error(`[row ${row}] Failed to create detail tab`);
    attachCfNetworkLoggingForTab(tabId);

    // 4) Wait for load (with timeout + retry via handleTimeoutError)
    try {
      await waitForTabComplete(tabId, 45_000);
    } catch (e) {
      if (!(await isTabAlive(tabId))) throw new Error(`[row ${row}] No tab with id: ${tabId}`);
      const action = await handleTimeoutError(tabId, row, { lastError: e?.message || 'waitForTabComplete timeout', heartbeat: true });
      if (action === 'retry') {
        await waitForTabComplete(tabId, 120_000);
      } else {
        throw new Error(`[row ${row}] Detail solve skipped after load wait`);
      }
    }

    // 5) Sanity: ensure not on extension page
    {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.url?.startsWith('chrome-extension://')) {
        throw new Error(`[row ${row}] Invalid target URL (extension context): ${active.url}`);
      }
    }

    // 6) Backoff before probing frames
    await delay(getFibDelay());
    if (!(await isTabAlive(tabId))) throw new Error(`[row ${row}] No tab with id: ${tabId}`);

    // 7) Probe frames for challenges
    let mergedFlags = {
      bodyText: false,
      challengeForm: false,
      cfVerify: false,
      grecaptcha: false,
      turnstileDiv: false,
      challengeIframe: false
    };

    try {
      const frameResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const text = document.body?.innerText || '';
          const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src || '');
          return {
            bodyText: /are you human\?/i.test(text),
            challengeForm: !!document.querySelector('#challenge-form'),
            cfVerify: !!document.querySelector('.cf-browser-verification'),
            grecaptcha: !!document.querySelector('.g-recaptcha'),
            turnstileDiv: !!document.querySelector('div[data-sitekey][class*="turnstile"]'),
            challengeIframe: iframes.some(src =>
              /challenges\.cloudflare\.com/i.test(src) ||
              /\/cdn-cgi\/challenge-platform\//i.test(src)
            )
          };
        }
      });

      for (const fr of frameResults) {
        const f = fr?.result || {};
        mergedFlags.bodyText        ||= !!f.bodyText;
        mergedFlags.challengeForm   ||= !!f.challengeForm;
        mergedFlags.cfVerify        ||= !!f.cfVerify;
        mergedFlags.grecaptcha      ||= !!f.grecaptcha;
        mergedFlags.turnstileDiv    ||= !!f.turnstileDiv;
        mergedFlags.challengeIframe ||= !!f.challengeIframe;
      }

      console.log(`[row ${row}] Detail probe flags:`, mergedFlags);
    } catch (err) {
      console.warn(`[row ${row}] Frame probe failed:`, err);
    }

    // 8) Handle detected challenges
    if (Object.values(mergedFlags).some(Boolean)) {
      await delay(getFibDelay());
      if (!(await isTabAlive(tabId))) throw new Error(`[row ${row}] No tab with id: ${tabId}`);

      // Use existing solver flow
      const action = await handleTimeoutError(tabId, row, { heartbeat: true });
      if (action === 'retry') {
        await waitForTabComplete(tabId, 120_000);
      } else {
        throw new Error(`[row ${row}] Detail solve skipped`);
      }
    }

    // 9) Wait for final selectors (with timeout & retry via handleTimeoutError)
    await delay(getFibDelay());
    if (!(await isTabAlive(tabId))) throw new Error(`[row ${row}] No tab with id: ${tabId}`);

    let waitedSel;
    try {
      // Prefer your existing helper if you have it:
      // waitedSel = await waitForAnySelector(tabId, SELECTORS, 15_000);
      // If not, do a timed wait in the page:
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sels, timeout) => new Promise((resolve, reject) => {
          let settled = false;
          const observers = [];
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              observers.forEach(mo => mo.disconnect());
              reject(new Error(`Timeout waiting for any selector: ${sels.join(', ')}`));
            }
          }, timeout);

          // immediate check
          for (const sel of sels) {
            if (document.querySelector(sel)) {
              settled = true;
              clearTimeout(timer);
              observers.forEach(mo => mo.disconnect());
              resolve(sel);
              return;
            }
          }

          // observe DOM
          sels.forEach(sel => {
            const mo = new MutationObserver(() => {
              const el = document.querySelector(sel);
              if (el && !settled) {
                settled = true;
                clearTimeout(timer);
                observers.forEach(mo => mo.disconnect());
                resolve(sel);
              }
            });
            mo.observe(document, { childList: true, subtree: true });
            observers.push(mo);
          });
        }),
        args: [SELECTORS, 15_000]
      });
      waitedSel = result;
    } catch (e) {
      const action = await handleTimeoutError(tabId, row, { lastError: e?.message || 'selector timeout' });
      if (action === 'retry') {
        await waitForTabComplete(tabId, 120_000);
        // one more bounded wait attempt after retry
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sels, timeout) => new Promise((resolve, reject) => {
            let settled = false;
            const observers = [];
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true;
                observers.forEach(mo => mo.disconnect());
                reject(new Error(`Timeout waiting for any selector: ${sels.join(', ')}`));
              }
            }, timeout);

            for (const sel of sels) {
              if (document.querySelector(sel)) {
                settled = true;
                clearTimeout(timer);
                observers.forEach(mo => mo.disconnect());
                resolve(sel);
                return;
              }
            }
            sels.forEach(sel => {
              const mo = new MutationObserver(() => {
                const el = document.querySelector(sel);
                if (el && !settled) {
                  settled = true;
                  clearTimeout(timer);
                  observers.forEach(mo => mo.disconnect());
                  resolve(sel);
                }
              });
              mo.observe(document, { childList: true, subtree: true });
              observers.push(mo);
            });
          }),
          args: [SELECTORS, 15_000]
        });
        waitedSel = result;
      } else {
        throw e;
      }
    }

    if (waitedSel === '.no-results-message' || waitedSel === '.error-message') {
      throw new Error(`[row ${row}] Detail page reports NO_RESULTS or ERROR`);
    }

    // 10) Backoff before extraction
    await delay(getFibDelay());
    if (!(await isTabAlive(tabId))) throw new Error(`[row ${row}] No tab with id: ${tabId}`);

    // 11) Extract structured detail data
    const [{ result: detailData }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: detailSelectors => {
        const out = {};
        for (const cfg of detailSelectors || []) {
          const elems = Array.from(document.querySelectorAll(cfg.selector));
          out[cfg.id] = elems.length
            ? (cfg.multiple
                ? elems.map(el => (el.innerText ?? '').trim())
                : (elems[0][cfg.type === 'SelectorText' ? 'innerText' : 'innerHTML'] ?? '').trim())
            : (cfg.multiple ? [] : null);
        }
        return out;
      },
      args: [config.detailSelectors]
    });

    return detailData;
  } finally {
    // Always clean up the tab to avoid leaks / “No tab with id” on next steps
    await safeRemoveTab(tabId);
  }
}

// ───────────────────────────────────────────────────────────
// Log detail-page data into "For REI Upload" sheet
async function logDetailPageData(detailData) {
  if (
    !detailData ||
    typeof detailData.sourceRow !== 'number' ||
    detailData.sourceRow < 1
  ) {
    throw new Error(`Invalid or missing sourceRow: ${detailData?.sourceRow}`);
  }

  const token = await getServiceAccountToken();
  const ssId = config.spreadsheetId;
  const detailSheet = config.detailSheetName;
  const sourceRow = detailData.sourceRow;

  // 1. Find first empty row in detailSheet (based on column A)
  const detailRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/` +
      `${encodeURIComponent(detailSheet)}!A:A`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: detailVals = [] } = await detailRes.json();
  let row = 1;
  while (
    row <= detailVals.length &&
    detailVals[row - 1] &&
    detailVals[row - 1][0] !== ''
  ) {
    row++;
  }

  // 2. Read Site from column B in mainSheet (sourceRow)
  const siteRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/` +
      `${encodeURIComponent(config.sheetName)}!B${sourceRow}:B${sourceRow}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: siteVals = [] } = await siteRes.json();
  const site = (siteVals[0] && siteVals[0][0]) || '';

  // 3. Split full name into first and last
  const full = detailData.Fullname || '';
  const parts = full.trim().split(/\s+/);
  const firstName = parts.shift() || '';
  const lastName = parts.join(' ') || '';

  // 4. Detect phone count (cap at 5)
  let phoneCount = config.detailSelectors.filter(sel =>
    /^Phone Number \d+$/.test(sel.id)
  ).length;
  phoneCount = Math.min(phoneCount, 5);

  // 5. Collect phones & types
  const phones = [];
  for (let i = 1; i <= phoneCount; i++) {
    phones.push(detailData[`Phone Number ${i}`] || '');
    phones.push(detailData[`Phone Type ${i}`] || '');
  }

  // 6. Collect emails
  const emailCount = config.detailSelectors.filter(sel =>
    /^Email \d+$/.test(sel.id)
  ).length;
  const emails = [];
  for (let i = 1; i <= emailCount; i++) {
    emails.push(detailData[`Email ${i}`] || '');
  }

  // 7. Prepare row values
  const rowVals = [site, firstName, lastName, ...phones, ...emails];
  const lastCol = toColumnLetter(rowVals.length);
  const range = `${encodeURIComponent(detailSheet)}!A${row}:${lastCol}${row}`;

  // 8. PUT into the found empty row
  const putRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${range}` +
      `?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [rowVals] }),
    }
  );

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Failed to log detail data: ${putRes.status} ${errText}`);
  }

  console.log(`✅ Logged detail-page row ${row} in "${detailSheet}"`);
}

// ───────────────────────────────────────────────────────────
// 1. Load config.json & init ECDSA keyPair
async function loadConfigAndKeys() {
  // Ensure config object exists
  if (typeof config === "undefined" || config === null) config = {};
  
  // Load JSON config and merge into existing config
  const r = await fetch(chrome.runtime.getURL('config.json'));
  const jsonConfig = await r.json();
  Object.assign(config, jsonConfig); // safe mutation, no reassignment

  // Load existing ECDSA keys from storage
  const storedKeys = await chrome.storage.local.get(['pubJwk', 'privJwk']);
  const { pubJwk, privJwk } = storedKeys;

  if (pubJwk && privJwk) {
    // import keys into keyPair safely
    keyPair = {
      publicKey: await crypto.subtle.importKey(
        'jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']
      ),
      privateKey: await crypto.subtle.importKey(
        'jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']
      )
    };
  } else {
    // generate new key pair
    keyPair = await genSigningKey();
    const [ePub, ePriv] = await Promise.all([
      crypto.subtle.exportKey('jwk', keyPair.publicKey),
      crypto.subtle.exportKey('jwk', keyPair.privateKey)
    ]);
    await chrome.storage.local.set({ pubJwk: ePub, privJwk: ePriv });
  }

  console.log("✅ Config loaded and keyPair initialized");
}

// ───────────────────────────────────────────────────────────
// 2. Load service-account.json and import RSA private key
async function loadServiceAccount() {
  const res = await fetch(chrome.runtime.getURL('service-account.json'));
  if (!res.ok) throw new Error(`svc acct load failed: ${res.status}`);
  const svcAcct = await res.json();
  rsaPrivateKey = await importKeyFromPem(svcAcct.private_key, 'RSA');
  return svcAcct;
}

// Sign JWT assertion
async function signJwtAssertion(unsignedJwt) {
  if (!rsaPrivateKey) {
    throw new Error('RSA private key not loaded');
  }
  const signatureBuffer = await signRS256(rsaPrivateKey, unsignedJwt);
  const sig = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return sig;
}

// Get Google Sheets API token
async function getServiceAccountToken() {
  const now = Math.floor(Date.now() / 1000);
  if (config.tokenCache && config.tokenCache.token && config.tokenCache.expiry > now + 60) {
    return config.tokenCache.token;
  }

  const hdr = { alg: 'RS256', typ: 'JWT' };
  const pld = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const b64 = obj =>
    btoa(JSON.stringify(obj))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const unsigned = [b64(hdr), b64(pld)].join('.');
  const signature = await signJwtAssertion(unsigned);
  const assertion = `${unsigned}.${signature}`;

  const tokRes = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer` +
          `&assertion=${assertion}`,
  });

  if (!tokRes.ok) {
    throw new Error(`Token request failed: ${tokRes.status} ${await tokRes.text()}`);
  }
  const { access_token, expires_in } = await tokRes.json();
  config.tokenCache = { token: access_token, expiry: now + expires_in };
  return access_token;
}

// ───────────────────────────────────────────────────────────
// 4. Fetch URLs & filter rows lacking U–AG data + deduplicate
async function fetchUrlsFromSheet(resumeRow = null, processedUrls = new Set()) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, urlRange, sheetName } = config;

  const urlRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
      `${encodeURIComponent(urlRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!urlRes.ok) throw new Error(await urlRes.text());
  const { values = [] } = await urlRes.json();
  if (!values.length) return [];

  const startRow = +urlRange.match(/\d+/)[0];
  let entries = values
    .map((r, i) => ({ url: r[0]?.trim(), row: startRow + i }))
    .filter(e => e.url);

  // 🔑 Deduplicate within this batch + skip already processed URLs
  const seenUrls = new Set();
  entries = entries.filter(e => {
    if (seenUrls.has(e.url) || processedUrls.has(e.url)) return false;
    seenUrls.add(e.url);
    return true;
  });

  const endRow = startRow + values.length - 1;
  const logRange = `${sheetName}!U${startRow}:AE${endRow}`;
  const logRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
      `${encodeURIComponent(logRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: logVals = [] } = await logRes.json();

  let results = entries.filter((e, i) => {
    const rowLog = logVals[i] || [];
    return !rowLog.some(cell => String(cell || "").trim());
  });

  // 🔑 Apply resume cutoff
  if (resumeRow != null) {
    results = results.filter(e => e.row >= resumeRow);
  }

  return results;
}

// ───────────────────────────────────────────────────────────
// 5. Fetch F–L names for fuzzy matching
async function fetchRowNames(row) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, sheetName } = config;
  const range = `${sheetName}!F${row}:L${row}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
      `${encodeURIComponent(range)}?majorDimension=ROWS`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(await res.text());
  const { values=[] } = await res.json();
  return (values[0]||[]).map(v => String(v||'').trim());
}

// ───────────────────────────────────────────────────────────
// 6a. Log NO_RESULTS fallback in U→AG
async function logResults(row, data) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, sheetName, maxPairs } = config;
  const flat = [];
  for (let i = 1; i <= maxPairs; i++) {
    flat.push(data[`Person ${i}`]||'');
    flat.push(data[`HREF ${i}`]||'');
  }
  const values = [data.Site||'', ...flat];
  const startCol = 21; // U
  const endCol = startCol + values.length - 1;
  const range = `${sheetName}!${toColumnLetter(startCol)}${row}:` +
                `${toColumnLetter(endCol)}${row}`;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
      `${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method:'PUT',
      headers:{
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({ values:[values] })
    }
  );
  console.log(`✅ NO_RESULTS logged for row ${row}`);
}

// ───────────────────────────────────────────────────────────
// 6b. Log confirmed matches in V→AE
async function logConfirmedMatches(row, site, matches) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, sheetName, maxPairs } = config;

  // cap matches to 5 max
  const limitedMatches = matches.slice(0, 5);

  // flatten into [name, href, name, href...]
  let flat = limitedMatches.flatMap(m => [m.name, m.href]);

  // also respect config.maxPairs if provided
  if (maxPairs > 0) flat = flat.slice(0, maxPairs * 2);

  const values = [site, ...flat];
  const startCol = 21;
  const endCol = startCol + values.length - 1;
  const range = `${sheetName}!${toColumnLetter(startCol)}${row}:` +
                `${toColumnLetter(endCol)}${row}`;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
      `${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method:'PUT',
      headers:{
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({ values:[values] })
    }
  );

  console.log(`✅ Logged ${limitedMatches.length} matches (max 5) for row ${row}`);
}

// ───────────────────────────────────────────────────────────
// Check if V→AE already has data
async function hasLoggedData(row) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, sheetName } = config;
  const range = `${sheetName}!V${row}:AE${row}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
      `${encodeURIComponent(range)}?majorDimension=ROWS`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(await res.text());
  const { values=[] } = await res.json();
  return Array.isArray(values[0]) && values[0].some(c => String(c||'').trim());
}

async function scrapeUrl({ url, row }) {
  const { id: tabId } = await chrome.tabs.create({ url, active: false });
  const originalUrl = url;
  attachCfNetworkLoggingForTab(tabId);

  // Wait until tab is fully loaded
  await waitForTabComplete(tabId);

  // ⬇️ Handle vignette overlays before scraping
  await handleVignette(tabId);

  // Dynamic timeout based on page performance
  let dynamicTimeout = 30000;
  try {
    const [{ result: perf }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const entries = performance.getEntriesByType('resource');
        return entries.reduce((m, e) => Math.max(m, e.responseEnd), 0) + 20000;
      },
    });
    if (typeof perf === 'number' && perf > 0) dynamicTimeout = perf;
  } catch (_) {}

  let data = {};
  let errorMsg = null;

  if (globalThis.solverLock) {
    console.log(`[solverLock] Waiting for existing solver to complete for ${url}`);
    await globalThis.solverLock;
  }

  for (let attempt = 1; attempt <= config.retryOptions.maxTimeoutRetries; attempt++) {
    let res;
    try {
      const timeoutForAttempt =
        attempt === config.retryOptions.maxTimeoutRetries && config.retryOptions.rescueTimeout
          ? config.retryOptions.rescueTimeout
          : dynamicTimeout;

      const delayBeforeScript = getFibDelay();
      console.log(`[row ${row}] Waiting ${delayBeforeScript}ms before script execution`);
      await delay(delayBeforeScript);

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (pageSelector, selectors, maxPairs, timeout) => {
          const waitForAny = (sels, t) =>
            new Promise((resolve, reject) => {
              let settled = false;
              const observers = [];
              const timer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  observers.forEach(mo => mo.disconnect());
                  reject(new Error(`Timeout waiting for any selector: ${sels.join(', ')}`));
                }
              }, t);

              for (const sel of sels) {
                if (document.querySelector(sel)) {
                  settled = true;
                  clearTimeout(timer);
                  observers.forEach(mo => mo.disconnect());
                  resolve(sel);
                  return;
                }
              }

              sels.forEach(sel => {
                const mo = new MutationObserver(() => {
                  const f = document.querySelector(sel);
                  if (f && !settled) {
                    settled = true;
                    clearTimeout(timer);
                    observers.forEach(mo => mo.disconnect());
                    resolve(sel);
                  }
                });
                mo.observe(document, { childList: true, subtree: true });
                observers.push(mo);
              });
            });

          const href = location.href;
          const isBot =
            href.includes('/bot-check') ||
            !!document.querySelector(
              '#challenge-form, .cf-browser-verification, .hcaptcha-box, .h-captcha, .g-recaptcha'
            );
          if (isBot) return { data: {}, error: 'BOT_CHECK' };

          try {
            const waitedSel = await waitForAny(
              [pageSelector, '.no-results-message', '.error-message'],
              timeout
            );
            if (['.no-results-message', '.error-message'].includes(waitedSel)) {
              return { data: {}, error: 'NO_RESULTS' };
            }

            const out = {};
            for (const cfg of selectors || []) {
              const elems = Array.from(document.querySelectorAll(cfg.selector || ''));
              if (!elems.length) {
                out[cfg.id] = cfg.multiple ? [] : null;
                continue;
              }
              const slice = cfg.maxPairs > 0 ? elems.slice(0, cfg.maxPairs) : elems;
              if (cfg.type === 'SelectorText') {
                out[cfg.id] = cfg.multiple ? slice.map(e => (e.innerText ?? '').trim()) : (slice[0]?.innerText ?? '').trim();
              } else if (cfg.type === 'SelectorElementAttribute') {
                out[cfg.id] = cfg.multiple
                  ? slice.map(e => (e.getAttribute(cfg.extractAttribute) ?? '').trim())
                  : (slice[0]?.getAttribute(cfg.extractAttribute) ?? '').trim();
              } else {
                out[cfg.id] = cfg.multiple ? slice.map(e => e.innerHTML ?? '') : (slice[0]?.innerHTML ?? '');
              }
            }
            return { data: out, error: null };
          } catch (e) {
            return { data: {}, error: e?.message || 'UNKNOWN_SCRAPE_ERROR' };
          }
        },
        args: [
          `${config.pageLoadSelector}, .list-results-header h1, .list-results`,
          config.selectors,
          config.maxPairs,
          timeoutForAttempt,
        ],
      });

      if (!result || typeof result !== 'object') throw new Error('NULL_OR_INVALID_RESULT');
      res = result;
    } catch (e) {
      errorMsg = e?.message || 'EXECUTE_SCRIPT_FAILURE';
      console.warn(`Injection failure on attempt ${attempt}:`, errorMsg);

      const retryDelay = getFibDelay();
      console.log(`[row ${row}] Waiting ${retryDelay}ms before next attempt`);
      await delay(retryDelay);

      // Automatically trigger handleTimeoutError for selector timeouts
      if (errorMsg.toLowerCase().includes('timeout waiting for any selector')) {
        const action = await handleTimeoutError(tabId, row, { lastError: errorMsg });
        if (action === 'retry') {
          attempt--;
          continue;
        }
      }
      continue;
    }

    data = res.data || {};
    errorMsg = res.error || null;

    if (errorMsg === 'NO_RESULTS') break;

    if (errorMsg === 'BOT_CHECK' || errorMsg?.toLowerCase().includes('timeout waiting for any selector')) {
      const action = await handleTimeoutError(tabId, row, { lastError: errorMsg, url });
      if (action === 'retry') {
        attempt--;
        continue;
      }
    }

    if (errorMsg) {
      console.error(`scrapeUrl error for ${url}:`, errorMsg);
      break;
    } else break; // success
  }

  const delayBeforeClose = getFibDelay();
  await delay(delayBeforeClose);
  await chrome.tabs.remove(tabId).catch(() => {});
  if (globalThis.solverLock?.release) {
    globalThis.solverLock.release();
    globalThis.solverLock = null;
    console.log(`[solverLock] Released for ${url}`);
  }


  const scraped = [];
  if (Array.isArray(data.Names) && Array.isArray(data.Hrefs)) {
    const rawLen = Math.min(data.Names.length, data.Hrefs.length);
    const limit = config.maxPairs > 0 ? Math.min(rawLen, config.maxPairs) : rawLen;

    for (let i = 0; i < limit; i++) {
      const name = (data.Names[i] || '').trim();
      const href = (data.Hrefs[i] || '').trim();
      if (name && href) {
        scraped.push({ name, href });
      }
    }
  }

  const seenRaw = new Set();
  const uniqueScraped = [];
  for (const item of scraped) {
    const key = `${item.name}||${item.href}`;
    if (!seenRaw.has(key)) {
      seenRaw.add(key);
      uniqueScraped.push(item);
    }
  }

  const sheetNames = await fetchRowNames(row);
  const confirmed = uniqueScraped.filter(p =>
    sheetNames.some(sn => similarity(p.name, sn) >= config.matchThreshold)
  );

  const seenHref = new Set();
  const uniqueConfirmed = [];
  for (const m of confirmed) {
    if (!seenHref.has(m.href)) {
      seenHref.add(m.href);
      uniqueConfirmed.push(m);
    }
  }

  console.log(`Confirmed unique matches for row ${row}:`, uniqueConfirmed);

  const siteVal = String(data.Site || url).trim();
  await logConfirmedMatches(row, siteVal, uniqueConfirmed);

  if (uniqueConfirmed.length && Array.isArray(config.detailSelectors)) {
    const phoneKeys = config.detailSelectors
      .filter(sel => /^Phone Number \d+$/.test(sel.id))
      .map(sel => sel.id);

    for (const m of uniqueConfirmed) {
      // --- Fibonacci delay before following detail link ---
      const detailDelay = getFibDelay();
      console.log(`[row ${row}] Waiting ${detailDelay}ms before following detail link`);
      await new Promise(r => setTimeout(r, detailDelay));

      try {
        const detailData = await followAndScrapeDetail(m.href, row);
        const hasPhone = phoneKeys.some(key => {
          const v = detailData[key];
          return typeof v === 'string' && v.trim() !== '';
        });

        if (!hasPhone) {
          console.log(`Row ${row}: no phone numbers found on detail page ${m.href}, skipping log`);
          continue;
        }
        // Fibonacci Utilization
        const logDelay = getFibDelay();
        console.log(`[row ${row}] Waiting ${logDelay}ms before logging detailed data`)
        await new Promise(r => setTimeout(r, logDelay));
        await logDetailPageData({ sourceRow: row, ...detailData });

      } catch (err) {
        console.error(`Detail error for ${m.href}:`, err);
      }
    }
  }
}

// ─────────────────────────────
// Fibonacci-based batch pause system (no repeats per session)
let fibBatchPool = null;         // current batch pause pool
const usedFibBatch = new Set();  // tracks all used batch pauses globally

/**
 * Initialize or reset the Fibonacci batch pool.
 * Optionally shuffle to randomize order.
 */
function initFibBatchPool() {
  const minMs = 12_990;           // 12.990 seconds
  const maxMs = 30_000;           // 60 seconds
  const scale = 1000;               // scale factor for Fibonacci numbers

  // Generate Fibonacci numbers until maxMs / scale
  const fibs = [1, 1];
  while (true) {
    const next = fibs[fibs.length - 1] + fibs[fibs.length - 2];
    if (next * scale > maxMs) break;
    fibs.push(next);
  }

  // Convert to milliseconds and filter by minMs
  fibBatchPool = fibs.map(n => n * scale).filter(n => n >= minMs);

  // Shuffle for randomness
  for (let i = fibBatchPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fibBatchPool[i], fibBatchPool[j]] = [fibBatchPool[j], fibBatchPool[i]];
  }
}

/**
 * Return a batch pause in ms.
 * Guarantees no repeats per session, auto-resets if exhausted.
 */
function getBatchPauseMs() {
  if (!fibBatchPool || fibBatchPool.length === 0) {
    console.warn('Batch Fibonacci pool exhausted, reinitializing...');
    initFibBatchPool();
  }

  while (fibBatchPool.length) {
    const delay = fibBatchPool.pop();
    if (!usedFibBatch.has(delay)) {
      usedFibBatch.add(delay);
      return delay;
    }
  }

  // All batch values used, reset session history
  console.warn('All unique batch Fibonacci pauses used, resetting session history...');
  usedFibBatch.clear();
  initFibBatchPool();
  return getBatchPauseMs(); // retry after reset
}

/**
 * Optional: manually reset batch pool and used history
 */
function resetBatchFibPool() {
  fibBatchPool = null;
  usedFibBatch.clear();
}


// helper: match the specific CF Turnstile headers
function isCfTurnstileRequest(headers) {
  return headers['origin'] === 'https://challenges.cloudflare.com'
    && headers['referer']?.startsWith('https://challenges.cloudflare.com/cdn-cgi/challenge-platform')
    && headers['content-length'] === '4482'
    && headers['content-type']?.startsWith('text/plain')
    && headers['dnt'] === '1'
    && headers['priority'] === 'u=1, i';
}

function attachCfNetworkLoggingForTab(tabId) {
  const filter = { urls: ["<all_urls>"], tabId };

  const onBeforeSendHeaders = details => {
    const headers = Object.fromEntries(
      details.requestHeaders.map(h => [h.name.toLowerCase(), h.value])
    );

    if (isCfTurnstileRequest(headers)) {
      console.log(`🌐 [CF XHR] ${details.method} ${details.url}`, headers);
    }
  };

  const onCompleted = details => {
    console.log(`📥 [CF XHR RESPONSE] ${details.statusCode} ${details.url}`);

    // --- Detect throttling / blocking ---
    const queue = globalThis.requestQueue;
    if (!queue) return;

    if (details.statusCode === 429) {
      // Too many requests → exponential backoff
      queue.setDelay(queue.dynamicDelay * 2);
      queue.pause("HTTP 429 Too Many Requests");
    } else if (details.statusCode === 403) {
      // Forbidden (Cloudflare challenge failed)
      queue.setDelay(queue.dynamicDelay * 3);
      queue.pause("HTTP 403 Forbidden");
    }
  };

  chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, filter, ["requestHeaders"]);
  chrome.webRequest.onCompleted.addListener(onCompleted, filter);

  // Cleanup when tab closes
  const cleanup = id => {
    if (id === tabId) {
      chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
      chrome.webRequest.onCompleted.removeListener(onCompleted);
      chrome.tabs.onRemoved.removeListener(cleanup);
    }
  };
  chrome.tabs.onRemoved.addListener(cleanup);
}

// ===============================
// COOKIE MANAGEMENT MODULE
// ===============================

const TARGET_DOMAIN = "https://www.fastpeoplesearch.com/address";
const COOKIE_KEY = "fps_cookie_pool";
const COOKIE_LOCK_KEY = "fps_cookie_pool_lock";
const ROTATION_META_KEY = "fps_cookie_rotation_meta";

const COOKIE_ROTATION_INTERVAL = 15 * 60 * 1000; // 15 min
const COOKIE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min
const COOKIE_POOL_MAX = 50; // absolute cap on entries

const LOCK_TTL = 5000; // ms
const LOCK_RETRY_DELAY = 100; // ms
const LOCK_RETRY_ATTEMPTS = 30;

function nowMs() { return Date.now(); }

async function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
async function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}
async function storageRemove(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

// --------------------
// Lock helpers
// --------------------
async function acquireLock(ownerId) {
  for (let i = 0; i < LOCK_RETRY_ATTEMPTS; i++) {
    const data = await storageGet([COOKIE_LOCK_KEY]);
    const lock = data[COOKIE_LOCK_KEY];
    const now = nowMs();

    if (!lock || (now - (lock.ts || 0)) > LOCK_TTL) {
      const newLock = { owner: ownerId, ts: now };
      await storageSet({ [COOKIE_LOCK_KEY]: newLock });
      const check = await storageGet([COOKIE_LOCK_KEY]);
      if ((check[COOKIE_LOCK_KEY] || {}).owner === ownerId) return true;
    }
    await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY));
  }
  return false;
}
async function releaseLock(ownerId) {
  const data = await storageGet([COOKIE_LOCK_KEY]);
  if ((data[COOKIE_LOCK_KEY] || {}).owner === ownerId) {
    await storageRemove([COOKIE_LOCK_KEY]);
  }
}

// --------------------
// Canonicalization + dedupe
// --------------------
function canonicalizeCookies(cookies) {
  const normalized = cookies.map(c => ({
    name: c.name || "",
    value: c.value || "",
    domain: (c.domain || "").replace(/^\./, "").toLowerCase(),
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || "unspecified",
    expirationDate: c.expirationDate || 0
  }));
  normalized.sort((a, b) =>
    (a.domain + ":" + a.path + ":" + a.name)
      .localeCompare(b.domain + ":" + b.path + ":" + b.name)
  );
  return JSON.stringify(normalized);
}

// --------------------
// Pool maintenance
// --------------------
async function loadAndPurgePool() {
  const data = await storageGet([COOKIE_KEY]);
  let pool = data[COOKIE_KEY] || [];
  const now = nowMs();

  // Drop stale (> 30 min)
  pool = pool.filter(e => (now - (e.savedAt || 0)) <= COOKIE_MAX_AGE_MS);

  // Cap pool size (FIFO: drop oldest first)
  if (pool.length > COOKIE_POOL_MAX) {
    pool.splice(0, pool.length - COOKIE_POOL_MAX);
  }

  await storageSet({ [COOKIE_KEY]: pool });
  return pool;
}

// --------------------
// Add cookie sets
// --------------------
async function addCookieSetAtomic(cookies) {
  const owner = `${Math.random().toString(36).slice(2)}-${nowMs()}`;
  if (!await acquireLock(owner)) {
    console.warn("⚠️ Could not acquire lock to add cookies");
    return false;
  }

  try {
    let pool = await loadAndPurgePool();
    const incomingKey = canonicalizeCookies(cookies);

    const existingIndex = pool.findIndex(e => e._key === incomingKey);
    if (existingIndex !== -1) {
      // refresh timestamp
      pool[existingIndex].savedAt = nowMs();
      await storageSet({ [COOKIE_KEY]: pool });
      console.log(`🔄 Refreshed existing cookie set, pool size: ${pool.length}`);
      return false;
    }

    pool.push({
      cookies,
      savedAt: nowMs(),
      _key: incomingKey
    });

    // enforce cap
    if (pool.length > COOKIE_POOL_MAX) {
      pool.splice(0, pool.length - COOKIE_POOL_MAX);
    }

    await storageSet({ [COOKIE_KEY]: pool });
    console.log(`✅ Added new cookie set, pool size: ${pool.length}`);
    return true;
  } finally {
    await releaseLock(owner);
  }
}

async function saveCurrentCookies() {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({ url: TARGET_DOMAIN }, async cookies => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      try {
        await addCookieSetAtomic(cookies);
        resolve(cookies);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// --------------------
// Apply / rotate
// --------------------
async function applyCookies(cookieSet) {
  let applied = 0;
  for (const cookie of cookieSet) {
    try {
      const url = (cookie.secure ? "https://" : "http://") +
        (cookie.domain?.replace(/^\./, "") || new URL(TARGET_DOMAIN).hostname) +
        (cookie.path || "/");

      await chrome.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate
      });
      applied++;
    } catch (err) {
      console.warn(`⚠️ Failed to set cookie: ${cookie.name}`, err);
    }
  }
  console.log(`🔄 Applied ${applied} cookies`);
}

async function getRotationMeta() {
  const data = await storageGet([ROTATION_META_KEY]);
  return data[ROTATION_META_KEY] || { lastCookieUse: 0, nextRotationAt: 0 };
}
async function setRotationMeta(meta) {
  await storageSet({ [ROTATION_META_KEY]: meta });
}

async function rotateCookies() {
  const owner = `${Math.random().toString(36).slice(2)}-${nowMs()}`;
  if (!await acquireLock(owner)) {
    console.warn("⚠️ Could not acquire rotation lock");
    return null;
  }

  try {
    let pool = await loadAndPurgePool();
    if (!pool.length) {
      await renewSessionCookies();
      pool = await loadAndPurgePool();
    }

    if (!pool.length) {
      console.warn("❌ Still no cookies available");
      return null;
    }

    const set = pool.shift(); // FIFO
    await applyCookies(set.cookies);
    await storageSet({ [COOKIE_KEY]: pool });

    const meta = await getRotationMeta();
    const now = nowMs();
    meta.lastCookieUse = now;
    meta.nextRotationAt = now + COOKIE_ROTATION_INTERVAL;
    await setRotationMeta(meta);

    console.log(`🍪 Rotated cookies, pool now ${pool.length}`);
    return set.cookies;
  } finally {
    await releaseLock(owner);
  }
}

// --------------------
// Renewal
// --------------------
async function renewSessionCookies() {
  console.log("🔄 Renewing session cookies...");
  const old = await new Promise(r => chrome.cookies.getAll({ url: TARGET_DOMAIN }, r));
  for (const c of old) {
    try { await chrome.cookies.remove({ url: TARGET_DOMAIN, name: c.name }); }
    catch (e) { console.warn("⚠️ Remove failed:", c.name, e); }
  }
  try { await fetch(TARGET_DOMAIN, { credentials: "include" }); }
  catch (e) { console.warn("⚠️ Fetch homepage failed", e); }
  await saveCurrentCookies();
}

// --------------------
// Ensure cookies for requests
// --------------------
async function ensureCookies(url) {
  await loadAndPurgePool();
  const meta = await getRotationMeta();
  const now = nowMs();
  if (now >= (meta.nextRotationAt || 0)) {
    return await rotateCookies();
  }
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({ url: TARGET_DOMAIN }, cookies => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(cookies);
    });
  });
}

// --------------------
// Hook
// --------------------
chrome.webRequest.onCompleted.addListener(
  async details => {
    if (details.url.startsWith(TARGET_DOMAIN) && details.statusCode === 200) {
      try {
        await saveCurrentCookies();
        await loadAndPurgePool();
      } catch (e) {
        console.warn("⚠️ saveCurrentCookies failed", e);
      }
    }
  },
  { urls: [`${TARGET_DOMAIN}/*`] }
);

globalThis._fps_cookie_utils = {
  addCookieSetAtomic,
  loadAndPurgePool,
  rotateCookies,
  renewSessionCookies,
  getRotationMeta,
  setRotationMeta
};

// ============================
// FastMode Tweaks
// ============================
function applyModeTweaks() {
  if (!config.fastMode) return;

  console.log("⚡ FastMode ON — boosting concurrency, lowering delays");

  // --- Queue speed-up ---
  if (globalThis.requestQueue) {
    requestQueue.concurrency = 10;
    requestQueue.setDelay(300); // 0.3s between jobs
  }

  // --- Fibonacci delay tighter ---
  config.requestOptions = config.requestOptions || {};
  config.requestOptions.fibDelays = { max: 2000, scale: 1 };

  // --- Cooldown cap shortened ---
  if (typeof setGlobalCooldown === "function") {
    const originalSetGlobalCooldown = setGlobalCooldown;
    globalThis.setGlobalCooldown = function (ms, reason = "Unknown") {
      const capped = Math.min(ms, 30_000); // max 30s
      return originalSetGlobalCooldown(capped, reason);
    };
  }

  // --- Faster alarm rescheduling ---
  if (typeof scheduleWorkSoon === "function") {
    const originalScheduleWorkSoon = scheduleWorkSoon;
    globalThis.scheduleWorkSoon = function (delayMin = 0.005) { // ~300ms
      return originalScheduleWorkSoon(delayMin);
    };
  } else {
    // fallback: define safely if not declared yet
    globalThis.scheduleWorkSoon = function (delayMin = 0.005) {
      chrome.alarms.create(WORK_ALARM, { delayInMinutes: delayMin });
    };
  }

  // --- Limit retries for speed ---
  if (typeof handleTimeoutError === "function") {
    const originalHandleTimeoutError = handleTimeoutError;
    globalThis.handleTimeoutError = async function (tabId, row, opts = {}) {
      const action = await originalHandleTimeoutError(tabId, row, opts);
      if (action === "retry") {
        console.warn(`⚡ FastMode: skipping long retry loops for row ${row}`);
        return "skip";
      }
      return action;
    };
  }
}


// ==========================
// Durable Bootstrap (replace your IIFE)
// ==========================
(async function durableBootstrap() {
  const WORK_ALARM = "work-alarm";
  const CHECK_FINALIZE_DELAY_MIN = 0.05; // 3s
  const TASK_TIMEOUT_MS = 2 * 60_000;

  // helpers
  async function getState() {
    return await chrome.storage.local.get({
      tasks: [], // { row, url, id, status, attempts, nextTry, workerStartedAt, finishedAt, lastError }
      meta: { epoch: Date.now(), totalKnown: 0, doneCount: 0, inProgressCount: 0, completion: null, resumeRow: null, resumeSource: null }
    });
  }
  async function setState(obj) {
    await chrome.storage.local.set(obj);
  }
  function scheduleWorkSoon(delayMin = CHECK_FINALIZE_DELAY_MIN) {
    chrome.alarms.create(WORK_ALARM, { delayInMinutes: delayMin });
  }

  try {
    await loadConfigAndKeys();
    config.serviceAccount = await loadServiceAccount();
    serviceAccount = config.serviceAccount;
    applyModeTweaks();
    console.log("🚀 Config & Service Account loaded");

    // --- Cookie init: ensure rotation meta and a warmed pool
    try {
      const utils = globalThis._fps_cookie_utils;
      if (!utils) throw new Error("cookie utils not available");

      const meta = await utils.getRotationMeta();
      if (!meta || !meta.nextRotationAt) {
        await utils.setRotationMeta({ lastCookieUse: 0, nextRotationAt: Date.now() });
        console.log("🔧 Rotation meta initialized");
      }

      const pool = await utils.loadAndPurgePool();
      if (!pool.length) {
        utils.renewSessionCookies().catch(e => console.warn("Cookie warm failed", e));
        console.log("🟢 Cookie pool warm started in background");
      }
    } catch (e) {
      console.warn("⚠️ Cookie init failed, continuing — tasks will try to rotate on demand", e);
    }

    // determine start row and persist resume info
    const startRow = Number.isFinite(Number(config.startRow)) ? Number(config.startRow) : Number((config.urlRange||'').match(/\d+/)[0] || 2);
    console.log(`➡️ Resuming scrape at row ${startRow}`);

    // fetch URLs from sheet once, then persist tasks to storage if not present
    const { tasks: storedTasks, meta } = await getState();
    if (!meta || typeof meta.resumeRow === "undefined" || meta.resumeRow === null) {
      await setState({ meta: { ...meta, resumeRow: startRow, resumeSource: 'config', epoch: Date.now() } });
    }

    // Only fetch+seed when tasks are empty or resumeRow changed
    const shouldSeed = !storedTasks?.length || (meta && meta.resumeRow !== startRow);
    if (shouldSeed) {
      const sheetTasks = await fetchUrlsFromSheet(startRow); // returns [{url,row}]
      const seeded = sheetTasks.map((t, i) => ({
        id: `${Date.now()}-${i}-${t.row}`,
        url: t.url,
        row: t.row,
        status: "pending",
        attempts: 0
      }));
      await setState({ tasks: seeded, meta: { ...(meta || {}), totalKnown: seeded.length, doneCount: 0, inProgressCount: 0, completion: null, resumeRow: startRow, resumeSource: 'config', epoch: Date.now() } });
      console.log(`🗂️ Seeded ${seeded.length} tasks from sheet starting at row ${startRow}`);
    } else {
      console.log(`↩️ Reusing ${storedTasks.length} tasks already persisted; resumeRow ${meta.resumeRow}`);
    }

    // Kick off processing via alarm (non-blocking); alarm handler will pick tasks and run
    scheduleWorkSoon(0.01);
    console.log("▶ Work scheduled via alarm");

    // Optional: expose a quick status snapshot
    const snapshot = await getState();
    console.log(`⏱ Progress snapshot: ${snapshot.meta.doneCount}/${snapshot.meta.totalKnown} done`);

  } catch (err) {
    console.error("Fatal error during bootstrap:", err);
  } finally {
    if (globalThis.solverLock?.release) {
      globalThis.solverLock.release();
      globalThis.solverLock = null;
    }
  }
})();

// ==========================
// Alarm-driven processing loop (add to background.js)
// ==========================
const WORK_ALARM = "work-alarm";
const TASK_TIMEOUT_MS = 2 * 60_000;

async function pickNextTask(tasks) {
  const now = Date.now();
  // recover stale in-progress
  for (const t of tasks) {
    if (t.status === "in-progress" && (now - (t.workerStartedAt || 0)) > TASK_TIMEOUT_MS) {
      t.status = "retry";
      t.nextTry = Date.now() + 1000;
      delete t.workerStartedAt;
    }
  }
  // pick pending or retry-ready
  return tasks.find(t => t.status === "pending" || (t.status === "retry" && (t.nextTry || 0) <= Date.now()));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WORK_ALARM) return;
  void (async () => {
    const s = await chrome.storage.local.get({ tasks: [], meta: {} });
    const tasks = s.tasks || [];
    const meta = s.meta || { totalKnown: tasks.length, doneCount: 0, inProgressCount: 0, epoch: Date.now(), completion: null };

    const next = await pickNextTask(tasks);
    if (!next) {
      // no immediate work; recompute counters and finalize if appropriate
      meta.doneCount = tasks.filter(t => t.status === "done").length;
      meta.inProgressCount = tasks.filter(t => t.status === "in-progress").length;
      meta.totalKnown = tasks.length;

      const pendingOrRetryNow = tasks.some(t => t.status === "pending" || (t.status === "retry" && (t.nextTry || 0) <= Date.now()));
      const inProg = meta.inProgressCount > 0;
      if (!pendingOrRetryNow && !inProg && meta.totalKnown > 0 && meta.doneCount === meta.totalKnown && !meta.completion) {
        meta.completion = { epoch: meta.epoch, finishedAt: Date.now(), summary: { total: meta.totalKnown, succeeded: meta.doneCount } };
        await chrome.storage.local.set({ tasks, meta });
        chrome.runtime.sendMessage({ type: "allDone", summary: meta.completion.summary });
        console.log("🏁 All done (durable completion recorded)");
        return;
    }
      // schedule next check later
      await chrome.storage.local.set({ tasks, meta });
      chrome.alarms.create(WORK_ALARM, { delayInMinutes: 0.5 });
      return;
    }

    // mark in-progress atomically
    next.status = "in-progress";
    next.workerStartedAt = Date.now();
    await chrome.storage.local.set({ tasks, meta });

    try {
      // Check if row already logged before doing heavy work (must be persisted check)
      const alreadyLogged = await hasLoggedData(next.row);
      if (alreadyLogged) {
        next.status = "done";
        next.finishedAt = Date.now();
        meta.doneCount = tasks.filter(t => t.status === "done").length;
        await chrome.storage.local.set({ tasks, meta });
        console.log(`  • Row ${next.row} already logged, skipping`);
        chrome.alarms.create(WORK_ALARM, { delayInMinutes: 0.01 });
        return;
      }

      // Ensure cookies
      let cookies = null;
      try {
        cookies = await ensureCookies(next.url);
      } catch (e) {
        console.warn("⚠️ ensureCookies threw, attempting renewal", e);
        try { await window._fps_cookie_utils.renewSessionCookies(); cookies = await ensureCookies(next.url); } catch (err) { cookies = null; }
      }
      if (!cookies) throw new Error("No cookies available");

      // Perform the scrape (your existing implementation)
      await scrapeUrl({ url: next.url, row: next.row, cookies });

      // mark done
      next.status = "done";
      next.finishedAt = Date.now();
      meta.doneCount = tasks.filter(t => t.status === "done").length;
      await chrome.storage.local.set({ tasks, meta });
      console.log(`✅ Row ${next.row} completed (persisted)`);
    } catch (err) {
      // handle failure: retry/backoff or fail
      next.attempts = (next.attempts || 0) + 1;
      const maxAttempts = 5;
      if (next.attempts >= maxAttempts) {
        next.status = "failed";
        next.lastError = String(err);
        next.finishedAt = Date.now();
        console.error(`❌ Row ${next.row} failed after ${next.attempts} attempts:`, err);
      } else {
        next.status = "retry";
        const backoffMs = Math.min(60_000 * 2 ** (next.attempts - 1), 3600_000);
        next.nextTry = Date.now() + backoffMs;
        next.lastError = String(err);
        console.warn(`⏳ Row ${next.row} scheduled for retry in ${Math.round(backoffMs/1000)}s due to:`, err);
      }
      await chrome.storage.local.set({ tasks, meta });
    } finally {
      // schedule immediate continuation
      chrome.alarms.create(WORK_ALARM, { delayInMinutes: 0.01 });
}
  })();
});

async function resetScraper() {
  console.warn("♻️ Resetting scraper...");

  try {
    const res = await fetch(chrome.runtime.getURL("config.json"));
    const config = await res.json();
    const startRow = config.startRow || 1;

    chrome.alarms.clearAll(() => {
      console.log("⏹ All alarms cleared");
    });

    chrome.storage.local.set({
      resumeRow: startRow,
      tasks: [],
      lastSnapshot: null
    }, () => {
      console.log(`🔄 Scraper reset to row ${startRow}`);
      chrome.alarms.create("scrapeAlarm", { delayInMinutes: 0.1, periodInMinutes: 1 });
    });

  } catch (err) {
    console.error("❌ Failed to load config.json:", err);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "resetScraper") {
    resetScraper().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async
  }
});
