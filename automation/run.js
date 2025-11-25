// automation/run.js


// try to find extension id
const extId = await findExtensionId(browser);
if (!extId) {
console.warn('[OTMenT] Could not detect extension id automatically.');
} else {
console.log('[OTMenT] Detected extension id:', extId);


// attempt to open popup.html or index.html
const candidates = ['/popup.html', '/index.html', '/popup/popup.html', '/_generated_background_page.html'];
let opened = false;
for (const c of candidates) {
const url = `chrome-extension://${extId}${c}`;
try {
const extPage = await browser.newPage();
await extPage.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
console.log('[OTMenT] Opened extension page:', url);
// optional: click a start button if present
try {
await extPage.waitForSelector('#start-btn, button.start, .start-btn', { timeout: 2000 });
await extPage.click('#start-btn, button.start, .start-btn');
console.log('[OTMenT] Clicked start button in extension popup (if present)');
} catch (e) {
// no start button — fine
}
opened = true;
break;
} catch (e) {
// ignore and try next
console.log('[OTMenT] candidate not found:', url);
}
}


if (!opened) console.log('[OTMenT] Could not open a popup page candidate — extension may be background-only');
}


// take screenshot for artifact
try {
await page.screenshot({ path: 'post-login.png' });
console.log('[OTMenT] Saved post-login.png');
} catch (e) {
console.warn('[OTMenT] Screenshot failed:', e.message);
}


// also take a quick page screenshot
try {
await page.screenshot({ path: 'automation-screenshot.png' });
} catch (e) {}


console.log('[OTMenT] Browser will remain open for extension to run.');
// keep process alive so the extension background page can run. CI will wait until job timeout or you can close manually.
await new Promise(() => {});
}


launchWithExtension().catch(err => {
console.error('[OTMenT] Automation failed:', err);
process.exit(1);
});
