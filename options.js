document.addEventListener("DOMContentLoaded", () => {
  const apiKeyInput = document.getElementById('apiKey');
  const apiModeSelect = document.getElementById('apiMode');
  const saveBtn = document.getElementById('save');
  const resetBtn = document.getElementById('reset');
  const updateBtn = document.getElementById('update');
  const toggleBtn = document.getElementById('toggle');
  const statusEl = document.getElementById('status');

  if (!apiKeyInput || !apiModeSelect || !saveBtn || !resetBtn || !statusEl) {
    console.error("❌ Missing DOM elements in options.html");
    return;
  }

  const MIN_KEY_LENGTH = 32; // 2Captcha keys are 32 chars
  saveBtn.disabled = true;

  // Promise helpers for storage
  const storageGet = (keys) =>
    new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (obj) =>
    new Promise((resolve, reject) =>
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      })
    );

  // Load saved settings + enabled flag
  chrome.storage.local.get(['solver_api_key', 'solver_api_mode', 'extension_enabled'], (res) => {
    const { solver_api_key, solver_api_mode, extension_enabled } = res;
    if (solver_api_key) {
      apiKeyInput.value = solver_api_key;
      if (solver_api_key.length >= MIN_KEY_LENGTH) {
        saveBtn.disabled = false;
      }
    }
    apiModeSelect.value = solver_api_mode || 'json';

    // Initialize toggle button label (default ON if undefined)
    const enabled = extension_enabled !== false;
    updateToggleUI(enabled);
  });

  // Enable save when typing
  apiKeyInput.addEventListener('input', () => {
    saveBtn.disabled = apiKeyInput.value.trim().length < MIN_KEY_LENGTH;
    clearStatus();
  });

  // Save handler
  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const mode = apiModeSelect.value;

    if (key.length !== MIN_KEY_LENGTH) {
      showStatus('⚠️ API key must be 32 characters', 'orange');
      return;
    }

    saveBtn.disabled = true;
    showStatus('💾 Saving…');

    chrome.storage.local.set({ solver_api_key: key, solver_api_mode: mode }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error saving:', chrome.runtime.lastError);
        showStatus('❌ Failed to save settings', 'red');
        saveBtn.disabled = false;
        return;
      }

      showStatus('✅ Saved. Testing API key…');

      // Validate via getBalance
      fetch(`https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=getbalance&json=1`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(json => {
          if (json.status === 1) {
            showStatus(`✅ Valid key! Balance: $${json.request}`, 'green');
          } else {
            showStatus(`⚠️ Saved but validation failed: ${json.request}`, 'orange');
          }
        })
        .catch(err => {
          console.error('Error testing key:', err);
          showStatus(`❌ Error testing key: ${err.message}`, 'red');
        })
        .finally(() => {
          saveBtn.disabled = false;
        });
    });
  });

  // Reset handler
  resetBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to reset the scraper?")) {
      chrome.runtime.sendMessage({ action: "resetScraper" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error("Error resetting scraper:", chrome.runtime.lastError);
          showStatus("❌ Failed to reset scraper", "red");
        } else {
          console.log("Scraper reset triggered:", resp);
          showStatus("♻️ Scraper reset", "green");
        }
      });
    }
  });

  // Reload Extension handler
  if (updateBtn) {
    updateBtn.addEventListener('click', () => {
      if (confirm("Reload the extension now?")) {
        showStatus("🔄 Reloading extension…", "blue");
        chrome.runtime.reload();
      }
    });
  }

  // Toggle On/Off handler (using promisified storage)
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      try {
        const { extension_enabled } = await storageGet('extension_enabled');
        const current = extension_enabled !== false; // default ON if undefined
        const newState = !current;
        await storageSet({ extension_enabled: newState });
        updateToggleUI(newState);
        showStatus(newState ? "✅ Extension ON" : "⏻ Extension OFF", newState ? "green" : "red");
      } catch (err) {
        console.error("Toggle error:", err);
        showStatus("❌ Failed to toggle ON/OFF", "red");
      }
    });
  }

  function updateToggleUI(state) {
    if (toggleBtn) {
      toggleBtn.textContent = state ? "⏻ Turn OFF" : "⏻ Turn ON";
    }
  }

  function showStatus(msg, color) {
    statusEl.textContent = msg;
    statusEl.style.color = color || '';
    statusEl.style.opacity = '1';
    // Fade out after 5 seconds
    setTimeout(() => {
      statusEl.style.opacity = '0';
    }, 5000);
  }

  function clearStatus() {
    statusEl.textContent = '';
    statusEl.style.opacity = '1';
  }
});
