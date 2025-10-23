/**
 * Unified Orchestrator.js (Extension Verification Enhanced)
 * ------------------------------------------------------------
 * ✅ Handles VPN rotation and connection (OpenVPN)
 * ✅ Verifies IP before & after VPN
 * ✅ Launches Chrome with unpacked extension (repo root)
 * ✅ Waits for extension initialization
 * ✅ Logs all detected extensions
 * ✅ Verifies extension status ("active" vs "inactive")
 * ✅ Takes screenshots and logs console output
 * ✅ Cleans up VPN session, writes diagnostics
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

const targetUrl =
  process.env.TEST_PAGE_URL ||
  "http://127.0.0.1:8080/otment-test.html"; // safer local page for verification
const publicIPUrl = "https://ifconfig.co";
const connectTimeoutSec = 60;

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

// === Browser automation ===
async function runBrowserAutomation(vpnName) {
  console.log(`🧠 Launching Chrome automation for ${vpnName}...`);

  const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
  const chromeArgs = (process.env.CHROME_ARGS || "").split(" ");
  const extensionPath = process.env.EXTENSION_PATH || process.cwd();

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    args: [
      ...chromeArgs,
      "--enable-automation",
      "--allow-insecure-localhost",
      "--ignore-certificate-errors",
      "--user-data-dir=/tmp/chrome-profile",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--headless"],
  });

  console.log("✅ Chrome started successfully.");

  // Wait for extension to fully initialize
  console.log("⏳ Waiting 8s for extension initialization...");
  await sleep(8000);

  // Detect all extension contexts
  const extensions = (await browser.targets())
    .filter((t) => t.url().startsWith("chrome-extension://"))
    .map((t) => t.url());

  const extLog = path.join(artifactsDir, "extensions.log");
  fs.writeFileSync(
    extLog,
    extensions.length ? extensions.join("\n") : "No extensions detected.",
    "utf8"
  );
  console.log(`🔍 Detected extensions: ${extensions.length}`);
  extensions.forEach((e) => console.log(" →", e));

  // Open a new page for verification
  const page = await browser.newPage();
  const logFile = path.join(artifactsDir, "puppeteer.log");
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  page.on("console", (msg) => {
    logStream.write(`[${new Date().toISOString()}] ${msg.text()}\n`);
  });

  page.setDefaultTimeout(60000);

  try {
    console.log(`🌍 Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for page load
    await sleep(5000);

    // Check for extension-injected content
    const statusText = await page.evaluate(() => {
      const el = document.querySelector("#otment-status");
      return el ? el.textContent.trim() : "no-status-element";
    });

    console.log("📊 Extension status element text:", statusText);
    fs.writeFileSync(
      path.join(artifactsDir, "extension-status.json"),
      JSON.stringify({ status: statusText, url: targetUrl }, null, 2),
      "utf8"
    );

    // Take screenshot
    const shot = path.join(screenshotsDir, `${path.basename(vpnName)}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`📸 Screenshot saved: ${shot}`);

    if (statusText.toLowerCase().includes("active")) {
      console.log("✅ Extension appears ACTIVE and running.");
    } else {
      console.warn("⚠️ Extension inactive or not injected properly.");
    }
  } catch (err) {
    console.error("❌ Browser automation failed:", err.message);
    logStream.write(`[ERROR] ${err.stack}\n`);
  } finally {
    await browser.close();
    logStream.end();
    console.log("🧹 Browser session closed.");
  }
}

// === MAIN ===
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
