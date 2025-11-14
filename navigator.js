// ===================================================
// === OTMenT v3 — navigator.js (Autonomous Orchestrator)
// ===================================================

console.log("[OTMenT] Navigator initialized. Fetching URLs...");

// Background message listener for options page
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getConfig") {
    sendResponse(config);
  }
  if (msg.action === "resetScraper") {
    resetFibDelayPool();
    console.log("[OTMenT] Reset triggered from options page");
    sendResponse({ ok: true });
  }
  if (msg.action === "toggleNavigator") {
    config.extensionEnabled = !config.extensionEnabled;
    console.log("[OTMenT] Toggle triggered — now", config.extensionEnabled ? "ON" : "OFF");
    sendResponse({ ok: true, enabled: config.extensionEnabled });
  }
});

// Fibonacci delay system (no repeats per session, respects cooldown + fastMode)
let fibDelayPool = null;         // current pool
const usedFibDelays = new Set(); // tracks all used delays globally
let requestCounter = 0;          // tracks how many requests have been made

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
    : { max: 30000, scale: 1 };

  const { max = 30000, scale = 1 } = fibConfig;

  // fastMode: shrink max proportionally instead of hard cap
  const reductionFactor = 0.1; // keep 10% of original max
  const effectiveMax = isFast ? Math.max(500, Math.floor(max * reductionFactor)) : max;

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
 * Return a delay that respects cooldown settings.
 * - Every Nth request → fixed cooldown
 * - Otherwise → Fibonacci-based delay
 */
function getDelay() {
  const { cooldownEvery = 10, cooldownMs = 30000 } = config.requestOptions || {};

  requestCounter++;

  // Apply cooldown every N requests
  if (requestCounter % cooldownEvery === 0) {
    console.log(`⏳ Cooldown triggered — ${cooldownMs}ms`);
    return cooldownMs;
  }

  // Otherwise use Fibonacci delay
  if (!fibDelayPool || fibDelayPool.length === 0) {
    console.warn('Fibonacci pool exhausted, reinitializing...');
    initFibDelayPool();
  }

  while (fibDelayPool.length) {
    const delay = fibDelayPool.pop();
    if (!usedFibDelays.has(delay)) {
      usedFibDelays.add(delay);
      console.log(`🔹 Fibonacci delay selected — ${delay}ms`);
      return delay;
    }
  }

  // All values used → reset
  console.warn('All unique Fibonacci delays have been used, resetting session history...');
  usedFibDelays.clear();
  initFibDelayPool();
  return getDelay(); // retry after reset
}

/**
 * Manual reset of the Fibonacci delay pool and used delays.
 */
function resetFibDelayPool() {
  fibDelayPool = null;
  usedFibDelays.clear();
  requestCounter = 0;
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

let config = null;
let rsaPrivateKey;
let serviceAccount;

// ============================================
// === Google Sheets Auth
// ============================================
async function getServiceAccountToken() {
  const now = Math.floor(Date.now() / 1000);
  if (!serviceAccount || !rsaPrivateKey) await loadConfig();

  if (config.tokenCache && config.tokenCache.token && config.tokenCache.expiry > now + 60) {
    return config.tokenCache.token;
  }

  const hdr = { alg: "RS256", typ: "JWT" };
  const pld = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const b64 = obj =>
    btoa(JSON.stringify(obj))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const unsigned = [b64(hdr), b64(pld)].join(".");
  const signature = await signJwtAssertion(unsigned);
  const assertion = `${unsigned}.${signature}`;

  const tokRes = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`,
  });

  if (!tokRes.ok) throw new Error(`Token request failed: ${tokRes.status} ${await tokRes.text()}`);
  const { access_token, expires_in } = await tokRes.json();
  config.tokenCache = { token: access_token, expiry: now + expires_in };
  return access_token;
}

async function signJwtAssertion(unsigned) {
  const pem = rsaPrivateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binaryDer = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const enc = new TextEncoder();
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function loadConfig() {
  if (config) return config;
  const cfgUrl = chrome.runtime.getURL("config.json");
  config = await (await fetch(cfgUrl)).json();

  const saUrl = chrome.runtime.getURL("service-account.json");
  const saJson = await (await fetch(saUrl)).json();
  serviceAccount = { client_email: saJson.client_email, token_uri: saJson.token_uri };
  rsaPrivateKey = saJson.private_key;
  return config;
}

// ===================================================
// === OTMenT v3 — getTargetURLs (Row-Aligned Refs + Site)
// ===================================================
async function getTargetURLs(cfg, resumeRow = null, processedUrls = new Set()) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, urlRange, sheetName } = cfg;

  const startRow = +urlRange.match(/\d+/)[0];

  const urlRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(urlRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: urlVals = [] } = await urlRes.json();

  const endRow = startRow + urlVals.length - 1;

  // Fetch F–L refs
  const refRange = `${sheetName}!F${startRow}:L${endRow}`;
  const refRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(refRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: refVals = [] } = await refRes.json();

  // Site values (column B)
  const siteRange = `${sheetName}!B${startRow}:B${endRow}`;
  const siteRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(siteRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: siteVals = [] } = await siteRes.json();

  // Log values (column U)
  const logRange = `${sheetName}!U${startRow}:U${endRow}`;
  const logRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(logRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: logVals = [] } = await logRes.json();

  let results = [];
  for (let i = 0; i < urlVals.length; i++) {
    const url = (urlVals[i] && urlVals[i][0])?.trim();
    const row = startRow + i;
    if (!url) continue;

    const rowLog = logVals[i] || [];
    const hasLogs = rowLog.some(cell => String(cell || "").trim());
    if (hasLogs) continue;

    // Pad refs to always length 7 (F–L)
    const refs = refVals[i] || [];
    while (refs.length < 7) refs.push("");

    results.push({
      url,
      row,
      refs,
      siteVal: siteVals[i]?.[0] || ""
    });
  }

  if (resumeRow != null) {
    results = results.filter(e => e.row >= resumeRow);
  }

  const seen = new Set();
  results = results.filter(e => {
    if (processedUrls.has(e.url) || seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  return results;
}

async function logToSheet(detailData, sourceRow, cfg, siteValFromEntry = null) {
  try {
    const token = await getServiceAccountToken();
    const { spreadsheetId, detailSheetName, sheetName } = cfg;

    if (!detailData?.length) {
      console.warn("[OTMenT] No detail data to log");
      return;
    }

    const entry = detailData[0]; // first extracted person
    const fullName = entry.Fullname?.trim() || "";
    const phones = entry["Phone Number + Phone Type"] || [];

    // --- Split name
    const nameParts = fullName.split(" ").filter(Boolean);
    const firstName = nameParts.shift() || "";
    const lastName = nameParts.join(" ") || "";

    // --- Limit to 5 phone pairs
    const pairs = phones.slice(0, 5).map(p => {
      const match = p.match(/(\(?\d{3}\)?[ -]?\d{3}-\d{4})\s*(.*)?/);
      return match ? [match[1].trim(), (match[2] || "").trim()] : [p.trim(), ""];
    });

    while (pairs.length < 5) pairs.push(["", ""]);

    // --- Use preloaded siteVal if provided, else fetch from sheet
    let siteVal = siteValFromEntry;
    if (!siteVal) {
      const siteRange = `${sheetName}!B${sourceRow}:B${sourceRow}`;
      const siteRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(siteRange)}?majorDimension=ROWS`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { values: siteVals = [] } = await siteRes.json();
      siteVal = siteVals[0]?.[0] || "";
    }

    // --- Prepare row values
    const values = [
      siteVal,
      firstName,
      lastName,
      pairs[0][0], pairs[0][1],
      pairs[1][0], pairs[1][1],
      pairs[2][0], pairs[2][1],
      pairs[3][0], pairs[3][1],
      pairs[4][0], pairs[4][1]
    ];

    // --- Append to detail sheet
    const appendURL = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(detailSheetName + "!A2")}:append?valueInputOption=USER_ENTERED`;
    const appendBody = { values: [values] };

    const appendRes = await fetch(appendURL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(appendBody)
    });

    if (appendRes.ok) {
      console.log(`[OTMenT] Logged to "${detailSheetName}" successfully (Row ${sourceRow})`);
    } else {
      console.warn(`[OTMenT] Failed to log (Row ${sourceRow})`, await appendRes.text());
    }

  } catch (err) {
    console.error("[OTMenT] logToSheet() error:", err);
  }
}

// ============================================
// === Levenshtein-based Matchmaking
// ============================================

// ─────────────────────────────
// Enhanced similarity options
const NAME_SIM_OPTIONS = {
  dropSingleLetterTokens: true,
  useTokenOverlapWeight: 0.4,
  useFullStringWeight: 0.5,
  useFirstLastBoost: 0.2
};

// Memory‑efficient Levenshtein (two‑row)
function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  if (n < m) [a, b] = [b, a]; // ensure b shorter

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
    for (let k = 0; k <= b.length; k++) prev[k] = cur[k];
  }
  return prev[b.length];
}

// Stronger normalization
function _normalizeForName(s) {
  if (!s) return '';
  const cleaned = String(s)
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const toks = cleaned.split(' ').filter(t => t.length);
  return NAME_SIM_OPTIONS.dropSingleLetterTokens
    ? toks.filter(t => t.length > 1).join(' ')
    : toks.join(' ');
}

function _nameTokens(s) {
  const n = _normalizeForName(s);
  return n ? n.split(' ') : [];
}

// Combined similarity
function similarity(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const aNorm = _normalizeForName(a);
  const bNorm = _normalizeForName(b);
  if (aNorm && aNorm === bNorm) return 1;

  const maxLen = Math.max(aNorm.length, bNorm.length);
  const fullSim = maxLen ? 1 - levenshtein(aNorm, bNorm) / maxLen : 0;

  const aT = _nameTokens(a);
  const bT = _nameTokens(b);
  const aSet = new Set(aT);
  let common = 0;
  for (const t of bT) if (aSet.has(t)) common++;
  const tokenOverlap = (aT.length + bT.length)
    ? (2 * common) / (aT.length + bT.length)
    : 0;

  const firstLastMatch =
    (aT.length && bT.length &&
      (aT[0] === bT[0] ||
       aT[aT.length - 1] === bT[bT.length - 1] ||
       aT[0] === bT[bT.length - 1] ||
       aT[aT.length - 1] === bT[0])) ? 1 : 0;

  const score =
    (NAME_SIM_OPTIONS.useTokenOverlapWeight * tokenOverlap) +
    (NAME_SIM_OPTIONS.useFullStringWeight * fullSim) +
    (NAME_SIM_OPTIONS.useFirstLastBoost * firstLastMatch);

  return Math.max(0, Math.min(1, score));
}

// Backwards‑compatible wrapper
function matchScoreWithExplanation(a, b) {
  if (!a || !b) return { score: 0, explanation: "Empty input" };
  const aNorm = _normalizeForName(a);
  const bNorm = _normalizeForName(b);
  const score = similarity(a, b);
  const dist = levenshtein(aNorm, bNorm);
  return {
    score,
    explanation: `Levenshtein distance: ${dist}, Normalized: "${aNorm}" vs "${bNorm}", Token overlap + first/last heuristics applied`
  };
}

// ─────────────────────────────
// Normalize hrefs helper
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
      console.warn('[OTMenT] Skipping invalid href:', href);
    }
  }
  return out;
}

function normalizeAndSort(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");
}

// ============================================
// === Write result back to Google Sheet
// ============================================
async function writeResult(row, resultText) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, sheetName } = config;
  const range = `${sheetName}!U${row}`;
  const body = { values: [[resultText]] };

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) console.warn(`[OTMenT] Failed to write result for row ${row}:`, await res.text());
}

// ===================================================
// === Wait for Data Extraction Event (Challenge-Aware v2.1)
// ===================================================
async function waitForExtraction(tabId, options = {}) {
  const {
    timeout = 60_000,
    actions = ["dataExtracted", "dataError"],
    once = true,
    debug = false,
    retryOnChallenge = true,
  } = options;

  // --- Step 1: Pre-check page title
  try {
    const [{ title }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.title
    });
    if (debug) console.log(`[waitForExtraction] Title before extraction: "${title}"`);

    if (title && /attention|just a moment/i.test(title)) {
      console.warn(`[waitForExtraction] Challenge title detected ("${title}") — reloading tab...`);
      await chrome.tabs.reload(tabId);
      await new Promise(r => setTimeout(r, 6000)); // ⬅️ wait longer (6 s) before continuing
    }
  } catch (err) {
    console.warn(`[waitForExtraction] Title read failed:`, err);
  }

  // --- Step 2: Wait for extraction or handle retries
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Timeout waiting for extraction on tab ${tabId}`));
    }, timeout);

    async function listener(msg, sender) {
      if (!sender.tab || sender.tab.id !== tabId) return;
      if (!actions.includes(msg.action)) return;

      if (debug) console.log(`[waitForExtraction] Received:`, msg);
      clearTimeout(timer);

      // --- Challenge path
      if (
        msg.action === "dataError" &&
        retryOnChallenge &&
        /attention|just a moment|challenge/i.test(msg.error || "")
      ) {
        console.warn("[waitForExtraction] ⚠️ Challenge reported — waiting longer, then retrying...");

        chrome.runtime.onMessage.removeListener(listener);

        try {
          await chrome.tabs.reload(tabId);

          // ⬇️ Wait for title to stabilize before re-inject
          for (let i = 0; i < 15; i++) { // up to ~15 s
            const [{ title: newTitle }] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => document.title
            });
            if (!/attention|just a moment/i.test(newTitle || "")) break;
            await new Promise(r => setTimeout(r, 1000));
          }

          // Re-inject after page looks normal
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
          });

          console.log("[waitForExtraction] ✅ Retrying extraction after challenge recovery...");

          const retryResult = await waitForExtraction(tabId, {
            timeout,
            actions,
            once,
            debug,
            retryOnChallenge: false,
          });
          settled = true;
          resolve(retryResult);
          return;
        } catch (err) {
          settled = true;
          reject(new Error(`Retry after challenge failed: ${err.message}`));
          return;
        }
      }

      // --- Normal or non-challenge path
      if (once) chrome.runtime.onMessage.removeListener(listener);
      settled = true;
      resolve({
        success: msg.action === "dataExtracted",
        data: msg.data ?? null,
        page: msg.page ?? null,
        raw: msg,
      });
    }

    chrome.runtime.onMessage.addListener(listener);
    if (debug) console.log(`[waitForExtraction] Listening on tab ${tabId}...`);
  });
}

// ============================================
// === Core Navigation Loop (calibrated, row-aligned siteVal)
// ============================================

// --- Sleep helpers ---
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fibSleep() {
  const delay = getFibDelay();
  console.log(`⏱ fibSleep waiting ${delay}ms`);
  await sleep(delay);
}

// ================================================
// === OTMenT v3 — runNavigator (Fibonacci-Integrated)
// ================================================

async function runNavigator() {
  const cfg = await loadConfig();
  const urls = await getTargetURLs(cfg);

  if (urls.length === 0) {
    console.warn("[OTMenT] No URLs to process — aborting.");
    return;
  }

  // Initialize Fibonacci system if not already
  if (!fibDelayPool) initFibDelayPool();

  console.log(`[OTMenT] Starting matchmaking loop (${urls.length} URLs)...`);

  // ============================================
  // === Normalize Configs ===
  // ============================================
  const { rateLimit = {}, retryOptions = {}, requestOptions = {} } = cfg;

  const cooldownEvery = rateLimit.cooldownEvery ?? requestOptions.cooldownEvery ?? 10;
  const cooldownMs = rateLimit.cooldownMs ?? requestOptions.cooldownMs ?? 30000;

  const retryDelayCfg = retryOptions.retryDelayMs ?? { min: 3000, max: 30000 };
  const maxTimeoutRetries = retryOptions.maxTimeoutRetries ?? 2;

  // ============================================
  // === Main Processing Loop ===
  // ============================================
  for (let [i, entry] of urls.entries()) {
    console.log(`[OTMenT] [${i + 1}/${urls.length}] Opening row ${entry.row}: ${entry.url}`);

    const tab = await chrome.tabs.create({ url: entry.url, active: false });
    const tabId = tab.id;

    try {
      // --- Wait for extraction
      const result = await waitForExtraction(tabId, 60000);
      const extracted = result.data || {};
      console.log("[OTMenT] Extracted (from page):", extracted);

      if (entry.url.includes("address")) {
        // ==================================================
        // Result page: Names + Hrefs
        // ==================================================
        const names = Array.isArray(extracted.Names) ? extracted.Names : [];
        const rawHrefs = Array.isArray(extracted.Hrefs) ? extracted.Hrefs : [];
        const hrefs = rawHrefs
          .map(h => (h && h.startsWith("http") ? h : h ? `https://www.peoplesearchnow.com/${h}` : null))
          .filter(Boolean);

        const pairs = [];
        const len = Math.min(names.length, hrefs.length);
        for (let idx = 0; idx < len; idx++) pairs.push({ name: names[idx], href: hrefs[idx] });
        if (names.length > hrefs.length)
          for (let idx = hrefs.length; idx < names.length; idx++) pairs.push({ name: names[idx], href: null });
        if (hrefs.length > names.length)
          for (let idx = names.length; idx < hrefs.length; idx++) pairs.push({ name: null, href: hrefs[idx] });

        if (!pairs.length) {
          console.warn("[OTMenT] No candidate pairs found on result page.");
          await writeResult(entry.row, "NO DATA");
        } else {
          let best = { score: 0, ref: null, name: null, href: null, explanation: "" };

          for (const { name, href } of pairs) {
            for (const ref of entry.refs) {
              if (!ref || !name) continue;
              const { score, explanation } = matchScoreWithExplanation(name, ref);
              if (score > best.score) best = { score, ref, name, href, explanation };
            }
          }

          console.log(`[OTMenT] Best candidate (raw): "${best.name}" vs "${best.ref}" → ${best.score.toFixed(2)}`);
          console.log(`[OTMenT] Why: ${best.explanation}`);
          console.log(`[OTMenT] Distance: ${levenshtein(normalizeAndSort(best.name), normalizeAndSort(best.ref))}`);

          const resultFollowThreshold = Math.max(0.30, (cfg.matchThreshold || 0.50) * 0.6);

          if (best.href && best.score >= resultFollowThreshold) {
            console.log("[OTMenT] Candidate match found — navigating to detail page...");

            await chrome.scripting.executeScript({
              target: { tabId },
              func: (url) => (window.location.href = url),
              args: [best.href],
            });

            // --- Try detail extraction with retries
            let detailResult;
            for (let attempt = 1; attempt <= maxTimeoutRetries; attempt++) {
              try {
                detailResult = await waitForExtraction(tabId, 120000);
                if (detailResult?.data) break;
              } catch (err) {
                console.warn(`[OTMenT] Detail extraction attempt ${attempt} failed: ${err.message}`);
              }

              if (attempt < maxTimeoutRetries) {
                const fibRetryDelay = getFibDelay();
                console.log(`[OTMenT] Retrying after Fibonacci delay (${attempt}): ${fibRetryDelay}ms...`);
                await sleep(fibRetryDelay);

                await chrome.scripting.executeScript({
                  target: { tabId },
                  files: ["content.js"],
                });
              }
            }

            const detailTiles = Array.isArray(detailResult?.data)
              ? detailResult.data
              : detailResult?.data
              ? [detailResult.data]
              : [];

            console.log("[OTMenT] Detail extracted (from content.js):", detailTiles);

            if (!detailTiles.length) {
              console.warn("[OTMenT] No person tiles found on detail page");
              await writeResult(entry.row, "NO DATA");
            } else {
              let bestDetail = { score: 0, ref: null, detailData: null, explanation: "" };
              for (const tile of detailTiles) {
                for (const ref of entry.refs) {
                  if (!ref || !tile?.Fullname || typeof tile.Fullname !== "string") continue;
                  const { score, explanation } = matchScoreWithExplanation(tile.Fullname, ref);
                  if (score > bestDetail.score)
                    bestDetail = { score, ref, detailData: tile, explanation };
                }
              }

              if (bestDetail.detailData) {
                console.log(`[OTMenT] Detail match: "${bestDetail.detailData.Fullname}" vs "${bestDetail.ref}" → ${bestDetail.score.toFixed(2)}`);
                console.log(`[OTMenT] Why: ${bestDetail.explanation}`);

                const phones = bestDetail.detailData["Phone Number + Phone Type"];
                await logToSheet([bestDetail.detailData], entry.row, cfg, entry.siteVal);
                await writeResult(
                  entry.row,
                  `MATCH (${bestDetail.score.toFixed(2)}) — ${bestDetail.detailData.Fullname || ""}${
                    phones?.length ? ` | Phones: ${phones.join(", ")}` : ""
                  }`
                );
              } else {
                console.warn("[OTMenT] No valid matches found on detail page");
                await writeResult(entry.row, `NO MATCH (${bestDetail.score.toFixed(2)})`);
              }
            }
          } else {
            console.warn("[OTMenT] No match on result page or no href available.");
            await writeResult(entry.row, `NO MATCH (${best.score.toFixed(2)})`);
          }
        }
      } else if (entry.url.includes("//name/")) {
        // ==================================================
        // Direct detail page
        // ==================================================
        const detailTiles = Array.isArray(extracted) ? extracted : [extracted];
        let bestDetail = { score: 0, ref: null, detailData: null, explanation: "" };

        for (const tile of detailTiles) {
          for (const ref of entry.refs) {
            if (!ref || !tile?.Fullname || typeof tile.Fullname !== "string") continue;
            const { score, explanation } = matchScoreWithExplanation(tile.Fullname, ref);
            if (score > bestDetail.score) bestDetail = { score, ref, detailData: tile, explanation };
          }
        }

        if (bestDetail.detailData) {
          console.log(`[OTMenT] Detail match: "${bestDetail.detailData.Fullname}" vs "${bestDetail.ref}" → ${bestDetail.score.toFixed(2)}`);
          console.log(`[OTMenT] Why: ${bestDetail.explanation}`);
          const phones = bestDetail.detailData["Phone Number + Phone Type"];
          await logToSheet([bestDetail.detailData], entry.row, cfg, entry.siteVal);
          await writeResult(
            entry.row,
            `MATCH (${bestDetail.score.toFixed(2)}) — ${bestDetail.detailData.Fullname || ""}${
              phones?.length ? ` | Phones: ${phones.join(", ")}` : ""
            }`
          );
        } else {
          console.warn("[OTMenT] No valid matches found on detail page");
          await writeResult(entry.row, `NO MATCH (${bestDetail.score.toFixed(2)})`);
        }
      } else {
        console.warn("[OTMenT] Unknown page type, skipping.");
        await writeResult(entry.row, "SKIPPED (unknown page type)");
      }

      // --- Cooldown (handled by getDelay)
      const cooldownDelay = getDelay();
      await sleep(cooldownDelay);

    } catch (err) {
      console.warn(`[OTMenT] Error on ${entry.url}:`, err.message);
      await writeResult(entry.row, `ERROR: ${err.message}`);
    } finally {
      // --- Always apply a fib delay between runs
      const fibDelay = getFibDelay();
      console.log(`[OTMenT] Sleeping (Fibonacci-based): ${fibDelay}ms`);
      await sleep(fibDelay);

      if (tabId) chrome.tabs.remove(tabId);
    }
  }

  console.log("[OTMenT] Matchmaking process complete.");
}

// ============================================
// === Start
// ============================================
runNavigator();
