// ===================================================
// === OTMenT v3 — content.js (Hybrid Extractor + CAPTCHA v6.2)
// ===================================================
console.log("[OTMenT] Content script loaded (jQuery active)");

(function ($) {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  async function waitForSelector(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if ($(selector).length > 0) return true;
      await sleep(250);
    }
    console.warn("[OTMenT] Timeout waiting for selector:", selector);
    return false;
  }

  /* -------------------------------------------------------------
     Send CAPTCHA solve request to background (delegates to 2Captcha)
  ------------------------------------------------------------- */
  async function solveCaptcha(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "solveCaptcha", type, payload },
        (response) => {
          if (response && response.success) resolve(response.result);
          else resolve(null);
        }
      );
    });
  }

  /* -------------------------------------------------------------
     Detect Turnstile frame
  ------------------------------------------------------------- */
  async function detectTurnstile() {
    const frames = Array.from(document.querySelectorAll("iframe"));
    for (const f of frames) {
      if (f.src.includes("challenge-platform")) return f;
    }
    return null;
  }

  /* -------------------------------------------------------------
     Detect DataDome slider iframe
  ------------------------------------------------------------- */
  async function detectDataDome() {
    return document.querySelector('iframe[src*="captcha-delivery"]') || null;
  }

  /* -------------------------------------------------------------
     Inject Turnstile token into hidden input
  ------------------------------------------------------------- */
  async function injectTurnstileToken(frame, token) {
    try {
      const input = frame.contentWindow.document.querySelector(
        'input[name="cf-turnstile-response"]'
      );
      if (input) {
        input.value = token;
        console.log("[Turnstile] Token injected successfully.");
        return true;
      }
      console.warn("[Turnstile] Token injection failed.");
    } catch (err) {
      console.error("[Turnstile] Injection error:", err);
    }
    return false;
  }

  /* -------------------------------------------------------------
     Simulate DataDome slider drag
  ------------------------------------------------------------- */
  async function dragDataDomeSlider(iframe, distance) {
    try {
      const rect = iframe.getBoundingClientRect();
      const startX = rect.x + rect.width / 4;
      const startY = rect.y + rect.height / 2;
      const endX = startX + distance;

      window.scrollTo(0, startY - 100); // ensure iframe visible
      await sleep(500);

      function fire(type, x, y) {
        const evt = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        });
        iframe.dispatchEvent(evt);
      }

      fire("mousemove", startX, startY);
      fire("mousedown", startX, startY);
      for (let step = 0; step <= 20; step++) {
        const x = startX + ((endX - startX) * step) / 20;
        fire("mousemove", x, startY);
        await sleep(50);
      }
      fire("mouseup", endX, startY);

      console.log("[DataDome] Slider drag simulated.");
    } catch (err) {
      console.error("[DataDome] Drag simulation failed:", err);
    }
  }

  /* -------------------------------------------------------------
     Universal Extractor (unchanged core logic)
  ------------------------------------------------------------- */
  async function runExtractor(selectors, config, $scope = $("body")) {
    const extracted = {};
    try {
      for (const sel of selectors || []) {
        if (!sel.selector) continue;
        let value = null;

        try {
          if (sel.type === "SelectorText") {
            value = sel.multiple
              ? $scope.find(sel.selector).map((i, el) => $(el).text().trim()).get()
              : $scope.find(sel.selector).first().text().trim() || null;
          } else if (sel.type === "SelectorHTML") {
            value = sel.multiple
              ? $scope.find(sel.selector).map((i, el) => $(el).html()?.trim()).get()
              : $scope.find(sel.selector).first().html()?.trim() || null;
          } else if (sel.type === "SelectorElementAttribute" && sel.extractAttribute) {
            value = sel.multiple
              ? $scope.find(sel.selector).map((i, el) => $(el).attr(sel.extractAttribute)).get()
              : $scope.find(sel.selector).first().attr(sel.extractAttribute) || null;
          } else if (sel.type === "SelectorElement") {
            value = sel.multiple
              ? $scope.find(sel.selector).map((i, el) => $(el).html()).get()
              : $scope.find(sel.selector).first().html();
          }

          if (Array.isArray(value)) {
            value = value.filter((v) => v && v.trim() !== "");
            if (!value.length) value = null;
          }

          extracted[sel.id] = value;
        } catch (err) {
          console.warn(`[OTMenT] Selector extraction failed for ${sel.id}:`, err.message);
          extracted[sel.id] = null;
        }
      }

      console.table(extracted);
      chrome.runtime.sendMessage({
        action: "dataExtracted",
        data: extracted || {},
        page: location.href,
      });
      console.log("[OTMenT] Extraction complete, data sent to background.");
    } catch (err) {
      console.error("[OTMenT] Extraction error:", err);
      chrome.runtime.sendMessage({
        action: "dataError",
        error: err.message,
        page: location.href,
      });
    }
  }

  /* -------------------------------------------------------------
     MAIN ENTRY POINT
  ------------------------------------------------------------- */
  chrome.runtime.sendMessage({ action: "getConfig" }, async (config) => {
    if (!config) {
      console.error("[OTMenT] No config received from background.");
      chrome.runtime.sendMessage({
        action: "dataError",
        error: "No config received",
        page: location.href,
      });
      return;
    }

    // ---------------- CAPTCHA HANDLING ----------------
    console.log("[OTMenT] Checking for CAPTCHAs...");

    try {
      // Turnstile
      const turnstileFrame = await detectTurnstile();
      if (turnstileFrame) {
        console.log("[Turnstile] Frame detected:", turnstileFrame.src);
        const sitekey =
          turnstileFrame.getAttribute("data-sitekey") ||
          (turnstileFrame.src.match(/0x[a-zA-Z0-9]+/) || [])[0];
        if (sitekey) {
          const token = await solveCaptcha("turnstile", { sitekey, pageurl: location.href });
          if (token) await injectTurnstileToken(turnstileFrame, token);
        }
      }

      const ddFrame = await detectDataDome();
      if (ddFrame) {
        console.log("[DataDome] Slider iframe detected.");
        const src = ddFrame.getAttribute("src") || "";

        // Extract captcha_id from either captchaId or cid
        let captcha_id = null;
        const matchCaptchaId = src.match(/captchaId=([a-z0-9-]+)/i);
        const matchCid = src.match(/cid=([a-zA-Z0-9~_-]+)/i);

        if (matchCaptchaId) captcha_id = matchCaptchaId[1];
        else if (matchCid) captcha_id = matchCid[1];

        if (!captcha_id) {
          console.warn("[DataDome] No captcha_id/cid found in iframe src:", src);
          chrome.runtime.sendMessage({
            action: "dataError",
            error: "DataDome iframe detected but captcha_id missing",
            page: location.href,
          });
        } else {
          console.log("[DataDome] Extracted captcha_id:", captcha_id);
          const solution = await solveCaptcha("datadome", {
            pageurl: location.href,
            captcha_id,
          });

          if (solution?.move_slider) {
            await dragDataDomeSlider(ddFrame, solution.move_slider.distance);
          } else {
            console.warn("[DataDome] No slider solution returned from 2Captcha.");
          }
        }
      }
    } catch (err) {
      console.error("[OTMenT] CAPTCHA handling failed:", err);
    }

    // ---------------- PAGE TITLE CHECK ----------------
    const titleText = document.title.trim();
    if (/attention|just a moment/i.test(titleText)) {
      console.warn("[OTMenT] Challenge page detected ('" + titleText + "') — pausing extraction.");
      chrome.runtime.sendMessage({
        action: "dataError",
        error: "Challenge page detected (" + titleText + ")",
        page: location.href,
      });
      return;
    }

    // ---------------- PAGE CLASSIFICATION ----------------
    let isDetail = false;
    let isResult = false;
    const path = location.pathname.toLowerCase();

    try {
      const hasDetailNodes =
        document.querySelector("div[itemtype='https://schema.org/Person']") ||
        document.querySelector("h1");

      isDetail =
        (config.detailSelectors?.some(
          (sel) => sel.selector && document.querySelector(sel.selector)
        ) ||
          hasDetailNodes) &&
        path.includes("/name/");

      isResult =
        config.selectors?.some(
          (sel) => sel.selector && document.querySelector(sel.selector)
        ) && path.includes("/address/");

      if (!isDetail && path.includes("/name/")) isDetail = true;
      if (!isResult && path.includes("/address/")) isResult = true;

      console.log("[OTMenT] Page classification:", { isResult, isDetail, path });
    } catch (err) {
      console.warn("[OTMenT] Selector classification error:", err.message);
    }

    // ---------------- SINGLE-SITEMAP MODE ----------------
        // ---------------- SINGLE-SITEMAP MODE ----------------
        if (config.selectors?.length && !config.detailSelectors?.length) {
          console.log("[OTMenT] Single sitemap extraction flow");
          const firstSel = config.selectors?.[0]?.selector || "body";
          await waitForSelector(firstSel, 20000);
          await runExtractor(config.selectors, config);
          return;
        }
    
        // ---------------- RESULT PAGE EXTRACTION ----------------
        if (isResult) {
          console.log("[OTMenT] Result page detected (scoped extraction)");
    
          const resultParentSel = config.selectors.find((s) => s.id === "results");
          if (!resultParentSel) {
            console.warn("[OTMenT] No 'results' selector defined — fallback to full page");
            await runExtractor(config.selectors, config);
            return;
          }
    
          await waitForSelector(
            resultParentSel.selector,
            config.requestOptions?.pageLoadTimeoutMs || 20000
          );
    
          const $results = $(resultParentSel.selector);
          const Names = [];
          const Hrefs = [];
    
          $results.each((i, el) => {
            const $el = $(el);
            const nameSel = config.selectors.find((s) => s.id === "Names");
            const hrefSel = config.selectors.find((s) => s.id === "Hrefs");
    
            const name = nameSel ? $el.find(nameSel.selector).first().text().trim() || null : null;
            const href = hrefSel ? $el.find(hrefSel.selector).first().attr(hrefSel.extractAttribute) || null : null;
    
            Names.push(name);
            Hrefs.push(href);
          });
    
          chrome.runtime.sendMessage({
            action: "dataExtracted",
            data: { Names, Hrefs },
            page: location.href,
          });
          console.log("[OTMenT] Result page extraction complete");
          return;
        }
    
        // ---------------- DETAIL PAGE EXTRACTION ----------------
        if (isDetail) {
          console.log("[OTMenT] Detail page detected (dynamic or fallback)");
    
          try {
            const personTileSel =
              config.detailSelectors?.find((s) => s.id === "Person-Contact-Tile")?.selector ||
              "div.clearfix.psn-results-container";
    
            await waitForSelector(
              personTileSel,
              config.requestOptions?.pageLoadTimeoutMs || 20000
            ).catch(() =>
              console.warn("[OTMenT] Person-Contact-Tile selector not found — fallback to document")
            );
    
            const $tiles = document.querySelectorAll(personTileSel);
            if (!$tiles.length) {
              console.warn("[OTMenT] ❌ No person tiles found on detail page");
              chrome.runtime.sendMessage({
                action: "dataExtracted",
                data: [],
                page: location.href,
              });
              return;
            }
    
            const extracted = [];
            $tiles.forEach(($tile) => {
              const FullnameSel =
                config.detailSelectors.find((s) => s.id === "Fullname")?.selector || "h1";
              const PhoneSel =
                config.detailSelectors.find((s) => s.id === "Phone Number + Phone Type")?.selector ||
                "span[itemprop='telephone'], div:nth-of-type(6) a";
    
              const fullName = $tile.querySelector(FullnameSel)?.textContent.trim() || null;
              const phoneNodes = Array.from($tile.querySelectorAll(PhoneSel));
              const phoneList = phoneNodes.map((n) => n.textContent.trim()).filter(Boolean);
    
              extracted.push({ Fullname: fullName, "Phone Number + Phone Type": phoneList });
            });
    
            console.log("[OTMenT] Detail extracted (from content.js):", extracted);
            chrome.runtime.sendMessage({
              action: "dataExtracted",
              data: extracted,
              page: location.href,
            });
          } catch (err) {
            console.error("[OTMenT] Detail extraction error:", err);
            chrome.runtime.sendMessage({
              action: "dataError",
              error: err.message,
              page: location.href,
            });
          }
    
          return;
        }
    
        // ---------------- UNKNOWN PAGE TYPE ----------------
        console.warn("[OTMenT] Unknown page type — sending empty payload");
        chrome.runtime.sendMessage({
          action: "dataExtracted",
          data: {},
          page: location.href,
        });
      });
    })(jQuery);