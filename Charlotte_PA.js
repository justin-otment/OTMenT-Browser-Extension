// ============================
// Node.js version (improved)
// ============================

// Dependencies:
// npm install googleapis selenium-webdriver chromedriver
// ============================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import os from "os";
import { v4 as uuidv4 } from "uuid"; // npm install uuid

// ============================
// Constants & Paths
// ============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHEET_ID = "140GOtFSLYBk4FC50Jd9__Y6SaKSHhfb2PIeap4lKXPE";
const SHEET_NAME = "Port Charlotte";

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
    const element = await driver.wait(
      until.elementLocated(By.xpath(xpath)),
      10000
    );
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
  const sheetMeta = meta.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  if (!sheetMeta) throw new Error(`Sheet not found: ${sheetName}`);
  return sheetMeta.properties.gridProperties; // { rowCount, columnCount }
}

// ============================
// Update Google Sheet (AG:AL)
// ============================
async function updateGoogleSheet(
  sheets,
  i,
  Current_Land_Use,
  Bldg_Info,
  Sale_Date,
  Sale_Amount,
  Owner_Mailing_Street_Address,
  Owner_Mailing_Zipcode,
  DOR_Owner
) {
  const range = `${SHEET_NAME}!G${i}:M${i}`;
  const valuesRow = [
    Current_Land_Use,
    Bldg_Info,
    Sale_Date,
    Sale_Amount,
    Owner_Mailing_Street_Address,
    Owner_Mailing_Zipcode,
    DOR_Owner,
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
async function processRow(url, i, sheets) {
  let driver;
  try {
    const options = new chrome.Options()
      .addArguments("--headless=new")
      .addArguments("--disable-gpu")
      .addArguments("--no-sandbox")
      .addArguments("--disable-dev-shm-usage");

    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();

    console.log(`🌐 Navigating to: ${url}`);
    await driver.get(url);

    await driver.wait(until.elementLocated(By.xpath("/html/body/main/section")), 20000);

    // ✅ Scroll down to load lower elements
    await driver.executeScript("window.scrollTo(0, document.body.scrollHeight)");
    await driver.sleep(1500);

    console.log("✅ Page loaded:", url);

    // Extract values
    const Current_Land_Use = await extractText(
      driver,
      "/html/body/main/section/div/div[3]/div/div[1]/div/div[3]/div[2]"
    );

    const Bldg_Info = await extractText(
      driver,
      "/html/body/main/section/div/div[10]/div/table/tbody/tr[2]/td[2]"
    );

    const Sale_Date = await extractText(
      driver,
      "/html/body/main/section/div/div[3]/div/div[2]/div/div[1]/table/tbody/tr[1]/td[1]"
    );

    const Sale_Amount = await extractText(
      driver,
      "/html/body/main/section/div/div[3]/div/div[2]/div/div[1]/table/tbody/tr[1]/td[4]"
    );

    // ✅ Mailing block extraction via JS
    const mailingBlock = await driver.findElement(
      By.xpath("/html/body/main/section/div/div[2]/div/div[1]/div[1]")
    );

    const mailingHtml = await mailingBlock.getAttribute("innerHTML");
    const lines = mailingHtml
      .replace(/&nbsp;/g, " ")
      .split(/<br\s*\/?>/i)
      .map((s) => s.replace(/<[^>]+>/g, "").trim())
      .filter((s) => s.length > 0);

    let DOR_Owner = "Not Found";
    let Owner_Mailing_Street_Address = "Not Found";
    let Owner_Mailing_Zipcode = "Not Found";

    if (lines.length >= 3) {
      DOR_Owner = lines[0];
      Owner_Mailing_Street_Address = lines[1];
      Owner_Mailing_Zipcode = lines[2];
    }

    // ✅ Update Google Sheet
    await updateGoogleSheet(
      sheets,
      i,
      Current_Land_Use,
      Bldg_Info,
      Sale_Date,
      Sale_Amount,
      Owner_Mailing_Street_Address,
      Owner_Mailing_Zipcode,
      DOR_Owner
    );

    console.log(`✅ Row ${i} completed.`);
  } catch (err) {
    console.error(`❌ Error processing row ${i}:`, err.message);
  } finally {
    if (driver) await driver.quit();
    console.log(`🚪 Closed browser instance for Row ${i}\n`);
  }
}

// ============================
// Fetch & Process Data
// ============================
async function fetchDataAndUpdateSheet() {
  const sheets = await authenticateGoogleSheets();

  const START_ROW = 4404;
  const grid = await getSheetGridProperties(sheets, SHEET_ID, SHEET_NAME);
  const maxRows = grid.rowCount;

  const safeRange = `${SHEET_NAME}!A${START_ROW}:A${maxRows}`;
  console.log(`Using safe range: ${safeRange}`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: safeRange,
  });

  const rows = res.data.values || [];

  for (let idx = 0; idx < rows.length; idx++) {
    const url = rows[idx][0]?.trim();
    const rowIndex = START_ROW + idx;

    if (!url) {
      console.log(`Skipping empty row ${rowIndex}`);
      continue;
    }

    console.log(`Processing Row ${rowIndex}: ${url}`);
    await processRow(url, rowIndex, sheets);
  }

  console.log("🚀 All rows have been processed.");
}

// ============================
// Run main
// ============================
fetchDataAndUpdateSheet().catch((err) => {
  console.error("Fatal error:", err);
});
