// scripts/browser-automation.js
// ESM module that performs controlled, deterministic browser actions using puppeteer.
// Designed for non-headless use in CI under Xvfb (your workflow already starts Xvfb).
// Exports DoBrowserAutomation which performs one run and resolves when done.

import puppeteer from "puppeteer";
import { join } from "path";
import fs from "fs";

function shortLog(...args) {
  console.log(...args);
}

async function launchPuppeteerWithSystemChrome(chromeArgsArray = [], executablePath = null) {
  // If puppeteer is installed (regular package) it downloads Chromium; prefer puppeteer-core with system Chrome if you want.
  // This function attempts to use puppeteer's default chromium if no executablePath provided.
  const launchOptions = {
    headless: false,
    args: chromeArgsArray,
    defaultViewport: { width: 1920, height: 1080 },
    ignoreDefaultArgs: ["--enable-automation"], // reduce detectable flags
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  return puppeteer.launch(launchOptions);
}

export async function DoBrowserAutomation({ testUrl, chromeArgs } = {}) {
  testUrl = testUrl || process.env.TEST_PAGE_URL || "http://127.0.0.1:8080/otment-test.html";
  chromeArgs = chromeArgs || process.env.CHROME_ARGS || `--disable-extensions-except=${process.cwd()} --load-extension=${process.cwd()} --no-sandbox --disable-dev-shm-usage --window-size=1920,1080`;

  // Normalize chrome args into array
  const chromeArgsArray = chromeArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(a => a.replace(/^"|"$/g, "")) || [];

  shortLog("browser-automation: testUrl =", testUrl);
  shortLog("browser-automation: chromeArgsArray =", chromeArgsArray.join(" "));

  // Optionally allow using system chrome via env CHROME_PATH
  const executablePath = process.env.CHROME_PATH || null;

  // Launch puppeteer
  let browser;
  try {
    browser = await launchPuppeteerWithSystemChrome(chromeArgsArray, executablePath);
  } catch (err) {
    shortLog("puppeteer launch failed; retrying with fallback args:", err.message);
    try {
      browser = await puppeteer.launch({ headless: false, args: chromeArgsArray, defaultViewport: null });
    } catch (err2) {
      throw new Error("Failed to launch puppeteer: " + (err2 && err2.message ? err2.message : err2));
    }
  }

  // Create a page and navigate
  const page = await browser.newPage();

  // Increase navigation timeout for pages that might be protected (Cloudflare etc.)
  await page.setDefaultNavigationTimeout(60000);

  // Navigate and perform deterministic actions similar to the AHK script:
  // - open URL, wait, reload a few times, then optionally perform clicks by selectors or coordinates
  await page.goto(testUrl, { waitUntil: "domcontentloaded" });

  // Wait short time for extension to inject and scripts to run
  await page.waitForTimeout(3000);

  // Reload sequence (three times)
  for (let i = 0; i < 3; ++i) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      // continue on reload error
    }
    await page.waitForTimeout(1000);
  }

  // Maximize window where possible by setting viewport
  await page.setViewport({ width: 1920, height: 1080 });

  // Example clicks: prefer CSS selectors; if you only have coordinates, use mouse.click(x,y)
  // The original AHK used ControlClick at positions; here we provide examples that you should adapt to real selectors.
  try {
    // Try common safe actions, guarded by existence checks
    // 1) If an element with id 'otment-status' exists, click it
    const existsStatus = await page.$("#otment-status");
    if (existsStatus) {
      await existsStatus.click().catch(()=>{});
      await page.waitForTimeout(1500);
    }

    // 2) Example coordinate click fallback (x=562,y=303) — use only if necessary
    // const rect = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    // await page.mouse.click(562, 303);
  } catch (err) {
    // swallow DOM interaction errors — important for CI robustness
    shortLog("DOM interaction error (non-fatal):", err.message || err);
  }

  // Give extension time to do background work
  await page.waitForTimeout(5000);

  // Capture a screenshot for diagnostics
  try {
    const outdir = process.env.GITHUB_WORKSPACE ? `${process.env.GITHUB_WORKSPACE}/artifacts/screenshots` : "./artifacts/screenshots";
    if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
    const shotPath = `${outdir}/screenshot-${Date.now()}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    shortLog("Saved screenshot for diagnostics:", shotPath);
  } catch (err) {
    shortLog("Failed to save screenshot:", err.message || err);
  }

  // Optionally collect console logs and page errors into artifact file
  try {
    const logs = [];
    page.on("console", (msg) => logs.push({ type: msg.type(), text: msg.text() }));
    page.on("pageerror", (err) => logs.push({ type: "pageerror", text: String(err) }));
    // allow last-second messages to flush
    await page.waitForTimeout(1000);
    const outLogsDir = process.env.GITHUB_WORKSPACE ? `${process.env.GITHUB_WORKSPACE}/artifacts/diagnostics` : "./artifacts/diagnostics";
    if (!fs.existsSync(outLogsDir)) fs.mkdirSync(outLogsDir, { recursive: true });
    const logsPath = `${outLogsDir}/extension-browser-logs-${Date.now()}.json`;
    fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2), "utf8");
    shortLog("Saved browser console logs:", logsPath);
  } catch (err) {
    shortLog("Failed to save browser logs:", err.message || err);
  }

  // Close browser
  try {
    await browser.close();
  } catch {
    // ignore close errors
  }

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
export { DoBrowserAutomation };
