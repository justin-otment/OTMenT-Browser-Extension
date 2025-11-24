import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";

// ---------------------------------------------
// 1. Load Extension From Local Path (NO AMO)
// ---------------------------------------------
async function launchWithLocalExtension() {
  const EXTENSION_PATH = process.env.EXTENSION_PATH;

  if (!EXTENSION_PATH) {
    throw new Error("EXTENSION_PATH environment variable is missing!");
  }

  console.log("[OTMenT] Using local extension:", EXTENSION_PATH);

  // Resolve absolute path
  const resolvedPath = path.resolve(EXTENSION_PATH);

  // Launch Firefox with unsigned extension support
  const browser = await puppeteer.launch({
    product: "firefox",
    headless: false,
    args: [
      `--disable-extensions-except=${resolvedPath}`,
      `--load-extension=${resolvedPath}`
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  console.log("[OTMenT] Browser launched.");

  const page = await browser.newPage();
  await page.goto("https://example.com");

  console.log("[OTMenT] Firefox launched with extension!");
  console.log("[OTMenT] Page title:", await page.title());

  await browser.close();
  console.log("[OTMenT] Browser closed.");
}

// ---------------------------------------------
// MAIN
// ---------------------------------------------
(async () => {
  try {
    await launchWithLocalExtension();
  } catch (err) {
    console.error("Automation failed:", err);
    process.exit(1);
  }
})();