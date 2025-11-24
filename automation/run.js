import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { firefox } from "puppeteer-firefox";
import fs from "fs/promises";

// ---------------------------------------------
// 1. Generate AMO JWT Token
// ---------------------------------------------
function amoJWT() {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;

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

  const url = `https://addons.mozilla.org/api/v5/addons/addon/${addonId}/versions/`;

  const res = await fetch(url, {
    headers: { Authorization: `JWT ${jwtToken}` }
  });

  const data = await res.json();
  const fileUrl = data.results[0].file.url;

  // Download the .xpi file
  const xpiRes = await fetch(fileUrl);
  const xpi = await xpiRes.arrayBuffer();

  await fs.writeFile("addon.xpi", Buffer.from(xpi));

  return "addon.xpi";
}

// ---------------------------------------------
// 3. Launch Firefox + Install Add-on
// ---------------------------------------------
async function launchWithAddon(xpiPath) {
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
}

// ---------------------------------------------
// MAIN
// ---------------------------------------------
(async () => {
  const xpi = await downloadAddon();
  await launchWithAddon(xpi);
})();