import puppeteer from "puppeteer";
import path from "path";

// ---------------------------------------------
// Launch Firefox with local extension
// ---------------------------------------------
async function launchWithLocalExtension() {
  const EXTENSION_PATH = process.env.EXTENSION_PATH;
  const FIREFOX_PATH = process.env.FIREFOX_PATH || "/usr/bin/firefox";
  const DEBUG = process.env.DEBUG === "true"; // toggle for local debugging

  if (!EXTENSION_PATH) {
    throw new Error("EXTENSION_PATH environment variable is missing!");
  }

  console.log("[OTMenT] Using local extension:", EXTENSION_PATH);
  console.log("[OTMenT] Using Firefox binary:", FIREFOX_PATH);
  console.log("[OTMenT] Debug mode:", DEBUG ? "ON (headless=false)" : "OFF (headless=true)");

  const resolvedPath = path.resolve(EXTENSION_PATH);

  let browser;
  try {
    // Try WebDriver BiDi first
    browser = await puppeteer.launch({
      protocol: "webDriverBiDi", // ✅ BiDi protocol
      product: "firefox",
      executablePath: FIREFOX_PATH,
      headless: !DEBUG,
      args: [
        `--disable-extensions-except=${resolvedPath}`,
        `--load-extension=${resolvedPath}`
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    console.log("[OTMenT] Browser launched with WebDriver BiDi.");
  } catch (err) {
    console.warn("[OTMenT] WebDriver BiDi launch failed, falling back to CDP:", err.message);
    // Fallback to CDP with extra flags and longer timeout
    browser = await puppeteer.launch({
      product: "firefox",
      executablePath: FIREFOX_PATH,
      headless: !DEBUG,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--disable-extensions-except=${resolvedPath}`,
        `--load-extension=${resolvedPath}`
      ],
      ignoreDefaultArgs: ["--disable-extensions"],
      timeout: 60000, // increase launch timeout
    });
    console.log("[OTMenT] Browser launched with CDP fallback.");
  }

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
    console.error("[OTMenT] Automation failed:", err);
    process.exit(1);
  }
})();
