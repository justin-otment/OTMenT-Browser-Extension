const { google } = require("googleapis");

const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = "1rHU_8_9toBx02wsOUTpIbwDOn_0MmLUNTjVmxTPyDhs";
const CITIES_RANGE   = "Cities!A2:A";

const AJ_RANGE       = "Reprocessing!S2:S"; // Full Site Address (primary)
const R_RANGE        = "Reprocessing!Q2:Q"; // Mailing Street (fallback)
const S_RANGE        = "Reprocessing!R2:R"; // Mailing Zip (fallback)
const OUTPUT_RANGE   = "Reprocessing!T2:T";

// --- Dictionaries ---
const streetDict = {
  ST: "Street", "ST.": "Street",
  AVE: "Avenue", "AVE.": "Avenue",
  BLVD: "Boulevard", "BLVD.": "Boulevard",
  RD: "Road", "RD.": "Road",
  DR: "Drive", "DR.": "Drive",
  LN: "Lane", "LN.": "Lane",
  CT: "Court", "CT.": "Court",
  HWY: "Highway", PKWY: "Parkway",
  TER: "Terrace", PL: "Place",
  CTR: "Center", CIR: "Circle",
  EXPY: "Expressway", FWY: "Freeway",
  TPKE: "Turnpike", SQ: "Square",
  WAY: "Way"
};
const dirDict = {
  N: "North", S: "South", E: "East", W: "West",
  NE: "Northeast", NW: "Northwest",
  SE: "Southeast", SW: "Southwest"
};

// --- Helpers ---
function normalize(str) {
  if (!str) return "";
  return String(str)
    .replace(/[\u00A0\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function toUpperTokens(str) {
  return normalize(str).toUpperCase();
}
function cleanStreetSlug(str) {
  const tokens = toUpperTokens(str).split(" ").filter(Boolean);
  const mapped = tokens.map(t => streetDict[t] || dirDict[t] || t);
  return mapped.join(" ")
    .replace(/#/g, " Unit ")
    .replace(/[,\s/]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}
function cleanCitySlugHyphen(city) {
  // Hyphen-separated city words (e.g., cape-coral)
  return toUpperTokens(city)
    .replace(/[,\s/]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}
function parseAddress(full) {
  // "street, City Name, ST" with optional ZIP
  const s = normalize(full);
  const m = s.match(/^(.*?),\s*([A-Za-z .'\-]+),\s*([A-Z]{2})(?:\s+(\d{5}))?$/i);
  if (!m) return null;
  return {
    street: m[1].trim(),
    city: m[2].trim(),
    state: m[3].trim().toLowerCase(),
    zip: m[4] ? m[4].trim() : ""
  };
}
function findCityFromDict(addr, citiesU) {
  const addrU = toUpperTokens(addr);
  const matches = citiesU.filter(c => addrU.includes(c));
  if (matches.length === 0) return "";
  matches.sort((a, b) => b.length - a.length);
  return matches[0];
}
function findStateAbbr(addr) {
  // Allow "FL 33909" or just "FL"
  const s = toUpperTokens(addr);
  const m = s.match(/\b([A-Z]{2})(?:\s+\d{5})?\b/);
  return m ? m[1].toLowerCase() : "";
}
function stripCityStateZip(addr, cityU, state) {
  let s = toUpperTokens(addr);
  if (cityU) {
    s = s.replace(cityU, "").trim();
  }
  if (state) {
    s = s.replace(new RegExp(`\\b${state.toUpperCase()}(?:\\s+\\d{5})?$`), "").trim();
  }
  return s;
}
function buildUrlStreetCityState(street, city, state) {
  if (!street || !city || !state) return "";
  const streetSlug = cleanStreetSlug(street);
  const citySlug = cleanCitySlugHyphen(city);
  return `https://www.peoplesearchnow.com/address/${streetSlug}_${citySlug}-${state}`;
}
function buildUrlStreetZip(street, zip) {
  if (!street) return "";
  const streetSlug = cleanStreetSlug(street);
  const zipSlug = zip ? String(zip).trim() : "";
  return zipSlug
    ? `https://www.peoplesearchnow.com/address/${streetSlug}-${zipSlug}`
    : `https://www.peoplesearchnow.com/address/${streetSlug}`;
}

// --- Main ---
async function main() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // Load cities dictionary (USA-wide list)
  const resCities = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: CITIES_RANGE,
  });
  const rawCities = resCities.data.values ? resCities.data.values.flat().filter(Boolean) : [];
  const citiesU = rawCities.map(v => toUpperTokens(v));

  // Load ranges
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [AJ_RANGE, R_RANGE, S_RANGE],
  });

  const ajVals = res.data.valueRanges[0].values || [];
  const rVals  = res.data.valueRanges[1].values || [];
  const sVals  = res.data.valueRanges[2].values || [];

  const maxLen = Math.max(ajVals.length, rVals.length, sVals.length);
  const pad = (arr) => {
    const out = [];
    for (let i = 0; i < maxLen; i++) {
      out.push(arr[i] ? arr[i][0] : "");
    }
    return out;
  };

  const siteCol   = pad(ajVals); // Full Site Address (primary)
  const streetCol = pad(rVals);  // Mailing Street (fallback)
  const zipCol    = pad(sVals);  // Mailing Zip (fallback)

  const urls = siteCol.map((site, i) => {
    const streetFallback = streetCol[i] || "";
    const zipFallback    = zipCol[i] || "";

    // Primary: try parsing the full site address
    if (site) {
      const parsed = parseAddress(site);
      if (parsed) {
        // Parsed components
        const url = buildUrlStreetCityState(parsed.street, parsed.city, parsed.state);
        if (url) return url;
      }

      // If regex parsing fails, use Cities dict + state abbr to recover city/state
      const cityU = findCityFromDict(site, citiesU); // uppercase match
      const state = findStateAbbr(site);             // lowercase abbr (e.g., fl)
      if (cityU && state) {
        const streetU = stripCityStateZip(site, cityU, state);
        const street = normalize(streetU); // preserve original casing style
        const city = cityU.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); // Title case for slug mapping
        const url = buildUrlStreetCityState(street, city, state);
        if (url) return url;
      }

      // Could not derive city/state → fall back to street+zip or street-only
      if (streetFallback || zipFallback) {
        return buildUrlStreetZip(streetFallback || site, zipFallback);
      }
      return buildUrlStreetZip(site, "");
    }

    // Site empty → fallbacks
    if (streetFallback || zipFallback) {
      return buildUrlStreetZip(streetFallback, zipFallback);
    }

    return "";
  });

  // Diagnostics
  console.log("Sample sites:", siteCol.slice(0, 5));
  console.log("Sample streets:", streetCol.slice(0, 5));
  console.log("Sample zips:", zipCol.slice(0, 5));
  console.log("Sample URLs:", urls.slice(0, 5));

  // Write back
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: OUTPUT_RANGE,
    valueInputOption: "RAW",
    requestBody: {
      values: urls.map(u => [u]),
    },
  });

  console.log("✅ URLs written back to", OUTPUT_RANGE);
}

main().catch(err => console.error(err));