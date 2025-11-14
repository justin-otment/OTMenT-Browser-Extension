const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const EXTENSION_PATH = process.env.EXTENSION_PATH || path.join(__dirname, "dist");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 180000);
const SCREENSHOT_INTERVAL_MS = Number(process.env.SCREENSHOT_INTERVAL_MS || 3000);

const MAX_RETRIES = 3;
let retries = 0;

// Ensure paths
if (!fs.existsSync(EXTENSION_PATH)) {
  console.error("❌ Extension folder does NOT exist:", EXTENSION_PATH);
  process.exit(1);
}

// Continuous screenshot logger
async function startScreenshotLoop(page) {
  let counter = 0;
  const interval = setInterval(async () => {
    try {
      const file = `artifacts/screenshots/live_${String(counter).padStart(4, "0")}.png`;
      await page.screenshot({ path: file });
      counter++;
    } catch (err) {
      console.error("Screenshot loop error:", err.message);
    }
  }, SCREENSHOT_INTERVAL_MS);

  return interval;
}

async function waitForServiceWorker(browser, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const workers = await browser.waitForTarget(
      target =>
        target.type() === "service_worker" &&
        target.url().includes("navigator.js"),
      { timeout: 1000 }
    ).catch(() => null);

    if (workers) return true;
    await new Promise(res => setTimeout(res, 500));
  }
  return false;
}

async function runOrchestrator() {
  try {
    console.log("🚀 Launching Chrome with extension:", EXTENSION_PATH);

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: CHROME_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        `--load-extension=${EXTENSION_PATH}`,
        `--disable-extensions-except=${EXTENSION_PATH}`,
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ],
      defaultViewport: null,
    });

    const page = await browser.newPage();

    // Logging screenshots
    const screenshotTimer = await startScreenshotLoop(page);

    console.log("⏳ Waiting for service worker (navigator.js) to register…");

    const swOk = await waitForServiceWorker(browser);
    if (!swOk) {
      throw new Error("Extension MV3 service worker (navigator.js) did NOT load.");
    }

    console.log("✅ Service worker detected! Extension loaded successfully.");

    // Take confirmation screenshot
    await page.goto("https://example.com");
    await page.screenshot({
      path: "artifacts/screenshots/extension_loaded.png",
    });

    // Stop screenshot loop
    clearInterval(screenshotTimer);

    console.log("🎉 Orchestrator completed successfully.");
    await browser.close();

  } catch (error) {
    console.error("❌ Error during puppeteer orchestrator:", error);

    if (retries < MAX_RETRIES) {
      retries++;
      console.log(`🔁 Retrying… (${retries}/${MAX_RETRIES})`);
      return await runOrchestrator();
    }

    console.error("💥 Max retries reached. Orchestrator failed.");
    process.exit(1);
  }
}

runOrchestrator();