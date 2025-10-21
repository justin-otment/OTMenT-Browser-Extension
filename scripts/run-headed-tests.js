import fs from "fs";
import path from "path";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import chromedriver from "chromedriver";

(async function run() {
  try {
    // Ensure chromedriver binary from npm is used
    const service = new chrome.ServiceBuilder(chromedriver.path).build();
    chrome.setDefaultService(service);

    const options = new chrome.Options();
    options.addArguments(
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080"
    );

    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();

    // simple sanity test
    await driver.get("https://example.com");
    await driver.wait(until.titleContains("Example Domain"), 5000);

    fs.mkdirSync("artifacts/screenshots", { recursive: true });
    const image = await driver.takeScreenshot();
    fs.writeFileSync(path.join("artifacts/screenshots", "example.png"), image, "base64");

    await driver.quit();
    console.log("Headed test finished successfully");
    process.exit(0);
  } catch (err) {
    console.error("Headed test failed:", err);
    try { await new Promise(r => setTimeout(r, 50)); } catch {}
    process.exit(1);
  }
})();
