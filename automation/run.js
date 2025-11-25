// automation/run.js
import fs from "fs";
import path from "path";
import process from "process";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

async function launch() {
  const EXTENSION_PATH = process.env.EXTENSION_PATH || "GitHub-Onyot";
  const GOOGLE_USER = process.env.GOOGLE_USER;
  const GOOGLE_PASS = process.env.GOOGLE_PASS;

  if (!GOOGLE_USER || !GOOGLE_PASS) {
    throw new Error("GOOGLE_USER and GOOGLE_PASS environment variables are required!");
  }

  const extensionDir = path.resolve(EXTENSION_PATH);
  if (!fs.existsSync(extensionDir)) {
    throw new Error(`Extension folder not found: ${extensionDir}`);
  }

  console.log("[OTMenT] Using extension folder:", extensionDir);

  puppeteer.use(StealthPlugin());

  const browser = await puppeteer.launch({
    headless: false, // force non-headless
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  try {
    console.log("[OTMenT] Navigating to Google Sign-In...");
    await page.goto("https://accounts.google.com/", { waitUntil: "networkidle2" });

    // Enter email
    await page.waitForSelector('input[type="email"]', { visible: true });
    await page.type('input[type="email"]', GOOGLE_USER, { delay: 50 });
    await page.click("#identifierNext");
    console.log("[OTMenT] Entered email");

    // Wait for password field
    await page.waitForTimeout(2000);
    await page.waitForSelector('input[name="Passwd"]', { visible: true });
    await page.type('input[name="Passwd"]', GOOGLE_PASS, { delay: 50 });
    await page.click("#passwordNext");
    console.log("[OTMenT] Entered password");

    // Wait for login or 2FA
    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
      console.log("[OTMenT] Logged into Google account successfully");
    } catch {
      console.log("[OTMenT] Login may require additional verification (2FA or recovery).");
    }

    // Navigate to target URL
    const targetUrl = "https://www.peoplesearchnow.com/address/629-west-lightwood-street_citrus-springs-fl";
    await page.goto(targetUrl, { waitUntil: "networkidle2" });
    console.log("[OTMenT] Navigated to target URL");
    console.log("[OTMenT] Page title:", await page.title());

    await page.screenshot({ path: "automation-screenshot.png" });
    console.log("[OTMenT] Screenshot captured at automation-screenshot.png");

  } catch (err) {
    console.error("[OTMenT] Automation failed:", err);
    await page.screenshot({ path: "automation-screenshot.png" }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    console.log("[OTMenT] Browser closed.");
  }
}

launch().catch(err => {
  console.error(err);
  process.exit(1);
});
