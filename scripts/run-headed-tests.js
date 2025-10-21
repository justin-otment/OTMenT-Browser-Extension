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
      if (m && /^[a-p0-9]{32}$/.test(m[1])) {
        return m[1].toLowerCase();
      }
    }
  } catch {}
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
    console.warn("Failed to write page diagnostics:", e.message);
  }
}

async function openOptionsAndActivate(driver, extId) {
  try {
    const extOptions = `chrome-extension://${extId}/options.html`;
    console.log("Navigating to extension options page:", extOptions);
    await driver.get(extOptions);
    await driver.wait(until.elementLocated(By.css("body")), 5000).catch(() => {});

    const selectors = [
      "#activate", "#start", "#enable", ".activate", "button.activate",
      "button.primary", "button", "input[type=submit]"
    ];

    for (const sel of selectors) {
      try {
        const el = await driver.findElement(By.css(sel));
        if (el) {
          console.log("Found and clicked:", sel);
          await el.click().catch(() => {});
          await driver.sleep(800);
          break;
        }
      } catch {}
    }

    await dumpPageDiagnostics(driver, "artifacts/diagnostics/options-page");
    return true;
  } catch (e) {
    console.warn("openOptionsAndActivate error:", e.message);
    return false;
  }
}

async function safeWrite(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  } catch (e) {
    console.warn("Failed to write", file, e.message);
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
    }

    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .setChromeService(serviceBuilder)
      .buil
