import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import path from "path";

puppeteer.use(StealthPlugin());

async function launch() {
  const EXTENSION_PATH = process.env.EXTENSION_PATH;
  const GOOGLE_USER = process.env.GOOGLE_USER;
  const GOOGLE_PASS = process.env.GOOGLE_PASS;

  if (!EXTENSION_PATH) throw new Error("EXTENSION_PATH env missing!");
  if (!GOOGLE_USER) throw new Error("GOOGLE_USER secret missing!");
  if (!GOOGLE_PASS) throw new Error("GOOGLE_PASS secret missing!");

  const resolvedPath = path.resolve(EXTENSION_PATH);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Extension folder not found: ${resolvedPath}`);
  }

  console.log("[OTMenT] Using extension:", resolvedPath);
  console.log("[OTMenT] Running in NON-HEADLESS mode");

  const args = [
    `--load-extension=${resolvedPath}`,
    `--disable-extensions-except=${resolvedPath}`,
    "--no-sandbox",
    "--disable-setuid-sandbox"
  ];

  // ALWAYS non-headless as requested
  const browser = await puppeteer.launch({
    headless: false,
    args,
    defaultViewport: null
  });

  const page = await browser.newPage();

  console.log("[OTMenT] Navigating to Google login...");

  await page.goto("https://accounts.google.com/signin", {
    waitUntil: "networkidle2"
  });

  // ----------------------------
  // STEP 1: ENTER EMAIL
  // ----------------------------
  await page.type("input[type=email]", GOOGLE_USER, { delay: 40 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);

  // ----------------------------
  // STEP 2: ENTER PASSWORD
  // ----------------------------
  await page.type("input[type=password]", GOOGLE_PASS, { delay: 40 });
  await page.keyboard.press("Enter");

  await page.waitForNavigation({ waitUntil: "networkidle2" });

  console.log("[OTMenT] Google login successful.");

  // ----------------------------------------
  // OPTIONAL: Take screenshot after login
  // ----------------------------------------
  const screenshotPath = "post-login.png";
  await page.screenshot({ path: screenshotPath });
  console.log(`[OTMenT] Screenshot saved at ${screenshotPath}`);

  console.log("[OTMenT] Browser will stay open for extension automation.");
  console.log("[OTMenT] (Use extension background.js / navigator.js normally)");

  // Keep the browser running to allow your extension to continue
  await new Promise(() => {});
}

launch().catch(err => {
  console.error("[OTMenT] Automation failed:", err);
  process.exit(1);
});
