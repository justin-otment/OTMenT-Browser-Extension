import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import puppeteerFirefox from "puppeteer-firefox";   // CommonJS default import
import fs from "fs/promises";

const { firefox } = puppeteerFirefox;               // destructure from default

// ---------------------------------------------
// 1. Generate AMO JWT Token
// ---------------------------------------------
function amoJWT() {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;

  if (!issuer || !secret) {
    throw new Error("Missing AMO_JWT_ISSUER or AMO_JWT_SECRET environment variables");
  }

  const payload = {
    iss: issuer,
    jti: Math.random().toString(),
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "5m" });
}

// ---------------------------------------------
// 2. Download Firefox Add-on (.xpi)
// ---------------------------------------------
async function downloadAddon() {
  const jwtToken = amoJWT();
  const addonId = process.env.ADDON_ID;

  if (!addonId) {
    throw new Error("Missing ADDON_ID environment variable");
  }

  const url = `https://addons.mozilla.org/api/v5/addons/addon/${addonId}/versions/`;
  console.log(`Fetching addon metadata from: ${url}`);

  const res = await fetch(url, {
    headers: { Authorization: `JWT ${jwtToken}` }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch addon metadata: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.results?.[0]?.file?.url) {
    throw new Error("No addon file URL found in AMO response");
  }

  const fileUrl = data.results[0].file.url;
  console.log(`Downloading addon from: ${fileUrl}`);

  const xpiRes = await fetch(fileUrl);
  if (!xpiRes.ok) {
    throw new Error(`Failed to download addon: ${xpiRes.status} ${xpiRes.statusText}`);
  }

  const xpi = await xpiRes.arrayBuffer();
  const path = "addon.xpi";
  await fs.writeFile(path, Buffer.from(xpi));

  console.log(`Addon saved to ${path}`);
  return path;
}

// ---------------------------------------------
// 3. Launch Firefox + Install Add-on
// ---------------------------------------------
async function launchWithAddon(xpiPath) {
  console.log("Launching Firefox with addon...");

  const browser = await firefox.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${xpiPath}`,
      `--load-extension=${xpiPath}`
    ]
  });

  const page = await browser.newPage();
  await page.goto("https://example.com");

  console.log("Firefox launched with your extension!");

  // Graceful cleanup
  await browser.close();
  console.log("Browser closed cleanly.");
}

// ---------------------------------------------
// MAIN
// ---------------------------------------------
(async () => {
  try {
    const xpi = await downloadAddon();
    await launchWithAddon(xpi);
  } catch (err) {
    console.error("Automation failed:", err);
    process.exit(1);
  }
})();