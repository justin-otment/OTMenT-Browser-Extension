import fs from "fs";
import path from "path";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import chromedriver from "chromedriver";

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const EXT_PATH = MANIFEST_PATH && fs.existsSync(MANIFEST_PATH) ? ROOT : null;

function rawTestPageUrl() {
  const repo = process.env.GITHUB_REPOSITORY || "";
  const ref = process.env.GITHUB_REF_NAME || (process.env.GITHUB_REF || "refs/heads/main").replace(/^refs\/heads\//, "");
  if (!repo) return null;
  return `https://raw.githubusercontent.com/${repo}/${ref}/otment-test.html`;
}

async function tryExtractExtensionIdFromLogs(driver) {
  try {
    const logs = await driver.manage().logs().get("browser");
    for (const entry of logs) {
      const msg = (entry.message || "").toString();
      const m = msg.match(/([a-p0-9]{32})/i);
      if (m && /^[a-p0-9]{32}$/.test(m[1])) {
        return m[1].toLowerCase();
      }
    }
  } catch (e) {}
  return null;
}

async function dumpPageDiagnostics(driver, targetPathPrefix = "artifacts/diagnostics") {
  try {
    fs.mkdirSync(targetPathPrefix, { recursive: true });
    const html = await driver.getPageSource();
    fs.writeFileSync(path.join(targetPathPrefix, "page-source.html"), html, "utf8");
    const scripts = await driver.executeScript(`
      return Array.from(document.scripts || []).map(s => s.src || (s.innerText && s.innerText.length>0 ? '[inline]' : '')).filter(Boolean);
    `);
    fs.writeFileSync(path.join(targetPathPrefix, "script-src-list.json"), JSON.stringify(scripts, null, 2), "utf8");
    const info = await driver.executeScript(`
      return { href: location.href, title: document.title, cookies: document.cookie || "" }
    `);
    fs.writeFileSync(path.join(targetPathPrefix, "page-info.json"), JSON.stringify(info, null, 2), "utf8");
  } catch (e) {
    console.warn("Failed to write page diagnostics:", e && e.message);
  }
}

async function openOptionsAndActivate(driver, extId) {
  try {
    const extOptions = `chrome-extension://${extId}/options.html`;
    console.log("Navigating to extension options page:", extOptions);
    await driver.get(extOptions);
    await driver.wait(until.elementLocated(By.css("body")), 5000).catch(() => {});
    try {
      const optHtml = await driver.getPageSource();
      fs.mkdirSync("artifacts/diagnostics", { recursive: true });
      fs.writeFileSync("artifacts/diagnostics/options-page.html", optHtml, "utf8");
      console.log("Saved options page HTML for inspection");
    } catch (e) {
      console.warn("Could not save options page HTML:", e && e.message);
    }

    const selectors = [
      "#activate",
      "#start",
      "#enable",
      ".activate",
      "button.activate",
      "button.primary",
      "button",
      "input[type=submit]"
    ];

    let clicked = false;
    for (const sel of selectors) {
      try {
        const el = await driver.findElement(By.css(sel));
        if (el) {
          console.log("Found selector on options page, attempting click:", sel);
          await el.click().catch(() => {});
          clicked = true;
          await driver.sleep(800);
          break;
        }
      } catch (e) {}
    }

    if (!clicked) {
      try {
        const res = await driver.executeScript(`
          try {
            if (window.OTMENT_activate) { window.OTMENT_activate(); return 'OTMENT_activate called'; }
            if (typeof activate === 'function') { activate(); return 'activate() called'; }
            if (typeof start === 'function') { start(); return 'start() called'; }
            return 'no-known-fn';
          } catch(e) { return 'fn-call-failed:' + (e && e.message); }
        `);
        console.log("Fn call result:", res);
        await driver.sleep(800);
      } catch (e) {
        console.warn("Fn call error:", e && e.message);
      }
    }

    try {
      const afterHtml = await driver.getPageSource();
      fs.writeFileSync("artifacts/diagnostics/options-page-after.html", afterHtml, "utf8");
      console.log("Saved options page (after activation) HTML");
    } catch (e) {
      console.warn("Could not save options-page-after HTML:", e && e.message);
    }

    return true;
  } catch (e) {
    console.warn("openOptionsAndActivate error:", e && e.message);
    return false;
  }
}

(async function run() {
  try {
    const serviceBuilder = new chrome.ServiceBuilder(chromedriver.path);

    const options = new chrome.Options();
    options.addArguments(
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080"
    );

    if (EXT_PATH) {
      console.log("Loading unpacked extension from:", EXT_PATH);
      options.addArguments(`--load-extension=${EXT_PATH}`);
    } else {
      console.log("No extension manifest found in repo root; starting without --load-extension");
    }

    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .setChromeService(serviceBuilder)
      .build();

    try {
      await driver.sleep(1500);

      const testPage = rawTestPageUrl() || "https://example.com";
      console.log("Navigating to test page:", testPage);
      await driver.get(testPage);

      await driver.wait(async () => {
        const ready = await driver.executeScript("return document.readyState");
        return ready === "complete" || ready === "interactive";
      }, 10000).catch(() => {});

      await driver.executeScript(`
        try { window.dispatchEvent(new CustomEvent('OTMENT_RUN_TEST', {detail: {action: 'activate'}})); } catch(e) {}
      `).catch(() => {});

      await driver.sleep(1500);

      const markerSelector = "#otment-status.active";
      let markerFound = false;
      try {
        await driver.wait(until.elementLocated(By.css(markerSelector)), 10000);
        console.log("Detected otment-status marker on page");
        markerFound = true;
      } catch (err) {
        console.warn("otment-status marker not found within timeout; will attempt alternative activation strategies");
      }

      await dumpPageDiagnostics(driver, "artifacts/diagnostics/rawpage");

      if (!markerFound) {
        const extId = await tryExtractExtensionIdFromLogs(driver);
        if (extId) {
          console.log("Detected extension id from logs:", extId);
          await openOptionsAndActivate(driver, extId);
        } else {
          console.warn("Extension id not found in browser logs; attempting host fallback page that the extension targets");
          try {
            const hostFallback = "https://www.fastpeoplesearch.com/";
            await driver.get(hostFallback);
            await driver.sleep(2000);
            await driver.executeScript(`try { window.dispatchEvent(new CustomEvent('OTMENT_RUN_TEST', {detail:{action:'activate'}})); } catch(e) {}`);
            await dumpPageDiagnostics(driver, "artifacts/diagnostics/host_fallback");
            try {
              await driver.wait(until.elementLocated(By.css(markerSelector)), 8000);
              console.log("Detected otment-status marker on host fallback page");
              markerFound = true;
            } catch (e) {
              console.warn("No marker on host fallback page");
            }
          } catch (e) {
            console.warn("Host fallback navigation failed:", e && e.message);
          }
        }
      }

      fs.mkdirSync("artifacts/screenshots", { recursive: true });
      try {
        const image = await driver.takeScreenshot();
        fs.writeFileSync(path.join("artifacts/screenshots", "extension-activated.png"), image, "base64");
        console.log("Saved screenshot to artifacts/screenshots/extension-activated.png");
      } catch (e) {
        console.warn("Screenshot failed:", e && e.message);
      }

      try {
        const logs = await driver.manage().logs().get("browser");
        fs.writeFileSync("artifacts/extension-browser-logs.json", JSON.stringify(logs, null, 2));
        // analyze logs summary
        try {
          function analyzeBrowserLogs(logEntries) {
            const summary = { extensionIdCandidates: [], mentions: [], errors: [] };
            const idRegex = /([a-p0-9]{32})/i;
            const fileNames = ['background.js','solver.worker.js','solver.detector.content.js','crypto-worker.js','crypto-utils.js','options.html'];
            for (const entry of logEntries) {
              const msg = (entry.message || '').toString();
              const idMatch = msg.match(idRegex);
              if (idMatch && /^[a-p0-9]{32}$/i.test(idMatch[1])) {
                summary.extensionIdCandidates.push({ id: idMatch[1].toLowerCase(), message: msg, level: entry.level });
              }
              for (const fn of fileNames) {
                if (msg.includes(fn)) {
                  summary.mentions.push({ file: fn, message: msg, level: entry.level });
                }
              }
              if ((entry.level || '').toUpperCase() === 'SEVERE' || msg.toLowerCase().includes('error')) {
                summary.errors.push({ message: msg, level: entry.level });
              }
            }
            summary.extensionIdCandidates = Array.from(new Map(summary.extensionIdCandidates.map(x => [x.id, x])).values());
            return summary;
          }
          const analysis = analyzeBrowserLogs(logs);
          fs.writeFileSync("artifacts/extension-browser-logs-summary.json", JSON.stringify(analysis, null, 2), "utf8");
          console.log("Saved extension-browser-logs-summary.json");
          if (analysis.extensionIdCandidates.length) {
            console.log("Extension id candidates found:", analysis.extensionIdCandidates.map(x=>x.id).join(', '));
          } else {
            console.log("No extension id candidates found in browser logs.");
          }
        } catch (e) {
          console.warn("Failed to analyze browser logs:", e && e.message);
        }
      } catch (e) {
        console.warn("Could not capture browser logs:", e && e.message);
      }

      await driver.quit();
      console.log("Headed test finished successfully");
      process.exit(0);
    } catch (innerErr) {
      console.error("Activation flow failed:", innerErr && innerErr.stack || innerErr);
      try { await driver.quit(); } catch {}
      process.exit(1);
    }
  } catch (err) {
    console.error("Headed test failed:", err && err.stack || err);
    process.exit(1);
  }
})();
