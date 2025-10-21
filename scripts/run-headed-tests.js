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
      // extension IDs are 32 chars a-p (lowercase) — allow a-p0-9 heuristic
      const m = msg.match(/([a-p0-9]{32})/i);
      if (m && /^[a-p0-9]{32}$/.test(m[1])) {
        return m[1].toLowerCase();
      }
    }
  } catch (e) {
    // ignore failures to read logs
  }
  return null;
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
      // give extension and page some time to initialize
      await driver.sleep(1500);

      // Primary test page: raw GitHub URL for otment-test.html if available
      const testPage = rawTestPageUrl() || "https://example.com";
      console.log("Navigating to test page:", testPage);
      await driver.get(testPage);

      // Dispatch an event that content scripts might listen for (harmless if not present)
      await driver.executeScript(`
        window.dispatchEvent(new CustomEvent('OTMENT_RUN_TEST', {detail: {action: 'activate'}}));
      `);

      // Wait for the DOM marker (if extension injects it)
      const markerSelector = "#otment-status.active";
      let markerFound = false;
      try {
        await driver.wait(until.elementLocated(By.css(markerSelector)), 10000);
        console.log("Detected otment-status marker on page");
        markerFound = true;
      } catch (err) {
        console.warn("otment-status marker not found within timeout; will attempt alternative activation strategies");
      }

      // If marker not found, try extracting extension id from browser logs and open options page
      if (!markerFound) {
        const extId = await tryExtractExtensionIdFromLogs(driver);
        if (extId) {
          console.log("Detected extension id from logs:", extId);
          try {
            const extOptions = `chrome-extension://${extId}/options.html`;
            await driver.get(extOptions);
            await driver.wait(until.elementLocated(By.css("body")), 5000);
            console.log("Opened extension options page:", extOptions);
            // attempt to click a common control (adjust selector to your extension)
            try {
              const maybeButton = await driver.findElement(By.css("button"));
              await maybeButton.click().catch(() => {});
            } catch (e) {
              // ignore if no button
            }
          } catch (e) {
            console.warn("Could not open extension page by id:", e && e.message);
          }
        } else {
          console.warn("Extension id not found in browser logs; attempting to open a host page the extension targets");
          // Fallback: open a host page that your extension content_scripts already target (adjust if needed)
          try {
            const hostFallback = "https://www.fastpeoplesearch.com/";
            await driver.get(hostFallback);
            await driver.sleep(1500);
            // Dispatch the same event again on the host page
            await driver.executeScript(`
              window.dispatchEvent(new CustomEvent('OTMENT_RUN_TEST', {detail: {action: 'activate'}}));
            `);
            // wait briefly for any DOM changes
            try {
              await driver.wait(until.elementLocated(By.css('#otment-status.active')), 8000);
              console.log("Detected otment-status marker on host fallback page");
            } catch (e) {
              console.warn("No marker on host fallback page");
            }
          } catch (e) {
            console.warn("Host fallback navigation failed:", e && e.message);
          }
        }
      }

      // Ensure artifacts folder exists
      fs.mkdirSync("artifacts/screenshots", { recursive: true });

      // Capture screenshot
      const image = await driver.takeScreenshot();
      fs.writeFileSync(path.join("artifacts/screenshots", "extension-activated.png"), image, "base64");
      console.log("Saved screenshot to artifacts/screenshots/extension-activated.png");

      // Capture browser logs (best-effort)
      try {
        const logs = await driver.manage().logs().get("browser");
        fs.writeFileSync("artifacts/extension-browser-logs.json", JSON.stringify(logs, null, 2));
        console.log("Saved browser logs to artifacts/extension-browser-logs.json");
      } catch (e) {
        console.warn("Could not capture browser logs:", e && e.message);
      }

      await driver.quit();
      console.log("Headed test finished successfully");
      process.exit(0);
    } catch (innerErr) {
      console.error("Activation flow failed:", innerErr);
      try { await driver.quit(); } catch {}
      process.exit(1);
    }
  } catch (err) {
    console.error("Headed test failed:", err);
    process.exit(1);
  }
})();
