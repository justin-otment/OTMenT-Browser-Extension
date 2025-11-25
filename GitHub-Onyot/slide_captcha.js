// captchaHelper.js (ES module, safe for Chrome extension)

const API_KEY = "a01559936e2950720a2c0126309a824e";

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function pollSolution(id) {
  while (true) {
    const r = await fetch("https://2captcha.com/res.php?" + new URLSearchParams({
      key: API_KEY,
      action: "get",
      id,
      json: 1
    }));
    const data = await r.json();
    if (data.status === 1) return data.request;
    console.log("[2Captcha] Waiting for solution...");
    await sleep(5000);
  }
}

export async function solveTurnstileCaptcha(sitekey, pageurl) {
  const params = new URLSearchParams({
    key: API_KEY,
    method: "turnstile",
    sitekey,
    pageurl,
    json: 1
  });

  const res = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json();
  if (data.status === 0) throw new Error("2Captcha error: " + data.request);

  const token = await pollSolution(data.request);
  console.log("[2Captcha] Turnstile token:", token);
  return token;
}

export async function injectTurnstileToken(tabId, token) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (token) => {
      const inp = document.querySelector('input[name="cf-turnstile-response"]');
      if (inp) inp.value = token;
    },
    args: [token]
  });
  console.log("[Turnstile] Token injected into page.");
}

export async function solveDataDomeCaptcha(pageurl) {
  const params = new URLSearchParams({
    key: API_KEY,
    method: "datadome",
    pageurl,
    json: 1
  });

  const res = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json();
  if (data.status === 0) throw new Error("2Captcha error: " + data.request);

  const solution = await pollSolution(data.request);
  console.log("[DataDome] Solution:", solution);
  return JSON.parse(solution);
}