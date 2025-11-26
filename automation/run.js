// automation/run.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const MAX_ATTEMPTS = 5;
const WAIT_SECONDS = 10;

async function findExtensionId(browser) {
  // implement your extension ID detection logic here
  // placeholder: return first extension id found
  const targets = await browser.targets();
  const extensionTarget = targets.find(t => t.type() === 'background_page');
  if (extensionTarget) {
    const url = extensionTarget.url();
    const match = url.match(/chrome-extension:\/\/([a-z]+)/);
    return match ? match[1] : null;
  }
  return null;
}

async function launchWithExtension() {
  let success = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !success; attempt++) {
    console.log(`[OTMenT] Attempt ${attempt}/${MAX_ATTEMPTS}`);

    const browser = await puppeteer.launch({
      headless: false, // 👈 non-headless for Cloudflare bypass
      args: [
        `--disable-blink-features=AutomationControlled`,
        `--load-extension=${process.env.EXTENSION_PATH || 'GitHub-Onyot'}`,
        `--no-sandbox`,
        `--disable-setuid-sandbox`
      ]
    });

    const page = await browser.newPage();
    await page.goto('https://target-site.com', { waitUntil: 'domcontentloaded' });

    // Detect Cloudflare challenge
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

    // Extension handling
    const extId = await findExtensionId(browser);
    if (!extId) {
      console.warn('[OTMenT] Could not detect extension id automatically.');
    } else {
      console.log('[OTMenT] Detected extension id:', extId);

      const candidates = [
        '/popup.html',
        '/index.html',
        '/popup/popup.html',
        '/_generated_background_page.html'
      ];
      let opened = false;
      for (const c of candidates) {
        const url = `chrome-extension://${extId}${c}`;
        try {
          const extPage = await browser.newPage();
          await extPage.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
          console.log('[OTMenT] Opened extension page:', url);

          try {
            await extPage.waitForSelector('#start-btn, button.start, .start-btn', { timeout: 2000 });
            await extPage.click('#start-btn, button.start, .start-btn');
            console.log('[OTMenT] Clicked start button in extension popup (if present)');
          } catch {
            // no start button — fine
          }
          opened = true;
          break;
        } catch {
          console.log('[OTMenT] candidate not found:', url);
        }
      }
      if (!opened) console.log('[OTMenT] Could not open a popup page candidate — extension may be background-only');
    }

    // Screenshots
    try {
      await page.screenshot({ path: 'post-login.png' });
      console.log('[OTMenT] Saved post-login.png');
    } catch (e) {
      console.warn('[OTMenT] Screenshot failed:', e.message);
    }

    try {
      await page.screenshot({ path: 'automation-screenshot.png' });
    } catch {}

    console.log('[OTMenT] Browser will remain open for extension to run.');
    success = true;

    // Keep process alive so extension background page can run
    await new Promise(() => {});
  }

  if (!success) {
    console.error("[OTMenT] All attempts failed. Cloudflare challenge not bypassed.");
    process.exit(1);
  }
}

launchWithExtension().catch(err => {
  console.error('[OTMenT] Automation failed:', err);
  process.exit(1);
});