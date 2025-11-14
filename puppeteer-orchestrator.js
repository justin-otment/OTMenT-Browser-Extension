const puppeteer = require('puppeteer-core');
const path = require('path');

// Retry settings
const MAX_RETRIES = 3;
let retries = 0;

// Main orchestrator function to activate the extension and switch to Tab #2
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

    const pages = await browser.pages(); // Get all opened pages/tabs
    const firstTab = pages[0];
    const secondTab = pages[1];

    // If there's no second tab open, open a new tab
    if (!secondTab) {
      console.log("No second tab found, opening a new one...");
      secondTab = await browser.newPage();
    }

    // Activate the extension in the first tab
    await firstTab.waitForSelector('#extension-ui', { timeout: 60000 }); // Replace with your actual extension UI selector
    console.log('Extension activated and UI loaded successfully!');

    // Optionally take a screenshot to confirm the extension is working
    await firstTab.screenshot({ path: 'artifacts/screenshots/extension-activated.png' });

    // Switch to Tab #2
    await switchToTab(secondTab);
    console.log('Switched to Tab #2 successfully!');

    // Optionally take a screenshot of the second tab
    await secondTab.screenshot({ path: 'artifacts/screenshots/tab-2.png' });

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

// Function to switch to a specific tab
const switchToTab = async (tab) => {
  try {
    await tab.bringToFront(); // Bring the second tab to the front
  } catch (error) {
    console.error('Error switching to Tab #2:', error);
  }
};

// Run the orchestrator
runOrchestrator();
