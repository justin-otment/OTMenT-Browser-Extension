// ===================================================
// === OTMenT v3.1 - Puppeteer Orchestrator (Extension Kickoff + Diagnostics)
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
  const USER_DATA_DIR = "/tmp/chrome-profile";

  console.log("🚀 Launching Chrome with extension:", EXT_PATH || "none");
  console.log("🔧 Using Chrome binary:", CHROME_BIN);
  console.log("📘 Config path:", CONFIG_PATH);

  // ===================================================
  // === Launch Arguments (realistic desktop simulation)
  // ===================================================
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-port=9222",
    "--window-size=1920,1080",
    `--user-data-dir=${USER_DATA_DIR}`,
    "--profile-directory=Default",
  ];

  if (EXT_PATH) {
    args.push(`--disable-extensions-except=${EXT_PATH}`);
    args.push(`--load-extension=${EXT_PATH}`);
  }

  // ===================================================
  // === Launch Chrome (must be non-headless)
  // ===================================================
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_BIN,
    args,
  });

  const [page] = await browser.pages();

  // ===================================================
  // === Load Extensions Page & Verify Activation
  // ===================================================
  await page.goto("chrome://extensions/", { waitUntil: "load" });

  console.log("🔍 Checking loaded extensions...");
  await page.waitForTimeout(2000);

  const extensions = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("extensions-item"));
    return items.map((el) => ({
      name: el.shadowRoot?.querySelector("#name")?.innerText || "unknown",
      id: el.getAttribute("id"),
      version: el.getAttribute("version"),
      enabled:
        el.shadowRoot?.querySelector("#enableToggle")?.hasAttribute("checked") ||
        false,
    }));
  });

  console.log("🧩 Detected extensions:", extensions);

  const ourExt = extensions.find((e) => e.enabled);
  if (!ourExt) {
    console.warn("⚠️  No active extension detected. Chrome may have blocked it.");
  } else {
    console.log(`✅ Extension "${ourExt.name}" is active (id: ${ourExt.id})`);
  }

  // ===================================================
  // === Artifact Setup
  // ===================================================
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.mkdirSync(OUT_SCREEN_DIR, { recursive: true });

  const results = [];

  // ===================================================
  // === Listen for Extension Console Messages
  // ===================================================
  page.on("console", async (msg) => {
    const text = msg.text();
    if (text.includes("dataExtracted")) {
      try {
        const jsonPart = text.split("dataExtracted:")[1].trim();
        const parsed = JSON.parse(jsonPart);
        console.log("📦 Received dataExtracted payload:", parsed);
        results.push(parsed);

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

  // ===================================================
  // === Diagnostic: Log background pages / workers
  // ===================================================
  const targets = await browser.targets();
  const bgPages = targets.filter((t) => t.type() === "background_page");
  const serviceWorkers = targets.filter((t) => t.type() === "service_worker");

  console.log("🧠 Extension background pages:", bgPages.map((t) => t.url()));
  console.log("🧠 Extension service workers:", serviceWorkers.map((t) => t.url()));

  // ===================================================
  // === Optional Kickoff to Extension
  // ===================================================
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

  // ===================================================
  // === Runtime Duration + Cleanup
  // ===================================================
  const MAX_RUNTIME_MS = 5 * 60 * 1000;
  console.log(`⏳ Keeping browser alive for ${MAX_RUNTIME_MS / 1000 / 60} min...`);
  await new Promise((resolve) => setTimeout(resolve, MAX_RUNTIME_MS));

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  console.log(`💾 Results saved to ${OUT_JSON}`);

  await browser.close();
  console.log("✅ Puppeteer orchestrator complete (extension verified + screenshots)");
})();
