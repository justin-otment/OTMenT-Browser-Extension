/**
 * Unified Orchestrator.js (Full, hardened)
 * - Robust OpenVPN handling without relying on --daemon + sudo where possible
 * - Writes logs to artifacts for CI-readable diagnostics
 * - Waits for "Initialization Sequence Completed" or pid file
 * - Safer external IP detection with retries
 * - Proper chromeArgs splitting and diagnostics
 * - Decodes EXT_KEY (base64) to key.pem inside extension path if provided
 * - Better extension detection (targets + extensionPath listing)
 * - Unique user-data-dir per run; cleans up on exit
 * - Explicit exit codes for CI
 */

import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import puppeteer from "puppeteer-core";
import crypto from "crypto";

const rootDir = process.cwd();
const vpnDir = path.resolve("VPN");
const stateFile = path.join(vpnDir, ".vpn_state.json");
const authFile = path.join(vpnDir, "auth.txt");
const artifactsDir = path.resolve("artifacts/diagnostics");
const screenshotsDir = path.resolve("artifacts/screenshots");
const openvpnLogsDir = path.join(artifactsDir, "openvpn");
const targetUrl =
  process.env.TEST_PAGE_URL || "http://127.0.0.1:8080/otment-test.html";
const publicIPServices = ["https://ifconfig.co", "https://api.ipify.org"];
const connectTimeoutSec = parseInt(process.env.VPN_CONNECT_TIMEOUT || "60", 10);
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const extensionPath = process.env.EXTENSION_PATH || process.cwd();

fs.mkdirSync(artifactsDir, { recursive: true });
fs.mkdirSync(screenshotsDir, { recursive: true });
fs.mkdirSync(openvpnLogsDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function fetchExternalIP() {
  // Try multiple services with small retries
  for (const svc of publicIPServices) {
    try {
      const out = execSync(`curl -s --connect-timeout 5 ${svc}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out && out.length > 0) return out;
    } catch {
      // fallback
    }
  }
  return "unknown";
}

function listVpnConfigs() {
  if (!fs.existsSync(vpnDir)) return [];
  return fs
    .readdirSync(vpnDir)
    .filter((f) => f.endsWith(".ovpn"))
    .map((f) => path.join(vpnDir, f));
}

function loadRotationState() {
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    }
  } catch {}
  return { used: [] };
}

function saveRotationState(state) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save rotation state:", e.message);
  }
}

function writeArtifact(filename, data) {
  const p = path.join(artifactsDir, filename);
  try {
    fs.writeFileSync(p, data, "utf8");
  } catch (e) {
    console.error("Failed writing artifact", p, e.message);
  }
}

// decode and write EXT_KEY to key.pem if provided; return boolean indicating action
function injectExtensionKeyIfPresent(extPath) {
  const b64 = process.env.EXT_KEY;
  if (!b64) return false;
  try {
    const keyPem = Buffer.from(b64, "base64").toString("utf8");
    const keyPath = path.join(extPath, "key.pem");
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    console.log("WROTE extension key.pem to", keyPath);
    writeArtifact("extension-key-wrote.txt", keyPath);
    return true;
  } catch (err) {
    console.error("Failed to decode/write EXT_KEY:", err.message);
    writeArtifact("extension-key-error.txt", err.message);
    return false;
  }
}

function listExtensionPathContents(extPath) {
  try {
    const listing = safeExec(`ls -la ${extPath}`);
    writeArtifact("extension-path-listing.txt", listing);
    return listing;
  } catch {
    return "";
  }
}

async function startOpenvpn(configPath) {
  // Log files per-config run
  const cfgBase = path.basename(configPath).replace(/\W+/g, "_");
  const logFile = path.join(openvpnLogsDir, `${cfgBase}.log`);
  const pidFile = path.join(openvpnLogsDir, `${cfgBase}.pid`);

  // Check auth file
  if (!fs.existsSync(authFile)) {
    throw new Error(`auth.txt missing at ${authFile}`);
  }

  // Prefer non-sudo spawn if runner has permissions; fallback to sudo
  const trySudo = process.env.FORCE_SUDO === "1";
  const argvBase = [
    "--config",
    configPath,
    "--auth-user-pass",
    authFile,
    "--writepid",
    pidFile,
    "--log",
    logFile,
  ];

  // Ensure a fresh log file exists and is writable by current user
  try {
    fs.writeFileSync(logFile, `OpenVPN log initialized ${new Date().toISOString()}\n`, { flag: "a" });
    fs.chmodSync(logFile, 0o660);
  } catch (e) {
    // best-effort
  }

  console.log("Starting openvpn with log:", logFile);
  writeArtifact("openvpn-cmd.txt", `${trySudo ? "sudo " : ""}openvpn ${argvBase.join(" ")}`);

  // Spawn openvpn and capture streams
  let child;
  try {
    if (!trySudo) {
      child = spawn("openvpn", argvBase, { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      child = spawn("sudo", ["openvpn", ...argvBase], { stdio: ["ignore", "pipe", "pipe"] });
    }
  } catch (err) {
    throw new Error("Failed to spawn openvpn: " + err.message);
  }

  // Pipe child output into log file
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  if (child.stdout) child.stdout.pipe(logStream);
  if (child.stderr) child.stderr.pipe(logStream);

  child.on("error", (e) => {
    logStream.write(`[OPENVPN SPAWN ERROR] ${e.message}\n`);
  });

  // Wait for readiness: either pid file exists or log contains marker
  let connected = false;
  for (let i = 0; i < connectTimeoutSec; i++) {
    await sleep(1000);
    try {
      if (fs.existsSync(pidFile)) {
        const pid = fs.readFileSync(pidFile, "utf8").trim();
        if (pid && /^\d+$/.test(pid)) {
          connected = true;
          break;
        }
      }
      // Read tail of log for "Initialization Sequence Completed"
      const tail = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").slice(-8192)
        : "";
      if (tail.includes("Initialization Sequence Completed")) {
        connected = true;
        break;
      }
    } catch (e) {
      // ignore transient read errors
    }
  }

  if (!connected) {
    // dump last lines for artifact then kill child
    try {
      const last = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-8192) : "";
      writeArtifact(`openvpn-${cfgBase}-failure.log`, last || "no-log");
    } catch {}
    try {
      child.kill("SIGTERM");
    } catch {}
    throw new Error("VPN connection timeout or failed to initialize");
  }

  // Verify an interface exists (tun/tap)
  let ifaces = "";
  try {
    ifaces = safeExec("ip a");
    writeArtifact(`${cfgBase}-ip-a.txt`, ifaces);
  } catch {}
  if (!/tun|tap/.test(ifaces)) {
    // still allow if "Initialization Sequence Completed" present; we've already checked
    console.warn("No tun/tap interface detected in ip a; continuing because init marker found");
  }

  // Return runtime info
  return { logFile, pidFile, child };
}

async function stopOpenvpnByPidFile(pidFile) {
  try {
    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, "utf8").trim();
      if (pid && /^\d+$/.test(pid)) {
        try {
          process.kill(parseInt(pid, 10), "SIGTERM");
        } catch {}
      }
      try { fs.unlinkSync(pidFile); } catch {}
    }
  } catch {}
}

async function disconnectVPNAll() {
  // best-effort cleanup for any openvpn we started
  try {
    // kill processes named openvpn (best-effort)
    execSync("pkill -f openvpn || true");
  } catch {}
  console.log("VPN cleanup attempted.");
  writeArtifact("vpn-cleanup.txt", `cleanup at ${new Date().toISOString()}`);
}

// === Browser automation ===
function parseChromeArgs() {
  const raw = process.env.CHROME_ARGS || "";
  const args = raw && raw.trim() ? raw.trim().split(/\s+/) : [];
  return args;
}

function uniqueChromeProfileDir() {
  const stamp = Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
  return path.join("/tmp", `chrome-profile-${stamp}`);
}

async function runBrowserAutomation(vpnName, runMeta = {}) {
  console.log(`Launching Chrome automation for ${vpnName}...`);
  const chromeArgs = parseChromeArgs();
  const userDataDir = uniqueChromeProfileDir();
  const absoluteExtPath = path.resolve(extensionPath);

  // Inject key if provided
  injectExtensionKeyIfPresent(absoluteExtPath);
  listExtensionPathContents(absoluteExtPath);

  // Build args ensuring no empty strings
  const args = [
    ...chromeArgs,
    "--enable-automation",
    "--allow-insecure-localhost",
    "--ignore-certificate-errors",
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${absoluteExtPath}`,
    `--load-extension=${absoluteExtPath}`,
  ].filter(Boolean);

  writeArtifact("chrome-args.txt", `${chromePath} ${args.join(" ")}`);
  console.log("CHROME ARGS:", `${chromePath} ${args.join(" ")}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromePath,
      args,
      ignoreDefaultArgs: ["--disable-extensions", "--headless"],
    });
  } catch (err) {
    writeArtifact("puppeteer-launch-error.txt", err.message);
    throw new Error("Failed to launch Chrome: " + err.message);
  }

  console.log("Chrome started");
  // Wait a short while for extension to register
  await sleep(4000);

  // Collect extension-related targets over a short window
  const discovered = new Set();
  for (let i = 0; i < 6; i++) {
    const targets = browser.targets();
    for (const t of targets) {
      try {
        const u = t.url();
        if (u && u.startsWith("chrome-extension://")) {
          discovered.add(u);
        }
      } catch {}
    }
    if (discovered.size) break;
    await sleep(1000);
  }
  const extensions = Array.from(discovered);
  writeArtifact("extensions.log", extensions.length ? extensions.join("\n") : "No extensions detected.");

  // If no extension pages found, attempt to report computed deterministic ID if key present
  // (simple heuristic: list manifest.json and key.pem existence)
  try {
    const hasKey = fs.existsSync(path.join(absoluteExtPath, "key.pem"));
    const hasManifest = fs.existsSync(path.join(absoluteExtPath, "manifest.json"));
    writeArtifact("extension-inspection.txt", `hasKey:${hasKey};hasManifest:${hasManifest}`);
  } catch {}

  // Puppeteer page for verification
  const page = await browser.newPage();
  const puppeteerLog = path.join(artifactsDir, "puppeteer.log");
  const logStream = fs.createWriteStream(puppeteerLog, { flags: "a" });
  page.on("console", (msg) => {
    try {
      logStream.write(`[${new Date().toISOString()}] ${msg.text()}\n`);
    } catch {}
  });

  page.setDefaultTimeout(60000);
  let statusText = "no-status-element";
  try {
    console.log("Navigating to", targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);
    // Query possible hooks: #otment-status, window.__OTMENT_STATUS, data-otment attributes
    statusText = await page.evaluate(() => {
      const el = document.querySelector("#otment-status");
      if (el) return el.textContent.trim();
      if (window && window.__OTMENT_STATUS) return String(window.__OTMENT_STATUS);
      const attr = document.querySelector("[data-otment-status]");
      if (attr) return attr.getAttribute("data-otment-status");
      return "no-status-element";
    });
    writeArtifact("extension-status.json", JSON.stringify({ status: statusText, url: targetUrl }, null, 2));
    const shot = path.join(screenshotsDir, `${vpnName.replace(/\W+/g, "_")}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log("Screenshot saved:", shot);

    if (/active/i.test(statusText)) {
      console.log("Extension appears ACTIVE");
      writeArtifact("extension-verified.txt", `active:${statusText}`);
    } else {
      console.warn("Extension not reporting active status:", statusText);
      writeArtifact("extension-verified.txt", `inactive:${statusText}`);
    }
  } catch (err) {
    console.error("Browser automation step failed:", err.message);
    logStream.write(`[ERROR] ${err.stack}\n`);
    writeArtifact("puppeteer-error.txt", err.message);
  } finally {
    try {
      await browser.close();
    } catch {}
    try { logStream.end(); } catch {}
    // Cleanup user-data-dir
    try {
      execSync(`rm -rf ${userDataDir} || true`);
    } catch {}
  }

  return { statusText, extensions };
}

// === MAIN ===
(async () => {
  try {
    const allConfigs = listVpnConfigs();
    if (!allConfigs.length) {
      console.error("No VPN configs found in /VPN/");
      process.exit(10);
    }

    const state = loadRotationState();
    const remaining = allConfigs.filter((cfg) => !state.used.includes(path.basename(cfg)));
    const nextConfig = remaining.length ? remaining[0] : allConfigs[0];
    const vpnName = path.basename(nextConfig).replace(/\.ovpn$/, "");

    console.log("Selected VPN:", vpnName);
    if (!remaining.length) state.used = [];

    // Capture pre-VPN IP
    const preIP = await fetchExternalIP();
    writeArtifact("pre-vpn-ip.txt", preIP);
    console.log("Pre-VPN IP:", preIP);

    // Start VPN
    let runtimeInfo;
    try {
      runtimeInfo = await startOpenvpn(nextConfig);
    } catch (err) {
      console.error("VPN start failed:", err.message);
      writeArtifact("vpn-start-error.txt", err.message);
      await disconnectVPNAll();
      process.exit(20);
    }

    // Confirm external IP changed
    const postIP = await fetchExternalIP();
    writeArtifact("post-vpn-ip.txt", postIP);
    console.log("Post-VPN IP:", postIP);
    if (!postIP || postIP === "unknown" || postIP === preIP) {
      console.error("VPN did not change external IP or IP unknown");
      // Dump VPN log to artifacts for debugging
      try {
        const tail = fs.existsSync(runtimeInfo.logFile) ? fs.readFileSync(runtimeInfo.logFile, "utf8").slice(-8192) : "";
        writeArtifact("openvpn-tail-on-failure.log", tail);
      } catch {}
      await disconnectVPNAll();
      process.exit(21);
    }

    // Run browser automation
    try {
      const { statusText, extensions } = await runBrowserAutomation(vpnName, { preIP, postIP });
      // If extension not active, return nonzero but continue cleanup
      if (!/active/i.test(statusText)) {
        console.warn("Extension verification failed or inactive");
        state.used.push(path.basename(nextConfig));
        saveRotationState(state);
        await stopOpenvpnByPidFile(runtimeInfo.pidFile);
        await disconnectVPNAll();
        process.exit(30);
      }
      // success path
      state.used.push(path.basename(nextConfig));
      saveRotationState(state);
      await stopOpenvpnByPidFile(runtimeInfo.pidFile);
      await disconnectVPNAll();
      console.log("SUCCESS: Extension appears active and VPN verified.");
      process.exit(0);
    } catch (err) {
      console.error("Browser automation error:", err.message);
      writeArtifact("automation-failure.txt", err.message);
      await stopOpenvpnByPidFile(runtimeInfo.pidFile);
      await disconnectVPNAll();
      process.exit(31);
    }
  } catch (err) {
    console.error("Fatal error:", err.message);
    writeArtifact("fatal-error.txt", err.stack || err.message);
    try { await disconnectVPNAll(); } catch {}
    process.exit(99);
  }
})();
