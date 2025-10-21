// scripts/browser-automation.js
import puppeteer from 'puppeteer';

async function run() {
  const targetUrl = process.env.TARGET_URL || 'https://www.fastpeoplesearch.com/address/123-main-street_98001';
  console.log(`🚀 Launching Chrome for ${targetUrl}`);

  const browser = await puppeteer.launch({
    headless: false, // you’re using xvfb in the workflow so GUI works fine
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      `--disable-extensions-except=${process.cwd()}`,
      `--load-extension=${process.cwd()}`
    ]
  });

  const page = await browser.newPage();

  // Optional: clear cookies / cache before navigation
  const client = await page.target().createCDPSession();
  await client.send('Network.clearBrowserCookies');
  await client.send('Network.clearBrowserCache');

  console.log('🌐 Navigating to target URL...');
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('⏳ Waiting 15 seconds for full render...');
  await page.waitForTimeout(15000);

  // --- Replace coordinate clicks with element-based clicks ---
  // If you really have to click at coordinates, you can use page.mouse.click(x, y)
  // For example, these emulate AHK’s ControlClick("x0 y303") and ("x562 y303")
  console.log('🖱 Performing simulated coordinate clicks...');
  await page.mouse.click(0, 303);
  await page.waitForTimeout(2000);
  await page.mouse.click(562, 303);
  await page.waitForTimeout(3000);

  // --- Optional: reload / refresh the page twice like AHK did ---
  console.log('🔄 Reloading page...');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForTimeout(3500);

  console.log('✅ Browser automation sequence complete.');
  await browser.close();
}

run().catch(err => {
  console.error('❌ Browser automation failed:', err);
  process.exit(1);
});
