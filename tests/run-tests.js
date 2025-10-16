const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const extPath = path.resolve(__dirname, '../txt files'); // repo extension folder
  if (!fs.existsSync(extPath)) {
    console.error('EXTENSION_NOT_FOUND', extPath);
    process.exit(2);
  }

  const userDataDir = path.resolve(__dirname, '../tmp/profile-' + Date.now());
  const args = [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`
  ];

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
  });

  try {
    // wait shortly for extension background to register
    await new Promise(r => setTimeout(r, 1500));

    // Collect background pages if any
    const bgPages = context.backgroundPages();
    if (bgPages.length) {
      console.log('BACKGROUND_PAGES', bgPages.length);
      for (let i = 0; i < bgPages.length; i++) {
        const logs = await bgPages[i].evaluate(() => {
          return { href: location.href, title: document.title || null };
        });
        console.log('BG_PAGE', i, JSON.stringify(logs));
      }
    } else {
      console.log('NO_BACKGROUND_PAGES_DETECTED');
    }

    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Example: open an extension page by guessing a filename; adjust to real file if known
    // If your extension exposes a popup or options page, load it directly:
    // await page.goto(`chrome-extension://${YOUR_EXTENSION_ID}/popup.html`);
    // If you don't know the ID in CI, you can find extension targets via context.backgroundPages()

    await page.screenshot({ path: 'artifact-screenshot.png', fullPage: true });

    console.log('TEST_OK');
    await context.close();
    process.exit(0);
  } catch (err) {
    console.error('TEST_FAILED', err);
    try { await context.close(); } catch {}
    process.exit(3);
  }
})();