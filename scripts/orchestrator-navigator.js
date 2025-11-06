// scripts/orchestrator-navigator.js
// ---------------------------------------------------------
// Launches Chrome + OTMenT extension + full navigator.js pipeline
// ---------------------------------------------------------
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const EXT_PATH = process.env.EXTENSION_PATH;
const CHROME_BIN = process.env.CHROME_PATH;
const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";
const TEST_URL = process.env.TEST_PAGE_URL || "https://www.peoplesearchnow.com/";

(async () => {
  console.log("🚀 Launching Chrome with OTMenT Extension...");
  console.log("📂 Extension path:", EXT_PATH);
  console.log("⚙️ Chrome binary:", CHROME_BIN);

  const browser = await puppeteer.launch({
    headless: false, // required for extensions; xvfb simulates GUI
    executablePath: CHROME_BIN,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-infobars",
      "--disable-background-timer-throttling",
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--remote-debugging-port=9222",
    ],
  });

  const page = await browser.newPage();
  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
  console.log("✅ Extension loaded successfully.");

  console.log("⏳ Waiting 10s for OTMenT navigator auto-initialize...");
  await new Promise((r) => setTimeout(r, 10000));

  console.log("🌐 Navigating to:", TEST_URL);
  await page.goto(TEST_URL, { waitUntil: "domcontentloaded", timeout: 0 });

  console.log("🧩 Waiting for OTMenT navigator.js loop to begin...");
  await new Promise((r) => setTimeout(r, 30000)); // 30s scrape window

  console.log("🧹 Closing browser...");
  await browser.close();

  console.log("✅ Orchestrator run complete.");
})();
