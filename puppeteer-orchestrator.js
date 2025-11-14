const puppeteer = require('puppeteer-core');
const path = require('path');

// Retry settings
const MAX_RETRIES = 3;
let retries = 0;

// Main orchestrator function to activate the extension
const runOrchestrator = async () => {
  try {
    const browser = await puppeteer.launch({
      headless: false, // Run in headful mode to allow UI interactions
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', // Path to Chrome
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--load-extension=${path.join(__dirname, 'dist')}`, // Point to your dist folder
      ],
    });

    const page = await browser.newPage();

    // Wait for the extension to load and confirm it's active (e.g., by checking the extension UI)
    await page.waitForSelector('#extension-ui', { timeout: 60000 }); // Adjust selector for your extension's UI

    console.log('Extension activated and UI loaded successfully!');

    // Optionally take a screenshot to confirm the extension is working
    await page.screenshot({ path: 'artifacts/screenshots/extension-activated.png' });

    // You can add any other checks or actions here (e.g., interact with the extension's UI)

    await browser.close();
    console.log('Puppeteer orchestrator complete!');
  } catch (error) {
    console.error('Error during puppeteer orchestrator:', error);
    if (retries < MAX_RETRIES) {
      retries++;
      console.log(`Retrying... (${retries}/${MAX_RETRIES})`);
      await runOrchestrator(); // Retry orchestrator
    } else {
      console.error('Max retries reached. Orchestrator failed.');
      process.exit(1); // Exit with failure
    }
  }
};

// Run the orchestrator
runOrchestrator();
