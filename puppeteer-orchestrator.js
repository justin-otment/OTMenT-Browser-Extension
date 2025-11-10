// puppeteer-orchestrator.js
// ============================================
// Automated orchestrator for Chrome Extension
// Now with automatic screenshots every 3 seconds
// ============================================

import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

(async () => {
  const EXT_PATH = process.env.EXTENSION_PATH || `${process.cwd()}/dist`;
  const CHROME_BIN = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";
  const OUT_JSON = "artifacts/diagnostics/dataExtracted.json";
  const OUT_SCREEN_DIR = "artifacts/screenshots";
  const USER_DATA_DIR = "/tmp/chrome-profile";

  console.log("🚀 Launching Chrome with extension:", EXT_PATH);
  console.log("🔧 Using Chrome binary:", CHROME_BIN);
  console.log("📘 Config path:", CONFIG_PATH);

  // ------------------------------------------------
  // 1️⃣ Launch Chrome
  // ------------------------------------------------
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-extensions-except=" + EXT_PATH,
    "--load-extension=" + EXT_PATH,
    "--remote-debugging-port=9222",
    "--window-size=1920,1080",
    "--user-data-dir=" + USER_DATA_DIR
  ];

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_BIN,
    args
  });

  const [page] = await browser.pages();

  // ------------------------------------------------
  // 2️⃣ Ensure artifact directories exist
  // ------------------------------------------------
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(OUT_SCREEN_DIR, { recursive: true });

  // ------------------------------------------------
  // 3️⃣ Listen for console messages from extension
  // ------------------------------------------------
  const results = [];
  let handshakeReceived = false;

  page.on("console", async (msg) => {
    const text = msg.text();
    if (text.includes("dataExtracted:ready")) handshakeReceived = true;

    if (text.includes("dataExtracted:")) {
      try {
        const jsonPart = text.split("dataExtracted:")[1].trim();
        const parsed = JSON.parse(jsonPart);
        results.push(parsed);

        const safeName = (parsed.url || "page")
          .replace(/[^a-z0-9]/gi, "_")
          .slice(0, 50);
        const screenshotPath = path.join(
          OUT_SCREEN_DIR,
          `${safeName}_${Date.now()}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`📸 Captured on dataExtracted: ${screenshotPath}`);
      } catch (err) {
        console.error("⚠️ Failed to parse dataExtracted JSON:", err.message);
      }
    }
  });

  // ------------------------------------------------
  // 4️⃣ Initial extension check
  // ------------------------------------------------
  console.log("🔍 Checking loaded extensions...");
  await page.goto("chrome://extensions/", { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2000)); // 2s buffer

  // ------------------------------------------------
  // 5️⃣ Wait for handshake from extension
  // ------------------------------------------------
  const HANDSHAKE_TIMEOUT = 15000;
  const startTime = Date.now();
  while (!handshakeReceived && Date.now() - startTime < HANDSHAKE_TIMEOUT) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // ------------------------------------------------
  // 6️⃣ Kick off extension message
  // ------------------------------------------------
  try {
    await page.evaluate(() => {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "startNavigator" });
      }
    });
  } catch (err) {
    console.warn("⚠️ Could not trigger navigator:", err.message);
  }

  // ------------------------------------------------
  // 7️⃣ Automatic screenshot loop (every 3 seconds)
  // ------------------------------------------------
  const SCREENSHOT_INTERVAL_MS = 3000;
  let screenshotCounter = 0;

  const periodicScreenshots = setInterval(async () => {
    try {
      const filePath = path.join(
        OUT_SCREEN_DIR,
        `auto_${String(screenshotCounter++).padStart(3, "0")}.png`
      );
      await page.screenshot({ path: filePath, fullPage: true });
      console.log(`📸 [Auto] Screenshot captured: ${filePath}`);
    } catch (err) {
      console.error("⚠️ Auto screenshot failed:", err.message);
    }
  }, SCREENSHOT_INTERVAL_MS);

  // ------------------------------------------------
  // 8️⃣ Keep browser alive for configured duration
  // ------------------------------------------------
  const MAX_RUNTIME_MS = parseInt(process.env.MAX_RUNTIME_MS || (5 * 60 * 1000), 10);
  await new Promise((resolve) => setTimeout(resolve, MAX_RUNTIME_MS));

  clearInterval(periodicScreenshots);

  // ------------------------------------------------
  // 9️⃣ Save captured data & cleanup
  // ------------------------------------------------
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  await browser.close();
  console.log("✅ Puppeteer orchestrator complete.");
})();
