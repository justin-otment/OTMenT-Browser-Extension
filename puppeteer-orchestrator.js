const puppeteer = require('puppeteer-core');
const path = require('path');

// Retry settings
const MAX_RETRIES = 3;
let retries = 0;

// Main orchestrator function to activate the extension
const runOrchestrator = async () => {
  try {
    const EXTENSION_PATH = process.env.EXTENSION_PATH || path.join(__dirname, 'dist');

    const browser = await puppeteer.launch({
      headless: false, // Must be headful for extension UI
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    // --- Detect extension ID ---
    const targets = await browser.targets();
    const extensionTarget = targets.find(t => t.type() === 'background_page');

    if (!extensionTarget) {
      throw new Error("Extension background page not found. Extension did NOT load.");
    }

    const extensionUrl = extensionTarget.url(); // e.g. chrome-extension://abcd1234/_generated_background_page.html
    const extensionId = extensionUrl.split('/')[2];

    if (!extensionId) {
      throw new Error("Failed to extract extension ID.");
    }

    console.log("Detected extension ID:", extensionId);

    // --- Open the extension’s UI page ---
    const uiPage = await browser.newPage();
    const uiUrl = `chrome-extension://${extensionId}/index.html`;

    console.log("Opening extension UI:", uiUrl);

    await uiPage.goto(uiUrl, { waitUntil: 'networkidle0', timeout: 60000 });

    // Wait for your UI root element to show up
    await uiPage.waitForSelector('#extension-ui', { timeout: 60000 });

    console.log('Extension activated and UI loaded successfully!');

    // Screenshot confirmation
    await uiPage.screenshot({
      path: 'artifacts/screenshots/extension-activated.png'
    });

    await browser.close();
    console.log('Puppeteer orchestrator complete!');
  } catch (error) {
    console.error('Error during puppeteer orchestrator:', error);

    if (retries < MAX_RETRIES) {
      retries++;
      console.log(`Retrying... (${retries}/${MAX_RETRIES})`);
      await runOrchestrator();
    } else {
      console.error('Max retries reached. Orchestrator failed.');
      process.exit(1);
    }
  }
};

// Run the orchestrator
runOrchestrator();