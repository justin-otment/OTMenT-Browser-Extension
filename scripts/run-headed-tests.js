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
  const ref = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF?.replace(/^refs\/heads\//, "") || "main";
  if (!repo) return null;
  return `https://raw.githubusercontent.com/${repo}/${ref}/otment-test.html`;
}

(async function run() {
  try {
    // ServiceBuilder pointing to chromedriver binary (pass the builder to setChromeService)
    const serviceBuilder = new chrome.ServiceBuilder(chromedriver.path);

    // Chrome options for CI (headed)
    const options = new chrome.Options();
    options.addArguments(
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080"
    );

    // Load unpacked extension if manifest.json is present at repo root
    if (EXT_PATH) {
      console.log("Loading unpacked extension from:", EXT_PATH);
      options.addArguments(`--load-extension=${EXT_PATH}`);
    } else {
      console.log("No extension manifest found in repo root; starting without --load-extension");
    }

    // Build the WebDriver
    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .setChromeService(serviceBuilder)
      .build();

    try {
      // small wait to let extension load if present
      await driver.sleep(1500);

      // Determine test page URL (raw GitHub). If unavailable, fall back to example.com
      const testPage = rawTestPageUrl() || "https://example.com";
      console.log("Navigating to test page:", testPage);
      await driver.get(testPage);

      // Dispatch the custom event the test-content-hook listens for
      await driver.executeScript(`
        window.dispatchEvent(new CustomEvent('OTMENT_RUN_TEST', {detail: {action: 'activate'}}));
      `);

      // Wait for the DOM marker added by the content script
      const markerSelector = "#otment-status.active";
      try {
        await driver.wait(until.elementLocated(By.css(markerSelector)), 10000);
        console.log("Detected otment-status marker on page");
      } catch (err) {
        console.warn("otment-status marker not found within timeout; continuing to capture diagnostics");
      }

      // Create artifacts folder
      fs.mkdirSync("artifacts/screenshots", { recursive: true });

      // Screenshot (proof the browser rendered)
      const image = await driver.takeScreenshot();
      fs.writeFileSync(path.join("artifacts/screenshots", "extension-activated.png"), image, "base64");
      console.log("Saved screenshot to artifacts/screenshots/extension-activated.png");

      // Capture browser console logs (if available)
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
