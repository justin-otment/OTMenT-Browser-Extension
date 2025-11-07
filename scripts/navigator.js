// ===================================================
// === OTMenT v3 — navigator.js (Autonomous Orchestrator)
// ===================================================

console.log("[OTMenT] Navigator initialized. Fetching URLs...");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getConfig") {
    sendResponse(config);
  }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// === getTargetURLs (Row-Aligned Refs + Site)
// ===================================================
async function getTargetURLs(cfg, resumeRow = null, processedUrls = new Set()) {
  const token = await getServiceAccountToken();
  const { spreadsheetId, urlRange, sheetName } = cfg;

  const startRow = +urlRange.match(/\d+/)[0];
  const colLetter = urlRange.match(/!([A-Z]+)\d+/)[1];

  const urlRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(urlRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: urlVals = [] } = await urlRes.json();

  const endRow = startRow + urlVals.length - 1;
  const refRange = `${sheetName}!F${startRow}:L${endRow}`;
  const refRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(refRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: refVals = [] } = await refRes.json();

  const siteRange = `${sheetName}!B${startRow}:B${endRow}`;
  const siteRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(siteRange)}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { values: siteVals = [] } = await siteRes.json();

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

    results.push({
      url,
      row,
      refs: refVals[i] || [],
      siteVal: siteVals[i]?.[0] || ""
    });
  }

  if (resumeRow != null) results = results.filter(e => e.row >= resumeRow);

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
      console.warn("[OTMenT] ⚠️ No detail data to log");
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
      console.log(`[OTMenT] ✅ Logged to "${detailSheetName}" successfully (Row ${sourceRow})`);
    } else {
      console.warn(`[OTMenT] ⚠️ Failed to log (Row ${sourceRow})`, await appendRes.text());
    }

  } catch (err) {
    console.error("[OTMenT] ❌ logToSheet() error:", err);
  }
}

// ============================================
// === Levenshtein-based Matchmaking
// ============================================
function normalize(s) {
  return s
    ? s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function levenshtein(a, b) {
  const m = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b[i - 1] === a[j - 1]
        ? m[i - 1][j - 1]
        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

function levenshteinSim(a, b) {
  if (!a || !b) return 0;
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  const dist = levenshtein(x, y);
  return 1 - dist / Math.max(x.length, y.length);
}

// Backward-compatible wrapper (keeps your logging code untouched)
function matchScoreWithExplanation(a, b) {
  if (!a || !b) return { score: 0, explanation: "Empty input" };
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return { score: 0, explanation: "No normalized tokens" };
  const dist = levenshtein(x, y);
  const score = 1 - dist / Math.max(x.length, y.length);
  return { score, explanation: `Levenshtein distance: ${dist}, Normalized: "${x}" vs "${y}"` };
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

// ============================================
// === Listen for Extraction
// ============================================
function waitForExtraction(tabId, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Timeout waiting for extraction"));
    }, timeout);

    function listener(msg, sender) {
      if ((msg.action === "dataExtracted" || msg.action === "dataError") && sender.tab && sender.tab.id === tabId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg); // includes msg.data and msg.page
      }
    }

    chrome.runtime.onMessage.addListener(listener);
  });
}

// ============================================
// === Core Navigation Loop (calibrated, row-aligned siteVal)
// ============================================
async function runNavigator() {
  const cfg = await loadConfig();
  const urls = await getTargetURLs(cfg);
  if (urls.length === 0) {
    console.warn("[OTMenT] No URLs to process — aborting.");
    return;
  }

  console.log(`[OTMenT] Starting matchmaking loop (${urls.length} URLs)...`);

  for (let [i, entry] of urls.entries()) {
    console.log(`[OTMenT] [${i + 1}/${urls.length}] Opening row ${entry.row}: ${entry.url}`);

    const tab = await chrome.tabs.create({ url: entry.url, active: false });
    const tabId = tab.id;

    try {
      // Wait for content.js to extract and send back data
      const result = await waitForExtraction(tabId);
      const extracted = result.data || {};
      console.log("[OTMenT] Extracted (from page):", extracted);

      if (entry.url.includes("address")) {
        // ================================
        // Result page: Names + Hrefs
        // ================================
        const names = Array.isArray(extracted.Names) ? extracted.Names : [];
        const rawHrefs = Array.isArray(extracted.Hrefs) ? extracted.Hrefs : [];
        const hrefs = rawHrefs
          .map(h => h && h.startsWith("http") ? h : (h ? `https://www.peoplesearchnow.com/${h}` : null))
          .filter(Boolean);

        const pairs = [];
        const len = Math.min(names.length, hrefs.length);
        for (let idx = 0; idx < len; idx++) pairs.push({ name: names[idx], href: hrefs[idx] });
        if (names.length > hrefs.length) for (let idx = hrefs.length; idx < names.length; idx++) pairs.push({ name: names[idx], href: null });
        if (hrefs.length > names.length) for (let idx = names.length; idx < hrefs.length; idx++) pairs.push({ name: null, href: hrefs[idx] });

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
          console.log(`[OTMenT] Best candidate (normalized): "${normalize(best.name)}" vs "${normalize(best.ref)}"`);
          console.log(`[OTMenT] Why: ${best.explanation}`);
          console.log(`[OTMenT] Distance: ${levenshtein(normalize(best.name), normalize(best.ref))}`);

          const resultFollowThreshold = Math.max(0.30, (cfg.matchThreshold || 0.50) * 0.6);

          if (best.href && best.score >= resultFollowThreshold) {
            console.log("[OTMenT] ✅ Candidate match found — navigating to detail page in same tab.");

            // --- Navigate current tab to detail page
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (url) => { window.location.href = url; },
              args: [best.href]
            });

            // --- Wait for detail extraction
            const detailResult = await waitForExtraction(tabId, 120000);
            const detailTiles = Array.isArray(detailResult?.data)
              ? detailResult.data
              : detailResult?.data
              ? [detailResult.data]
              : [];

            console.log("[OTMenT] Detail extracted (from content.js):", detailTiles);

            if (!detailTiles.length) {
              console.warn("[OTMenT] ❌ No person tiles found on detail page");
              await writeResult(entry.row, "NO DATA");
            } else {
              let bestDetail = { score: 0, ref: null, detailData: null, explanation: "" };

              for (const tile of detailTiles) {
                for (const ref of entry.refs) {
                  if (!ref || !tile || !tile.Fullname || typeof tile.Fullname !== "string") continue;
                  const { score, explanation } = matchScoreWithExplanation(tile.Fullname, ref);
                  if (score > bestDetail.score) bestDetail = { score, ref, detailData: tile, explanation };
                }
              }

              if (bestDetail.detailData) {
                console.log(`[OTMenT] Detail match (raw): "${bestDetail.detailData.Fullname}" vs "${bestDetail.ref}" → ${bestDetail.score.toFixed(2)}`);
                console.log(`[OTMenT] Detail match (normalized): "${normalize(bestDetail.detailData.Fullname)}" vs "${normalize(bestDetail.ref)}"`);
                console.log(`[OTMenT] Why: ${bestDetail.explanation}`);
                console.log(`[OTMenT] Distance: ${levenshtein(normalize(bestDetail.detailData.Fullname), normalize(bestDetail.ref))}`);

                const phones = bestDetail.detailData["Phone Number + Phone Type"];
                await logToSheet([bestDetail.detailData], entry.row, cfg, entry.siteVal); // <--- use row-aligned siteVal
                await writeResult(
                  entry.row,
                  `MATCH (${bestDetail.score.toFixed(2)}) — ${bestDetail.detailData.Fullname || ""}${phones?.length ? ` | Phones: ${phones.join(", ")}` : ""}`
                );
              } else {
                console.warn("[OTMenT] ❌ No valid matches found on detail page");
                await writeResult(entry.row, `NO MATCH (${bestDetail.score.toFixed(2)})`);
              }
            }

          } else {
            console.warn("[OTMenT] ❌ No match on result page or no href available.");
            await writeResult(entry.row, `NO MATCH (${best.score.toFixed(2)})`);
          }
        }

      } else if (entry.url.includes("//name/")) {
        // ================================
        // Direct detail page
        // ================================
        const detailTiles = Array.isArray(extracted) ? extracted : [extracted];
        let bestDetail = { score: 0, ref: null, detailData: null, explanation: "" };

        for (const tile of detailTiles) {
          for (const ref of entry.refs) {
            if (!ref || !tile || !tile.Fullname || typeof tile.Fullname !== "string") continue;
            const { score, explanation } = matchScoreWithExplanation(tile.Fullname, ref);
            if (score > bestDetail.score) bestDetail = { score, ref, detailData: tile, explanation };
          }
        }

        if (bestDetail.detailData) {
          console.log(`[OTMenT] Detail match (raw): "${bestDetail.detailData.Fullname}" vs "${bestDetail.ref}" → ${bestDetail.score.toFixed(2)}`);
          console.log(`[OTMenT] Detail match (normalized): "${normalize(bestDetail.detailData.Fullname)}" vs "${normalize(bestDetail.ref)}"`);
          console.log(`[OTMenT] Why: ${bestDetail.explanation}`);
          console.log(`[OTMenT] Distance: ${levenshtein(normalize(bestDetail.detailData.Fullname), normalize(bestDetail.ref))}`);

          const phones = bestDetail.detailData["Phone Number + Phone Type"];
          await logToSheet([bestDetail.detailData], entry.row, cfg, entry.siteVal); // <--- use row-aligned siteVal
          await writeResult(
            entry.row,
            `MATCH (${bestDetail.score.toFixed(2)}) — ${bestDetail.detailData.Fullname || ""}${phones?.length ? ` | Phones: ${phones.join(", ")}` : ""}`
          );
        } else {
          console.warn("[OTMenT] ❌ No valid matches found on detail page");
          await writeResult(entry.row, `NO MATCH (${bestDetail.score.toFixed(2)})`);
        }

      } else {
        console.warn("[OTMenT] Unknown page type, skipping.");
        await writeResult(entry.row, "SKIPPED (unknown page type)");
      }

      // Apply cooldown every N iterations
      if (i > 0 && i % (cfg.rateLimit?.cooldownEvery || 8) === 0) {
        console.log("[OTMenT] Cooling down...");
        await sleep(cfg.rateLimit?.cooldownMs || 30000);
      }

    } catch (err) {
      console.warn(`[OTMenT] ⚠️ Error on ${entry.url}:`, err.message);
      await writeResult(entry.row, `ERROR: ${err.message}`);
    } finally {
      await sleep(cfg.requestOptions?.incrementMs || 200);
      if (tabId) chrome.tabs.remove(tabId);
    }
  }

  console.log("[OTMenT] ✅ Matchmaking process complete.");
}

// ============================================
// === Start
// ============================================
runNavigator();
