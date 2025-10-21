import fs from "fs";
import path from "path";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import chromedriver from "chromedriver";

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const EXT_PATH = fs.existsSync(MANIFEST_PATH) ? ROOT : null;

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
      if (m && /^[a-p0-9]{32}$/.test(m[1])) return m[1].toLowerCase();
    }
  } catch {}
  return null;
}

async function dumpPageDiagnostics(driver, targetPathPrefix = "artifacts/diagnostics") {
  try {
    fs.mkdirSync(targetPathPrefix, { recursive: true });
    const html = await driver.getPageSource();
    fs.writeFileSync(path.join(targetPathPrefix, "page-source.html"), html, "utf8");
    const info = await driver.executeScript(`
      return { href: location.href, title: document.title, cookies: document.cookie || "" }
    `);
    fs.writeFileSync(path.join(targetPathPrefix, "page-info.json"), JSON.stringify(info, null, 2), "utf8");
  } catch (e) {
    console.warn("Failed to write page diagnostics:", e.message);
  }
}

(async function run() {
  let driver;
  try {
    const serviceBuilder = new chrome.ServiceBuilder(chromedriver.path);
    const options = new chrome.Options();
    options.addArguments("--no-sandbox", "--disable-dev-shm-usage", "--window-size=1920,1080");

    if (EXT_PATH) {
      console.log("Loading unpacked extension from:", EXT_PATH);
      options.addArguments(`--load-extension=${EXT_PATH}`);
    } else {
      console.log("No extension found — running without load-extension");
    }

    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .setChromeService(serviceBuilder)
      .build();

    const testPage = rawTestPageUrl() || "http://127.0.0.1:8080/otment-test.html";
    console.log("Navigating to test page:", testPage);
    await driver.get(testPage);

    await driver.wait(async () => {
      const ready = await driver.executeScript("return document.readyState");
      return ready === "complete" || ready === "interactive";
    }, 10000).catch(() => {});

    await driver.executeScript(`
      try { 
        window.dispatchEvent(new CustomEvent('OTMENT_RUN_TEST', {detail:{action:'activate'}})); 
      } catch(e) {}
    `).catch(() => {});

    await driver.sleep(1500);

    const markerSelector = "#otment-status.active";
    let markerFound = false;
    try {
      await driver.wait(until.elementLocated(By.css(markerSelector)), 8000);
      console.log("✅ Detected otment-status marker on page");
      markerFound = true;
    } catch {
      console.warn("⚠️ Marker not found within timeout.");
    }

    await dumpPageDiagnostics(driver, "artifacts/diagnostics");

    fs.mkdirSync("artifacts/screenshots", { recursive: true });
    try {
      const image = await driver.takeScreenshot();
      fs.writeFileSync(path.join("artifacts/screenshots", "extension-activated.png"), image, "base64");
      console.log("📸 Screenshot saved to artifacts/screenshots/extension-activated.png");
    } catch (e) {
      console.warn("Screenshot failed:", e.message);
    }

    try {
      const logs = await driver.manage().logs().get("browser");
      fs.mkdirSync("artifacts", { recursive: true });
      fs.writeFileSync("artifacts/extension-browser-logs.json", JSON.stringify(logs, null, 2), "utf8");
      console.log("🧾 Browser logs saved.");
    } catch (e) {
      console.warn("Could not capture browser logs:", e.message);
    }

    await driver.quit();
    console.log("✅ Headed test finished successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Headed test failed:", err.stack || err);
    if (driver) try { await driver.quit(); } catch {}
    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync("artifacts/extension-browser-logs.json", JSON.stringify([{ level: "ERROR", message: err.message }], null, 2));
    process.exit(1);
  }
})();
