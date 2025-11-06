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

  // --- Load config.json
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const testUrls = [
    "https://www.peoplesearchnow.com/address/195-new-lots-avenue_brooklyn-ny",
    "https://www.peoplesearchnow.com/address/2702-6th-street-southwest_lehigh-acres-fl",
  ]; // fallback if no Sheets URLs available

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
  await page.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
  console.log("✅ Extension loaded and Chrome launched");

  // --- Listen for messages from the extension
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
        console.warn("⚠ Failed to parse dataExtracted message:", text);
      }
    }
  });

  // --- Loop through test URLs
  for (const url of testUrls) {
    console.log(`🌐 Visiting: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(10000); // give OTMenT time to scrape
  }

  // --- Save results for diagnostics
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`💾 Results saved to ${OUT_PATH}`);

  // --- Keep browser alive briefly for logs then close
  await page.waitForTimeout(3000);
  await browser.close();
  console.log("✅ Puppeteer orchestrator complete");
})();
