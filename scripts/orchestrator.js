// ===================================================
// === OTMenT v3 - Puppeteer Orchestrator (Extension Kickoff)
// ===================================================
import puppeteer from "puppeteer-core";
import fs from "fs";

(async () => {
  const EXT_PATH = process.env.EXTENSION_PATH || "";
  const CHROME_BIN = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";

  console.log("🚀 Launching Chrome with extension:", EXT_PATH || "none");
  console.log("🔧 Using Chrome binary:", CHROME_BIN);
  console.log("📘 Config path:", CONFIG_PATH);

  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=9222",
    "--window-size=1920,1080",
  ];

  if (EXT_PATH) {
    args.push(`--disable-extensions-except=${EXT_PATH}`);
    args.push(`--load-extension=${EXT_PATH}`);
  }

  const browser = await puppeteer.launch({
    headless: false, // force non-headless so extension APIs work
    executablePath: CHROME_BIN,
    args,
  });

  // Open a blank page to trigger extension background worker
  const page = await browser.newPage();
  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
  console.log("✅ Extension loaded — navigator.js will now take over.");

  // Optional: send a kickoff message to the extension
  try {
    await page.evaluate(() => {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "startNavigator" });
        console.log("📨 Kickoff message sent to navigator.js");
      }
    });
  } catch (err) {
    console.warn("⚠️ Could not send kickoff message:", err.message);
  }

  // Keep browser open — extension runs its own loop
  // Or close after a delay if you want CI to finish
  // await browser.close();
})();
