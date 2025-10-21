// scripts/test1AHK.cjs
// Converted from the provided AutoHotkey script into a GitHub Actions compatible
// CommonJS Node.js script that performs one iteration (connect VPN, run browser actions).
// Designed for ubuntu-latest runners (Xvfb + Chrome). Adjust env vars as needed.

const { execSync, exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ----------------------------
// Immediate heartbeat on startup (WriteHeartbeat)
const HEARTBEAT_PATH = "/tmp/ahk_heartbeat.log";
function WriteHeartbeat() {
  const now = new Date().toISOString() + "\n";
  try {
    fs.appendFileSync(HEARTBEAT_PATH, now, "utf8");
  } catch (e) {
    // best-effort
  }
}
WriteHeartbeat();
setInterval(WriteHeartbeat, 60_000);

// ============================================
// === Paths and Constants ===
let vpnPath = process.env.OTMENT_VPN_PATH || path.join(process.cwd(), "VPN");
let authFile = process.env.OTMENT_AUTH_FILE || path.join(vpnPath, "auth.txt");
let chromeExecutable = process.env.CHROME_PATH || "google-chrome";
let testUrl = process.env.TEST_PAGE_URL || "http://127.0.0.1:8080/otment-test.html";
let extensionRoot = process.cwd(); // we load extension from repo root when launching chrome args

// === Settings ===
const retryLimit = 3;
const vpnConnectDelay = 8000;
const chromeLoadDelay = 6500;
let lastConfig = "";
let lastPublicIP = "";

// Simple tray-tip substitute (log)
function TrayTip(title, msg, seconds = 3) {
  console.log(`[TrayTip] ${title}: ${msg} (for ${seconds}s)`);
}

// ============================================
// Ensure auth-user-pass directive exists (EnsureAuthDirective)
function EnsureAuthDirective(filePath, authFilePath) {
  try {
    let txt = fs.readFileSync(filePath, "utf8");
    if (!/auth-user-pass/i.test(txt)) {
      // append directive
      fs.appendFileSync(filePath, `\nauth-user-pass ${authFilePath}\n`, "utf8");
    }
  } catch (err) {
    throw err;
  }
}

// ============================================
// Get current public IP (GetPublicIP)
function GetPublicIP() {
  return new Promise((resolve) => {
    let data = "";
    const req = https.get("https://api.ipify.org", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    });
    req.on("error", () => resolve(""));
    req.end();
  });
}

// ============================================
// Check if VPN is connected (CheckVPNConnection)
// Linux check: verify tun0 exists and route via tun0. Also accept a config name presence in /proc or openvpn process args.
function CheckVPNConnection(configName) {
  try {
    // Check for tun0
    const ipOut = execSync("/sbin/ip a || ip a", { encoding: "utf8" });
    if (!/tun0/.test(ipOut)) return false;
    // Optionally look for openvpn process referencing the configName
    try {
      const ps = execSync("ps -ef | grep openvpn | grep -v grep", { encoding: "utf8" });
      if (ps && configName && ps.includes(path.basename(configName))) return true;
    } catch {}
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Connect VPN with random UDP config (ConnectVPN)
async function ConnectVPN() {
  TrayTip("Automation", `Scanning VPN configs in ${vpnPath}`, 2);
  let files = [];
  try {
    files = fs.readdirSync(vpnPath).filter((f) => f.toLowerCase().endsWith(".ovpn") && f.toLowerCase().includes("udp"));
  } catch (err) {
    console.error("No VPN folder or unreadable:", err.message);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error("No UDP .ovpn configs found in:", vpnPath);
    process.exit(1);
  }

  // Choose random config (not same as last one)
  let chosenFile;
  if (files.length === 1) chosenFile = files[0];
  else {
    do {
      const idx = Math.floor(Math.random() * files.length);
      chosenFile = files[idx];
    } while (chosenFile === lastConfig);
  }
  lastConfig = chosenFile;

  const configPath = path.join(vpnPath, chosenFile);
  const configName = chosenFile.replace(/\.ovpn$/i, "");
  try {
    EnsureAuthDirective(configPath, authFile);
  } catch (err) {
    console.warn("EnsureAuthDirective failed:", err.message);
  }

  // Stop any running openvpn started previously by this job (best-effort)
  try {
    execSync("pkill -f openvpn || true");
  } catch {}

  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    try {
      // Use nohup + sudo like your workflow; in CI sudo is available
      const cmd = fs.existsSync(authFile)
        ? `sudo nohup openvpn --config "${configPath}" --auth-user-pass "${authFile}" --daemon --writepid /tmp/openvpn.pid --log /tmp/openvpn.log`
        : `sudo nohup openvpn --config "${configPath}" --daemon --writepid /tmp/openvpn.pid --log /tmp/openvpn.log`;
      execSync(cmd, { stdio: "ignore" });
    } catch (err) {
      // ignore immediate failures; rely on subsequent checks
    }

    await new Promise((r) => setTimeout(r, vpnConnectDelay + attempt * 2000));
    if (CheckVPNConnection(configName)) {
      const newIP = await GetPublicIP();
      if (newIP && newIP !== lastPublicIP) {
        lastPublicIP = newIP;
        TrayTip("VPN", `Connected: ${configName}\nNew IP: ${newIP}`, 5);
        return configPath;
      }
    }
  }

  TrayTip("VPN Error", `Failed to confirm VPN connection after ${retryLimit} attempts!`, 5);
  return "";
}

// ClearBrowserData (ClearBrowserData)
function ClearBrowserData() {
  // On Linux runner we will attempt to close chrome/chromium processes gracefully
  try {
    execSync("pkill -f chrome || true");
    TrayTip("Chrome", "Closed all Chrome/Chromium processes.", 2);
    return true;
  } catch {
    TrayTip("Chrome", "Chrome not running or could not be closed.", 3);
    return false;
  }
}

// clearCookies (clearCookies) - best-effort no GUI: close chrome and remove profile cache if safe
function clearCookies() {
  // For CI we prefer to start with a fresh profile by passing --user-data-dir if needed.
  // As a lightweight action just close chrome and return true.
  ClearBrowserData();
  return true;
}

// SafeAltTabClose (SafeAltTabClose) - not applicable on headless CI; provide no-op
function SafeAltTabClose(timeoutMs = 2000) {
  // no-op in CI environment
  return false;
}

// RefreshAllChromeTabs (RefreshAllChromeTabs) - not applicable directly; no-op
function RefreshAllChromeTabs() {
  // We don't control browser tabs from here without chromedriver/puppeteer.
  TrayTip("Chrome", "RefreshAllChromeTabs: no-op in CI script", 1);
  return true;
}

// DoBrowserAutomation (DoBrowserAutomation)
async function DoBrowserAutomation() {
  TrayTip("Automation", "Starting browser automation", 2);

  // --- Prepare: clear cookies / close browsers ---
  clearCookies();
  await new Promise((r) => setTimeout(r, 500));

  // --- Launch Chrome with extension loaded (non-headless) via CHROME_ARGS if provided ----
  const CHROME_ARGS_ENV = process.env.CHROME_ARGS || `--disable-extensions-except=${extensionRoot} --load-extension=${extensionRoot} --no-sandbox --disable-dev-shm-usage --window-size=1920,1080`;
  const args = CHROME_ARGS_ENV.split(" ").filter(Boolean).concat([testUrl]);

  try {
    // spawn chrome/chromium
    const chromeProc = spawn(chromeExecutable, args, { detached: true, stdio: "ignore" });
    chromeProc.unref();
  } catch (err) {
    console.warn("Failed to spawn chrome directly, trying 'chromium' fallback:", err.message);
    try {
      spawn("chromium", args, { detached: true, stdio: "ignore" }).unref();
    } catch {}
  }

  // wait for page to load
  await new Promise((r) => setTimeout(r, chromeLoadDelay + 5000));

  // Best-effort: use curl to check test page reachable from within CI environment
  try {
    execSync(`curl -sSf "${testUrl}"`, { stdio: "ignore" });
    TrayTip("Browser", `Test page reachable: ${testUrl}`, 2);
  } catch {
    console.warn("Test page not reachable from job environment (it should be served by http-server step).");
  }

  // No GUI input automation here; rely on extension + page interactions
  return true;
}

// === Main single-run flow (Loop single iteration) ===
(async function main() {
  try {
    TrayTip("Automation", "Script started (single iteration)", 3);
    const cfg = await ConnectVPN();
    if (cfg) {
      await DoBrowserAutomation();
      console.log("Automation iteration completed successfully.");
      process.exit(0);
    } else {
      console.error("VPN connection failed; exiting with code 2.");
      process.exit(2);
    }
  } catch (err) {
    console.error("Unhandled error in main:", err && err.stack ? err.stack : err);
    process.exit(3);
  }
})();
