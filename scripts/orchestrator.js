/**
 * Orchestrator.js — Enhanced Puppeteer + VPN automation
 * -----------------------------------------------------------
 * ✅ Rotates VPN configs safely
 * ✅ Connects via OpenVPN & verifies new IP
 * ✅ Launches Chrome with unpacked extension (root dir)
 * ✅ Logs all loaded Chrome extensions (extensions.log)
 * ✅ Automates FastPeopleSearch test URL
 * ✅ Captures screenshot + saves diagnostics
 * ✅ Cleans up VPN and updates rotation
 */

import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import puppeteer from "puppeteer-core";

const vpnDir = path.resolve("VPN");
const stateFile = path.join(vpnDir, ".vpn_state.json");
const authFile = path.join(vpnDir, "auth.txt");
const artifactsDir = path.resolve("artifacts/diagnostics");
const screenshotsDir = path.resolve("artifacts/screenshots");

// from env or fallback
const testPage =
  process.env.TEST_PAGE_URL ||
  "https://www.fastpeoplesearch.com/address/123-main-st_98001";
const publicIPUrl = "https://ifconfig.co";
const connectTimeoutSec = 60;

// ensure directories exist
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getExternalIP() {
  try {
    return execSync(`curl -s ${publicIPUrl}`, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function listVpnConfigs() {
  return fs
    .readdirSync(vpnDir)
    .filter((f) => f.endsWith(".ovpn"))
    .map((f) => path.join(vpnDir, f));
}

function loadRotationState() {
  if (fs.existsSync(stateFile)) {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  }
  return { used: [] };
}

function saveRotationState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function connectVPN(configPath) {
  const logFile = "/tmp/openvpn.log";
  const pidFile = "/tmp/openvpn.pid";

  try {
    execSync("sudo pkill -f openvpn || true");
  } catch {}

  console.log(`🌐 Connecting VPN: ${path.basename(configPath)}`);
  const baseIP = getExternalIP();
  console.log(`Current IP: ${baseIP}`);

  spawn("sudo", [
    "openvpn",
    "--config",
    configPath,
    "--auth-user-pass",
    authFile,
    "--daemon",
    "--writepid",
    pidFile,
    "--log",
    logFile,
  ]);

  // wait for tun0 to appear
  let connected = false;
  for (let i = 0; i < connectTimeoutSec; i++) {
    await sleep(1000);
    try {
      const ifaces = execSync("ip a", { encoding: "utf8" });
      if (ifaces.includes("tun0")) {
        connected = true;
        break;
      }
    } catch {}
  }

  if (!connected) {
    console.log("❌ VPN failed to connect within timeout.");
    try {
      console.log(fs.readFileSync(logFile, "utf8"));
    } catch {}
    throw new Error("VPN connection timeout");
  }

  const vpnIP = getExternalIP();
  console.log(`VPN external IP: ${vpnIP}`);
  if (vpnIP === baseIP || vpnIP === "unknown") {
    throw new Error("VPN did not change external IP.");
  }

  console.log("✅ VPN active and IP changed.");
  return { vpnIP, baseIP };
}

async function disconnectVPN() {
  try {
    execSync("sudo pkill -f openvpn || true");
  } catch {}
  console.log("🔌 VPN disconnected.");
}

// === Browser Automation ===
async function runBrowserAutomation(vpnName) {
  console.log(`🧠 Launching Chrome automation for ${vpnName}...`);

  const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  const chromeArgs = (process.env.CHROME_ARGS || "").split(" ");

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    args: [
      ...chromeArgs,
      "--enable-automation",
      "--allow-insecure-localhost",
      "--ignore-certificate-errors",
      "--enable-extensions",
      "--user-data-dir=/tmp/chrome-profile",
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--headless"],
  });

  console.log("✅ Chrome started successfully.");

  // detect & log extensions
  try {
    const extensions = (await browser.targets())
      .filter((t) => t.url().startsWith("chrome-extension://"))
      .map((t) => t.url());

    const extLog = path.join(artifactsDir, "extensions.log");
    fs.writeFileSync(extLog, extensions.join("\n"), "utf8");

    if (extensions.length > 0) {
      console.log(`🔍 Detected ${extensions.length} extension(s):`);
      extensions.forEach((u) => console.log("  •", u));
    } else {
      console.warn("⚠️ No extensions detected — check --load-extension path.");
    }
  } catch (e) {
    console.error("❌ Failed to list extensions:", e.message);
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    console.log(`🌍 Navigating to ${testPage}`);
    await page.goto(testPage, { waitUntil: "networkidle2" });

    const shotPath = path.join(
      screenshotsDir,
      `fastpeoplesearch-${vpnName}.png`
    );
    await sleep(3000);
    await page.screenshot({ path: shotPath, fullPage: true });
    console.log(`📸 Screenshot saved: ${shotPath}`);
  } catch (err) {
    console.error("❌ Browser automation failed:", err.message);
  } finally {
    await browser.close();
    console.log("🧹 Browser session closed.");
  }
}

// === Main ===
(async () => {
  const allConfigs = listVpnConfigs();
  if (!allConfigs.length) {
    console.error("No VPN configs found in /VPN/");
    process.exit(1);
  }

  const state = loadRotationState();
  const remaining = allConfigs.filter(
    (cfg) => !state.used.includes(path.basename(cfg))
  );
  const nextConfig = remaining.length ? remaining[0] : allConfigs[0];
  const vpnName = path.basename(nextConfig).replace(/\.ovpn$/, "");

  console.log(`🔁 Selected VPN: ${vpnName}`);
  if (!remaining.length) {
    console.log("🔄 Resetting rotation — all configs used.");
    state.used = [];
  }

  try {
    await connectVPN(nextConfig);
    await runBrowserAutomation(vpnName);
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await disconnectVPN();
    state.used.push(path.basename(nextConfig));
    saveRotationState(state);
    console.log("✅ Rotation state updated.");
  }
})();
