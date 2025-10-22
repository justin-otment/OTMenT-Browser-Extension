// scripts/browser-automation.js
// ESM module that performs controlled, deterministic browser actions using puppeteer-core.
// Designed for non-headless use in CI under Xvfb (your workflow already starts Xvfb).
// Exports DoBrowserAutomation which performs one run and resolves when done.

import fs from "fs";
import { join } from "path";

function shortLog(...args) {
  console.log(...args);
}

// Helper: resolve executablePath (prefer CHROME_PATH, fallback to common locations)
function resolveChromeExecutable() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && envPath.trim()) return envPath;
  const candidates = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable"];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

// Launch puppeteer-core with provided chrome executable path and args
async function launchPuppeteerWithSystemChrome(puppeteerModule, chromeArgsArray = [], executablePath = null) {
  const launchOptions = {
    headless: false,
    args: chromeArgsArray,
    defaultViewport: { width: 1920, height: 1080 },
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  return puppeteerModule.launch(launchOptions);
}

export async function DoBrowserAutomation({ testUrl, chromeArgs } = {}) {
  // Allow overrides via environment variables
  testUrl = testUrl || process.env.TEST_PAGE_URL || "http://127.0.0.1:8080/otment-test.html";
  chromeArgs = chromeArgs || process.env.CHROME_ARGS || `--disable-extensions-except=${process.cwd()} --load-extension=${process.cwd()} --no-sandbox --disable-dev-shm-usage --window-size=1920,1080`;

  // Normalize chrome args into array
  const chromeArgsArray = chromeArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(a => a.replace(/^"|"$/g, "")) || [];

  shortLog("browser-automation: testUrl =", testUrl);
  shortLog("browser-automation: chromeArgsArray =", chromeArgsArray.join(" "));

  // Resolve puppeteer-core (preferred). Fall back to puppeteer if core not installed.
  let puppeteer;
  try {
    puppeteer = await import("puppeteer-core").then(m => m.default || m);
  } catch (errCore) {
    shortLog("puppeteer-core not found, trying puppeteer fallback");
    try {
      puppeteer = await import("puppeteer").then(m => m.default || m);
    } catch (err) {
      shortLog("Error importing puppeteer or puppeteer-core. Install one of them in package.json.");
      throw err;
    }
  }

  // Determine executablePath
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    shortLog("Warning: could not find system Chrome executable. If using puppeteer-core, ensure CHROME_PATH is set.");
  } else {
    shortLog("Using Chrome executable:", executablePath);
  }

  // Launch browser
  let browser;
  try {
    browser = await launchPuppeteerWithSystemChrome(puppeteer, chromeArgsArray, executablePath);
  } catch (err) {
    shortLog("puppeteer launch failed; retrying with simpler options:", err && err.message ? err.message : err);
    try {
      browser = await puppeteer.launch({ headless: false, args: chromeArgsArray, defaultViewport: null, executablePath });
    } catch (err2) {
      throw new Error("Failed to launch puppeteer: " + (err2 && err2.message ? err2.message : err2));
    }
  }

  // Create a new page and attach listeners before navigation
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);

  // Collect console and page errors
  const logs = [];
  page.on("console", msg => {
    try { logs.push({ type: msg.type(), text: msg.text() }); } catch {}
  });
  page.on("pageerror", err => {
    try { logs.push({ type: "pageerror", text: String(err) }); } catch {}
  });

  // Navigate and perform deterministic actions similar to the AHK script
  try {
    await page.goto(testUrl, { waitUntil: "domcontentloaded" });
  } catch (err) {
    shortLog("Initial navigation failed (non-fatal):", err && err.message ? err.message : err);
  }

  // Allow extension and page scripts to initialize
  await page.waitForTimeout(3000);

  // Reload sequence (three times)
  for (let i = 0; i < 3; ++i) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      // proceed
    }
    await page.waitForTimeout(1000);
  }

  // Ensure viewport size
  try { await page.setViewport({ width: 1920, height: 1080 }); } catch {}

  // Example DOM interactions (guarded)
  try {
    const existsStatus = await page.$("#otment-status");
    if (existsStatus) {
      await existsStatus.click().catch(()=>{});
      await page.waitForTimeout(1500);
    }
    // If you need coordinate clicks, uncomment and adjust:
    // await page.mouse.click(562, 303);
  } catch (err) {
    shortLog("DOM interaction error (non-fatal):", err && err.message ? err.message : err);
  }

  // Give extension time to complete background tasks
  await page.waitForTimeout(5000);

  // Capture screenshot for diagnostics
  try {
    const outdir = process.env.GITHUB_WORKSPACE ? `${process.env.GITHUB_WORKSPACE}/artifacts/screenshots` : "./artifacts/screenshots";
    if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
    const shotPath = `${outdir}/screenshot-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    shortLog("Saved screenshot for diagnostics:", shotPath);
  } catch (err) {
    shortLog("Failed to save screenshot:", err && err.message ? err.message : err);
  }

  // Flush logs to diagnostics artifact
  try {
    const outLogsDir = process.env.GITHUB_WORKSPACE ? `${process.env.GITHUB_WORKSPACE}/artifacts/diagnostics` : "./artifacts/diagnostics";
    if (!fs.existsSync(outLogsDir)) fs.mkdirSync(outLogsDir, { recursive: true });
    const logsPath = `${outLogsDir}/extension-browser-logs-${Date.now()}.json`;
    fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2), "utf8");
    shortLog("Saved browser console logs:", logsPath);
  } catch (err) {
    shortLog("Failed to save browser logs:", err && err.message ? err.message : err);
  }

  // Close browser and return
  try { await browser.close(); } catch {}

  return true;
}

// When run directly by "node ./scripts/browser-automation.js"
if (process.argv[1] && process.argv[1].endsWith("browser-automation.js")) {
  (async () => {
    try {
      await DoBrowserAutomation();
      process.exit(0);
    } catch (err) {
      console.error("browser-automation: error", err && err.stack ? err.stack : err);
      process.exit(1);
    }
  })();
}
