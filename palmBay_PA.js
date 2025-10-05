// ============================
// Node.js version of your script (fixed)
// ============================

// Dependencies:
// npm install googleapis selenium-webdriver chromedriver
// ============================

// Imports
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { v4 as uuidv4 } from "uuid"; // npm install uuid
import os from "os";

// ============================
// Constants & Paths
// ============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHEET_ID = "1rHU_8_9toBx02wsOUTpIbwDOn_0MmLUNTjVmxTPyDhs";
const SHEET_NAME = "CAPE CORAL FINAL";

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// ============================
// Authenticate Google Sheets
// ============================
async function authenticateGoogleSheets() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  let token;
  if (fs.existsSync(TOKEN_PATH)) {
    token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  }

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  if (!token) {
    throw new Error("❌ No token.json found. Run OAuth2 flow first.");
  }

  oAuth2Client.setCredentials(token);
  return google.sheets({ version: "v4", auth: oAuth2Client });
}

// ============================
// Safe extract helper
// ============================
async function extractText(driver, xpath, defaultValue = "Not Found") {
  try {
    const element = await driver.wait(until.elementLocated(By.xpath(xpath)), 60000);
    return (await element.getText()).trim();
  } catch {
    return defaultValue;
  }
}

// ============================
// Helper: get sheet gridProperties
// ============================
async function getSheetGridProperties(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title,gridProperties(rowCount,columnCount)))",
  });
  const sheetMeta = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheetMeta) throw new Error(`Sheet not found: ${sheetName}`);
  return sheetMeta.properties.gridProperties; // { rowCount, columnCount }
}

// ============================
// Update Google Sheet (single API call per row: AG:AL)
// ============================
async function updateGoogleSheet(
  sheets,
  i,
  ownershipText,
  additionalText,
  propertyValue,
  bldgInfo,
  saleData,
  saleAmount
) {
  // Build one row of 6 columns AG:AL
  const range = `${SHEET_NAME}!AG${i}:AL${i}`;
  const valuesRow = [
    ownershipText,
    additionalText,
    propertyValue,
    bldgInfo,
    saleData,
    saleAmount,
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [valuesRow] },
  });
}

// ============================
// Process one row
// ============================
async function processRow(site, i, sheets) {
  let driver;
  const baseTemp = "C:\\Temp\\c"; // Short, safe folder
  if (!fs.existsSync(baseTemp)) fs.mkdirSync(baseTemp, { recursive: true });
  const profileDir = path.join(baseTemp, `p-${uuidv4()}`);

  try {
    const options = new chrome.Options()
      .addArguments("--headless=new")                  // modern headless
      .addArguments("--disable-gpu")
      .addArguments("--no-sandbox")
      .addArguments("--disable-dev-shm-usage")
      .addArguments("--disable-application-cache")     // disable app cache
      .addArguments("--disable-cache")                 // disable disk cache
      .addArguments("--disk-cache-size=0")             // disable disk cache
      .addArguments("--no-first-run")                  // avoid prefs writing
      .addArguments("--no-default-browser-check")     // avoid first-run check
      .addArguments("--disable-extensions")           // minimal profile
      .addArguments(`--user-data-dir=${profileDir}`); // isolated, safe profile

    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();

    await driver.get("https://www.bcpao.us/propertysearch/#/nav/Search");

    const siteInput = await driver.wait(
      until.elementLocated(By.css("#txtPropertySearch_Pid")),
      60000
    );
    await siteInput.sendKeys(site, Key.RETURN);

    await driver.wait(
      until.elementLocated(
        By.xpath('//*[@id="cssDetails_Top_Outer"]/div[2]/div/div[1]/div[2]/div[1]')
      ),
      60000
    );

    console.log("✅ Result loaded for site:", site);

    // Extract values
    const ownershipText = await extractText(driver, '//*[@id="cssDetails_Top_Outer"]/div[2]/div/div[1]/div[2]/div[1]');
    const additionalText = await extractText(driver, '//*[@id="cssDetails_Top_Outer"]/div[2]/div/div[2]/div[2]/div');
    const propertyValue = await extractText(driver, '//*[@id="tValues"]/tbody/tr[1]/td[2]');
    const bldgInfo = await extractText(driver, '//*[@id="cssDetails_Top_Outer"]/div[2]/div/div[7]/div[2]');
    const saleData = await extractText(driver, '//*[@id="tSalesTransfers"]/tbody/tr[1]/td[1]');
    const saleAmount = await extractText(driver, '//*[@id="tSalesTransfers"]/tbody/tr[1]/td[2]');

    await updateGoogleSheet(
      sheets,
      i,
      ownershipText,
      additionalText,
      propertyValue,
      bldgInfo,
      saleData,
      saleAmount
    );

    console.log(`✅ Row ${i} completed.`);
  } catch (err) {
    console.error(`❌ Error processing row ${i}:`, err.message);
  } finally {
    if (driver) {
      await driver.quit();
    }

    // Clean up temp profile folder after quitting
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`⚠️ Could not remove temp profile: ${profileDir}`);
    }

    console.log(`🚪 Closed browser instance for Row ${i}\n`);
  }
}

// ============================
// Fetch & Process Data (safe range, maps rows correctly)
// ============================
async function fetchDataAndUpdateSheet() {
  const sheets = await authenticateGoogleSheets();

  // Requested start row in your original script
  const REQUEST_START_ROW = 16782;

  // Get sheet metadata and clamp the range
  const grid = await getSheetGridProperties(sheets, SHEET_ID, SHEET_NAME);
  const maxRows = grid.rowCount;

  if (REQUEST_START_ROW > maxRows) {
    console.log(
      `Requested start row ${REQUEST_START_ROW} is beyond sheet rowCount ${maxRows}. Nothing to fetch.`
    );
    return;
  }

  const safeRange = `${SHEET_NAME}!A${REQUEST_START_ROW}:A${maxRows}`;
  console.log(`Using safe range: ${safeRange}`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: safeRange,
  });

  const rows = res.data.values || [];

  // rows[0] corresponds to sheet row REQUEST_START_ROW
  for (let idx = 0; idx < rows.length; idx++) {
    const site = rows[idx][0]?.trim();
    const rowIndex = REQUEST_START_ROW + idx; // actual sheet row number
    console.log(`Processing Row ${rowIndex}: ${site}`);

    if (!site) {
      console.log(`Skipping empty row ${rowIndex}`);
      continue;
    }

    await processRow(site, rowIndex, sheets);
  }

  console.log("🚀 All rows have been processed.");
}

// ============================
// Run main
// ============================
fetchDataAndUpdateSheet().catch((err) => {
  console.error("Fatal error:", err);
});