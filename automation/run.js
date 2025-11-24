import { loadNodeConfig } from "./loadConfig.js";
import { getServiceAccountToken } from "./auth.js";
import fetch from "node-fetch";

const { config, serviceAccount, rsaPrivateKey } = await loadNodeConfig();

// -----------------------------
// === writeResult() function
// -----------------------------
export async function writeResult(row, resultText) {
  const token = await getServiceAccountToken(config, serviceAccount, rsaPrivateKey);
  const range = `${config.sheetName}!U${row}`;
  const body = { values: [[resultText]] };

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) console.warn(`Failed to write result for row ${row}:`, await res.text());
  else console.log(`✔ Result written for row ${row}`);
}

// -----------------------------
// === logToSheet() function
// -----------------------------
export async function logToSheet(detailData, sourceRow, cfg, siteValFromEntry = null) {
  try {
    if (!detailData?.length) return console.warn("No detail data to log");

    const entry = detailData[0];
    const fullName = entry.Fullname?.trim() || "";
    const phones = entry["Phone Number + Phone Type"] || [];

    const nameParts = fullName.split(" ").filter(Boolean);
    const firstName = nameParts.shift() || "";
    const lastName = nameParts.join(" ") || "";

    const pairs = phones.slice(0, 5).map(p => {
      const match = p.match(/(\(?\d{3}\)?[ -]?\d{3}-\d{4})\s*(.*)?/);
      return match ? [match[1].trim(), (match[2] || "").trim()] : [p.trim(), ""];
    });
    while (pairs.length < 5) pairs.push(["", ""]);

    let siteVal = siteValFromEntry;
    if (!siteVal) {
      const token = await getServiceAccountToken(config, serviceAccount, rsaPrivateKey);
      const siteRange = `${cfg.sheetName}!B${sourceRow}:B${sourceRow}`;
      const siteRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}/values/${encodeURIComponent(siteRange)}?majorDimension=ROWS`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { values: siteVals = [] } = await siteRes.json();
      siteVal = siteVals[0]?.[0] || "";
    }

    const values = [
      siteVal, firstName, lastName,
      pairs[0][0], pairs[0][1],
      pairs[1][0], pairs[1][1],
      pairs[2][0], pairs[2][1],
      pairs[3][0], pairs[3][1],
      pairs[4][0], pairs[4][1]
    ];

    const appendURL = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}/values/${encodeURIComponent(cfg.detailSheetName + "!A2")}:append?valueInputOption=USER_ENTERED`;
    const appendBody = { values: [values] };

    const token = await getServiceAccountToken(config, serviceAccount, rsaPrivateKey);
    const appendRes = await fetch(appendURL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(appendBody)
    });

    if (appendRes.ok) console.log(`✔ Logged to ${cfg.detailSheetName} (Row ${sourceRow})`);
    else console.warn(`Failed to log (Row ${sourceRow})`, await appendRes.text());
  } catch (err) {
    console.error("logToSheet() error:", err);
  }
}

// -----------------------------
// === Example usage
// -----------------------------
(async () => {
  console.log("=== OTMenT GitHub Actions run started ===");

  // Example: writeResult
  await writeResult(2, "Test result from GitHub Actions");

  // Example: logToSheet
  const exampleData = [{
    Fullname: "John Doe",
    "Phone Number + Phone Type": ["(123) 456-7890 mobile"]
  }];
  await logToSheet(exampleData, 2, config);

  console.log("=== OTMenT GitHub Actions run finished ===");
})();
