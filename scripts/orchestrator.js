/**
 * Orchestrator.js — Linux/GitHub Actions-safe replacement for AHK automation
 * -----------------------------------------------------------
 * ✅ Rotates through VPN configs (no repeats until reset)
 * ✅ Connects to OpenVPN
 * ✅ Verifies new external IP
 * ✅ Launches Chrome (Puppeteer)
 * ✅ Waits for iframe + input to become visible
 * ✅ Clicks input inside iframe and captures screenshot
 * ✅ Cleans up VPN tunnel
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
const testPage = "http://127.0.0.1:8080/otment-test.html";
const publicIPUrl = "https://ifconfig.co";
const connectTimeoutSec = 60;

// ensure dirs
fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });

// === Helpers ===
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

  // stop previous VPN if any
  try {
    execSync("sudo pkill -f openvpn || true");
  } catch {}

  console.log(`🌐 Connecting VPN: ${path.basename(configPath)}`);
  const baseIP = getExternalIP();
  console.log(`Current IP: ${baseIP}`);

  const proc = spawn("sudo", [
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

  // wait for tun0
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
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
      `--disable-extensions-except=${process.cwd()}`,
      `--load-extension=${process.cwd()}`,
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    console.log(`🌍 Navigating to ${testPage}`);
    await page.goto(testPage, { waitUntil: "networkidle2" });

    // wait for iframe and child <input> visibility
    console.log("⏳ Waiting for iframe to appear...");
    await page.waitForSelector("iframe", { visible: true, timeout: 30000 });
    const frameHandle = await page.$("iframe");
    const frame = await frameHandle.contentFrame();

    console.log("⏳ Waiting for input inside iframe...");
    await frame.waitForSelector("input", { visible: true, timeout: 15000 });

    console.log("🖱 Clicking input inside iframe...");
    await frame.click("input");
    await sleep(1000);

    // capture post-click screenshot
    const shot = path.join(screenshotsDir, `iframe-clicked-${vpnName}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`📸 Screenshot saved: ${shot}`);

    // simulate reloads for consistency
    for (let i = 0; i < 2; i++) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(1000);
    }

  } catch (err) {
    console.error("❌ Browser automation failed:", err.message);
  } finally {
    await browser.close();
  }
}

// === Main ===
(async () => {
  const allConfigs = listVpnConfigs();
  if (allConfigs.length === 0) {
    console.error("No VPN configs found in /VPN/");
    process.exit(1);
  }

  let state = loadRotationState();
  const remaining = allConfigs.filter(
    (cfg) => !state.used.includes(path.basename(cfg))
  );

  const nextConfig =
    remaining.length > 0 ? remaining[0] : allConfigs[0]; // reset if done
  const vpnName = path.basename(nextConfig).replace(/\.ovpn$/, "");

  console.log(`🔁 Selected VPN: ${vpnName}`);
  if (remaining.length === 0) {
    console.log("🔄 Resetting rotation — all configs used.");
    state.used = [];
  }

  try {
    const vpnInfo = await connectVPN(nextConfig);
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

