// scripts/orchestrator.js
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

(async () => {
  const EXT_PATH = process.env.EXTENSION_PATH;
  const CHROME_BIN = process.env.CHROME_PATH;
  const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";

  console.log("🚀 Launching Chrome with extension:", EXT_PATH);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_BIN,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--remote-debugging-port=9222",
    ],
  });

  const page = await browser.newPage();
  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
  console.log("✅ Extension loaded and Chrome launched");

  // ---- Simulate OTMenT startup (navigator.js auto-run)
  console.log("⏳ Waiting for OTMenT navigator to begin...");
  await new Promise(r => setTimeout(r, 8000));

  // Optionally open a test address page to trigger scraping
  await page.goto("https://www.peoplesearchnow.com/address/9111-east-bay-drive-unit-6f-bal-harbour_harbor-fl", {
    waitUntil: "domcontentloaded",
  });

  console.log("🧩 Opened test address page, OTMenT should auto-run its loop");

  // Keep session alive for inspection or run duration
  await new Promise(r => setTimeout(r, 30000));
  await browser.close();
})();
