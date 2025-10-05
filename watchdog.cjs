// watchdog.cjs
// Run AHK elevated either via scheduled task (preferred) or UAC prompt fallback

const { exec } = require("child_process");

const AHK = "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe";
const SCRIPT = "C:\\Users\\DELL\\Desktop\\OTMenT\\test1.ahk";
const TASK_NAME = "RunAHK_Test1";

// --- Attach RDP session back to console
function attachToConsole() {
  exec(
    `for /f "tokens=3" %i in ('query session %USERNAME%') do tscon %i /dest:console`,
    { shell: "cmd.exe" },
    (err) => {
      if (err) console.error("⚠ tscon failed:", err.message);
      else console.log("✅ Session attached to console.");
    }
  );
}

// --- Create scheduled task once
function createScheduledTaskIfMissing(cb) {
  // Escape quotes properly for schtasks
  const tr = `\\"${AHK}\\" \\"${SCRIPT}\\"`;
  const createCmd = `schtasks /Create /TN "${TASK_NAME}" /TR "${tr}" /SC ONCE /ST 00:00 /RL HIGHEST /F`;

  console.log("DEBUG createCmd:", createCmd);

  exec(createCmd, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Failed to create scheduled task:", err.message);
      if (stderr) console.error(stderr);
      return cb && cb(err);
    }
    console.log("✅ Scheduled task created/updated.");
    cb && cb(null);
  });
}

// --- Run scheduled task
function runScheduledTask() {
  console.log(new Date(), "▶ Triggering scheduled task:", TASK_NAME);
  exec(`schtasks /Run /TN "${TASK_NAME}"`, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Failed to run scheduled task:", err.message);
      if (stderr) console.error(stderr);
      console.log("⚠ Falling back to PowerShell elevation...");
      runAHKViaPowerShell();
    } else {
      console.log("✅ Task triggered.");
    }
  });
}

// --- Run AHK via PowerShell (UAC prompt each time)
function runAHKViaPowerShell() {
  console.log(new Date(), "▶ Launching AHK via PowerShell (elevated)...");
  const psCmd = `Start-Process -FilePath '${AHK}' -ArgumentList '${SCRIPT}' -Verb RunAs`;
  const full = `powershell -NoProfile -WindowStyle Hidden -Command "${psCmd}"`;

  exec(full, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ PowerShell elevation failed:", err.message);
      if (stderr) console.error(stderr);
    } else {
      console.log("✅ AHK start requested (UAC prompt shown).");
    }
  });
}

// --- Init
attachToConsole();
createScheduledTaskIfMissing((err) => {
  if (!err) {
    runScheduledTask();
    setInterval(() => {
      console.log(new Date(), "⏲ Re-triggering scheduled task...");
      runScheduledTask();
    }, 3 * 60 * 1000);
  } else {
    // fallback immediately if we cannot create task
    runAHKViaPowerShell();
    setInterval(() => {
      console.log(new Date(), "⏲ Re-launching AHK via PowerShell...");
      runAHKViaPowerShell();
    }, 3 * 60 * 1000);
  }
});
