// ===================================================
// === OTMenT v3 - Puppeteer Orchestrator (CI Mode) ===
// ===================================================
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

(async () => {
  const EXT_PATH = process.env.EXTENSION_PATH;
  const CHROME_BIN = process.env.CHROME_PATH;
  const CONFIG_PATH = process.env.CONFIG_PATH || "config.json";
  const OUT_PATH = "artifacts/diagnostics/dataExtracted.json";

  console.log("🚀 Launching Chrome with extension:", EXT_PATH);
  console.log("🔧 Using Chrome binary:", CHROME_BIN);
  console.log("📘 Config path:", CONFIG_PATH);

  // --- Load config.json (optional)
  let testUrls = [
    "https://www.peoplesearchnow.com/address/195-new-lots-avenue_brooklyn-ny",
    "https://www.peoplesearchnow.com/address/2702-6th-street-southwest_lehigh-acres-fl",
  ];
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (Array.isArray(cfg.startUrl) && cfg.startUrl.length) {
      testUrls = cfg.startUrl;
      console.log("✅ Loaded URLs from config.json");
    }
  } catch {
    console.log("⚠️ Could not read config.json, using fallback URLs.");
  }

  // --- Launch Chrome
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_BIN,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--remote-debugging-port=9222",
      "--window-size=1920,1080",
    ],
  });

  const [page] = await browser.pages();

  // --- Compatibility-safe delay helper
  const sleep = async (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
  console.log("✅ Extension loaded and Chrome launched");

  // --- Listen for logs emitted by the extension
  const results = [];
  page.on("console", async (msg) => {
    const text = msg.text();
    if (text.includes("dataExtracted")) {
      try {
        const jsonPart = text.split("dataExtracted:")[1].trim();
        const parsed = JSON.parse(jsonPart);
        console.log("📦 Received dataExtracted payload:", parsed);
        results.push(parsed);
      } catch (err) {
        console.warn("⚠️ Failed to parse dataExtracted message:", text);
      }
    }
  });

  // --- Loop through URLs
  for (const url of testUrls) {
    console.log(`🌐 Visiting: ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(10000); // give OTMenT time to scrape
    } catch (err) {
      console.warn(`⚠️ Failed to visit ${url}: ${err.message}`);
    }
  }

  // --- Save results
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`💾 Results saved to ${OUT_PATH}`);

  await sleep(3000);
  await browser.close();
  console.log("✅ Puppeteer orchestrator complete");
})();
