// ===================================================
// === OTMenT v3 — content.js (Hybrid Extractor v5.1)
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
    return false; // soft fail instead of throwing
  }

  // ===================================================
  // === UNIVERSAL EXTRACTOR (supports parent scopes)
  // ===================================================
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

          // Normalize arrays & remove empties
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

  // ===================================================
  // === ENTRY POINT — Request config from background
  // ===================================================
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

    // ===================================================
    // === PAGE CLASSIFICATION (Enhanced Detection)
    // ===================================================
    let isDetail = false;
    let isResult = false;
    const path = location.pathname.toLowerCase();

    try {
      // --- Schema.org or unique detail markers
      const hasDetailNodes =
        document.querySelector("div[itemtype='https://schema.org/Person']") ||
        document.querySelector("h1");

      // --- Smart classification using selectors + URL hints
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

      // --- URL-based fallback (in case elements load late)
      if (!isDetail && path.includes("/name/")) isDetail = true;
      if (!isResult && path.includes("/address/")) isResult = true;

      console.log("[OTMenT] Page classification:", {
        isResult,
        isDetail,
        path,
      });
    } catch (err) {
      console.warn("[OTMenT] Selector classification error:", err.message);
    }


    // ===================================================
    // === SINGLE-SITEMAP MODE
    // ===================================================
    if (config.selectors?.length && !config.detailSelectors?.length) {
      console.log("[OTMenT] Single sitemap extraction flow");
      const firstSel = config.selectors?.[0]?.selector || "body";
      await waitForSelector(firstSel, 20000);
      await runExtractor(config.selectors, config);
      return;
    }

    // ===================================================
    // === RESULT PAGE EXTRACTION
    // ===================================================
    if (isResult) {
      console.log("[OTMenT] Result page detected (scoped extraction)");

      const resultParentSel = config.selectors.find((s) => s.id === "results");
      if (!resultParentSel) {
        console.warn("[OTMenT] No 'results' selector defined — fallback to full page");
        await runExtractor(config.selectors, config);
        return;
      }

      await waitForSelector(resultParentSel.selector, config.requestOptions?.pageLoadTimeoutMs || 20000);

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

    // ===================================================
    // === DETAIL PAGE EXTRACTION (Schema-calibrated)
    // ===================================================
    if (isDetail) {
      console.log("[OTMenT] Detail page detected (dynamic or fallback)");

      try {
        // --- Grab Person Tile or fallback
        const personTileSel =
          config.detailSelectors?.find((s) => s.id === "Person-Contact-Tile")
            ?.selector || "div.clearfix.psn-results-container";

        await waitForSelector(
          personTileSel,
          config.requestOptions?.pageLoadTimeoutMs || 20000
        ).catch(() =>
          console.warn("[OTMenT] Person-Contact-Tile selector not found — fallback to document")
        );

        // --- Get main container(s)
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

        // --- Extract each tile’s data
        $tiles.forEach(($tile) => {
          const FullnameSel = config.detailSelectors.find((s) => s.id === "Fullname")?.selector || "h1";
          const PhoneSel = config.detailSelectors.find(
            (s) => s.id === "Phone Number + Phone Type"
          )?.selector || "span[itemprop='telephone'], div:nth-of-type(6) a";

          const fullName =
            $tile.querySelector(FullnameSel)?.textContent.trim() || null;

          const phoneNodes = Array.from($tile.querySelectorAll(PhoneSel));
          const phoneList = phoneNodes
            .map((n) => n.textContent.trim())
            .filter(Boolean);

          extracted.push({
            Fullname: fullName,
            "Phone Number + Phone Type": phoneList,
          });
        });

        // --- Send results back to background or navigator
        console.log("[OTMenT] Detail extracted (from content.js):", extracted);

        chrome.runtime.sendMessage({
          action: "dataExtracted",
          data: extracted,
          page: location.href,
        });
      } catch (err) {
        console.error("[OTMenT] Detail extraction error:", err);
      }

      return;
    }


    // ===================================================
    // === UNKNOWN PAGE TYPE
    // ===================================================
    console.warn("[OTMenT] Unknown page type — sending empty payload");
    chrome.runtime.sendMessage({
      action: "dataExtracted",
      data: {},
      page: location.href,
    });
  });
})(jQuery);
