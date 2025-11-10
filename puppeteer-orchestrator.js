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

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
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

  // Ensure artifacts directories exist
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(OUT_SCREEN_DIR, { recursive: true });

  // Listen for extension messages
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

        const safeName = (parsed.url || "page").replace(/[^a-z0-9]/gi, "_").slice(0, 50);
        const screenshotPath = path.join(OUT_SCREEN_DIR, `${safeName}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {}
    }
  });

  console.log("🔍 Checking loaded extensions...");
  await page.goto("chrome://extensions/", { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 2000)); // replaces page.waitForTimeout

  // Wait for handshake
  const HANDSHAKE_TIMEOUT = 15000;
  const startTime = Date.now();
  while (!handshakeReceived && Date.now() - startTime < HANDSHAKE_TIMEOUT) {
    await new Promise(r => setTimeout(r, 500));
  }

  // Kickoff
  try {
    await page.evaluate(() => {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "startNavigator" });
      }
    });
  } catch {}

  // Keep browser alive
  const MAX_RUNTIME_MS = 5 * 60 * 1000;
  await new Promise(resolve => setTimeout(resolve, MAX_RUNTIME_MS));

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  await browser.close();
  console.log("✅ Puppeteer orchestrator complete.");
})();