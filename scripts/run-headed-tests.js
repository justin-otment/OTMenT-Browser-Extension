import fs from "fs";
import path from "path";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import chromedriver from "chromedriver";

(async function run() {
  try {
    // Create a ServiceBuilder but do NOT call .build() here
    const serviceBuilder = new chrome.ServiceBuilder(chromedriver.path);

    // Chrome options for CI (headed)
    const options = new chrome.Options();
    options.addArguments(
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1920,1080"
      // To load an unpacked extension:
      // `--load-extension=${path.resolve(process.cwd(), 'extension-unpacked')}`
    );

    // Pass the ServiceBuilder instance into setChromeService
    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .setChromeService(serviceBuilder)
      .build();

    // sanity navigation
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
    process.exit(1);
  }
})();
