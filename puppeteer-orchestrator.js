const puppeteer = require('puppeteer-core');
const path = require('path');

const MAX_RETRIES = 3;
let retries = 0;

// Helper to wait for service worker registration
async function waitForServiceWorker(browser, workerFile, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const targets = await browser.targets();
    const swTarget = targets.find(
      t => t.type() === 'service_worker' && t.url().includes(workerFile)
    );
    if (swTarget) return swTarget;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

const runOrchestrator = async () => {
  try {
    console.log(`🚀 Launching Chrome with extension: ${process.env.EXTENSION_PATH}`);
    const browser = await puppeteer.launch({
      headless: false, // must be headful for MV3
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--disable-extensions-except=${process.env.EXTENSION_PATH}`,
        `--load-extension=${process.env.EXTENSION_PATH}`,
      ],
    });

    const page = await browser.newPage();

    // Wait for MV3 service worker (navigator.js) to register
    console.log('⏳ Waiting for service worker (navigator.js) to register…');
    const swTarget = await waitForServiceWorker(browser, 'navigator.js', process.env.MAX_RUNTIME_MS || 60000);

    if (!swTarget) {
      throw new Error('Extension MV3 service worker (navigator.js) did NOT load.');
    }

    console.log('✅ MV3 service worker registered successfully!');

    // Optional: Take a screenshot to confirm extension loaded
    await page.goto('about:blank'); // or a page your extension can interact with
    await page.screenshot({ path: 'artifacts/screenshots/extension-activated.png' });

    await browser.close();
    console.log('🎯 Puppeteer orchestrator complete!');
  } catch (error) {
    console.error('❌ Error during puppeteer orchestrator:', error.message || error);
    if (retries < MAX_RETRIES) {
      retries++;
      console.log(`🔁 Retrying... (${retries}/${MAX_RETRIES})`);
      await runOrchestrator();
    } else {
      console.error('💥 Max retries reached. Orchestrator failed.');
      process.exit(1);
    }
  }
};

// Run orchestrator
runOrchestrator();