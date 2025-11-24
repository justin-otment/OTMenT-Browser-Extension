import puppeteerFirefox from "puppeteer-firefox"; 
import fs from "fs/promises";
import path from "path";

const { firefox } = puppeteerFirefox;

// ---------------------------------------------
// 1. Load Extension From Local Path (NO AMO)
// ---------------------------------------------
async function launchWithLocalExtension() {
  const EXTENSION_PATH = process.env.EXTENSION_PATH;

  if (!EXTENSION_PATH) {
    throw new Error("EXTENSION_PATH environment variable is missing!");
  }

  console.log("[OTMenT] Using local extension:", EXTENSION_PATH);

  // Launch Firefox with unsigned extension support
  const browser = await firefox.launch({
    headless: false,
    extraPrefsFirefox: {
      "xpinstall.signatures.required": false,   // allow unsigned addons
    }
  });

  // Install the extension (folder or .xpi)
  await browser.installAddon(EXTENSION_PATH, { temporary: true });
  console.log("[OTMenT] Extension successfully installed!");

  const page = await browser.newPage();
  await page.goto("https://example.com");

  console.log("[OTMenT] Firefox launched with extension!");

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