// automation/run.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const MAX_ATTEMPTS = 5;
const WAIT_SECONDS = 10;

async function findExtensionId(browser) {
  const targets = await browser.targets();
  const extensionTarget = targets.find(t => t.type() === 'background_page');

  if (!extensionTarget) return null;

  const url = extensionTarget.url();
  const match = url.match(/chrome-extension:\/\/([a-z]+)/);

  return match ? match[1] : null;
}

async function launchWithExtension() {
  let success = false;
  const EXT_PATH = process.env.EXTENSION_PATH || 'GitHub-Onyot';

  console.log("[OTMenT] Using extension path:", EXT_PATH);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !success; attempt++) {
    console.log(`[OTMenT] Attempt ${attempt}/${MAX_ATTEMPTS}`);

    let browser;

    try {
      browser = await puppeteer.launch({
        headless: "new",  // IMPORTANT FOR GITHUB ACTIONS
        args: [
          '--disable-blink-features=AutomationControlled',
          `--load-extension=${EXT_PATH}`,
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ]
      });
    } catch (err) {
      console.error("[OTMenT] Browser launch failed:", err);
      continue;
    }

    const page = await browser.newPage();

    try {
      await page.goto('https://target-site.com', { waitUntil: 'domcontentloaded' });

      // Cloudflare detection
      const title = await page.title();
      if (title.includes("Just a moment") || title.includes("Checking your browser")) {
        console.warn("[OTMenT] Cloudflare challenge detected. Waiting...");
        await page.waitForTimeout(WAIT_SECONDS * 1000);

        const newTitle = await page.title();
        if (newTitle.includes("Just a moment") || newTitle.includes("Checking your browser")) {
          console.error(`[OTMenT] Challenge not bypassed on attempt ${attempt}`);
          await page.screenshot({ path: `automation-failure-${attempt}.png` });
          await browser.close();
          continue;
        }
      }

      // Extension ID discovery
      const extId = await findExtensionId(browser);
      if (!extId) {
        console.warn("[OTMenT] Extension ID not found.");
      } else {
        console.log("[OTMenT] Detected extension:", extId);

        const pages = [
          '/popup.html',
          '/index.html',
          '/popup/popup.html',
          '/_generated_background_page.html'
        ];

        let opened = false;

        for (const p of pages) {
          const url = `chrome-extension://${extId}${p}`;
          try {
            const extPage = await browser.newPage();
            await extPage.goto(url, { waitUntil: 'networkidle2', timeout: 5000 });
            console.log("[OTMenT] Opened extension page:", url);

            try {
              await extPage.waitForSelector('#start-btn, button.start, .start-btn', { timeout: 2000 });
              await extPage.click('#start-btn, button.start, .start-btn');
              console.log("[OTMenT] Clicked start button");
            } catch {}

            opened = true;
            break;
          } catch {
            console.log("[OTMenT] Page not found:", url);
          }
        }

        if (!opened)
          console.log("[OTMenT] No extension popup found. Extension may be background-only.");
      }

      // Save screenshots
      try {
        await page.screenshot({ path: 'post-login.png' });
        console.log("[OTMenT] Saved post-login.png");
      } catch (err) {
        console.warn("[OTMenT] Could not save post-login screenshot:", err.message);
      }

      await page.screenshot({ path: 'automation-screenshot.png' });

      console.log("[OTMenT] Browser active for extension...");

      success = true;
      await new Promise(() => {}); // keep process alive

    } catch (err) {
      console.error("[OTMenT] Automation failed:", err);
    }
  }

  if (!success) {
    console.error("[OTMenT] All attempts failed.");
    process.exit(1);
  }
}

launchWithExtension().catch(err => {
  console.error("[OTMenT] Fatal error:", err);
  process.exit(1);
});