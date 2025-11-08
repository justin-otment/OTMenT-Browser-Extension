// ===================================================
// === OTMenT v3 - Puppeteer Orchestrator (Extension Kickoff + Screenshots)
// ===================================================
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

(async () => {
  const EXT_PATH = process.env.EXTENSION_PATH || "";
  const CHROME_BIN = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";
  const OUT_JSON = "artifacts/diagnostics/dataExtracted.json";
  const OUT_SCREEN_DIR = "artifacts/screenshots";

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

  const [page] = await browser.pages();
  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
  console.log("✅ Extension loaded — navigator.js will now take over.");

  // --- Prepare artifact directories
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(OUT_SCREEN_DIR, { recursive: true });

  const results = [];

  // --- Listen for extension console messages
  page.on("console", async (msg) => {
    const text = msg.text();
    if (text.includes("dataExtracted")) {
      try {
        const jsonPart = text.split("dataExtracted:")[1].trim();
        const parsed = JSON.parse(jsonPart);
        console.log("📦 Received dataExtracted payload:", parsed);
        results.push(parsed);

        // --- Capture screenshot when data arrives
        const safeName = (parsed.url || "page")
          .replace(/[^a-z0-9]/gi, "_")
          .slice(0, 50);
        const screenshotPath = path.join(OUT_SCREEN_DIR, `${safeName}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`📸 Screenshot saved: ${screenshotPath}`);
      } catch (err) {
        console.warn("⚠️ Failed to parse dataExtracted message:", text);
      }
    }
  });

  // --- Optional: send kickoff message to extension
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

  // --- Keep browser open until extension finishes
  // In CI you may want to set a max runtime and then close
  // For example, wait 5 minutes then save results and exit:
  const MAX_RUNTIME_MS = 5 * 60 * 1000;
  await new Promise((resolve) => setTimeout(resolve, MAX_RUNTIME_MS));

  // --- Save collected results
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  console.log(`💾 Results saved to ${OUT_JSON}`);

  await browser.close();
  console.log("✅ Puppeteer orchestrator complete (extension + screenshots)");
})();
