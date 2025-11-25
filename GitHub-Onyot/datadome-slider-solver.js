// datadome-slider-solver.js
// Anti-Datadome Slider Challenge (Prototype)
// Strategy A — Network-Assisted Template Extraction + Edge-Detect + Auto-Drag

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ============================================================================
// Utility: sleep
// ============================================================================
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ============================================================================
// Capture slider images from DOM
// ============================================================================
async function captureSliderImages(page) {
  await page.waitForSelector('img.dd-sl-bg');
  await page.waitForSelector('img.dd-sl-piece');

  const bgEl = await page.$('img.dd-sl-bg');
  const pieceEl = await page.$('img.dd-sl-piece');

  const bgBuffer = await bgEl.screenshot({ encoding: 'binary' });
  const pieceBuffer = await pieceEl.screenshot({ encoding: 'binary' });

  return { bgBuffer, pieceBuffer };
}

// ============================================================================
// Compute slider offset via image processing
// ============================================================================
async function computeOffset(bgBuffer, pieceBuffer) {
  const bg = sharp(bgBuffer).grayscale();
  const piece = sharp(pieceBuffer).grayscale();

  const bgMeta = await bg.metadata();
  const pieceMeta = await piece.metadata();

  const bgRaw = await bg.raw().toBuffer();
  const pieceRaw = await piece.raw().toBuffer();

  let bestX = 0;
  let bestScore = Infinity;

  for (let x = 0; x < bgMeta.width - pieceMeta.width; x++) {
    let score = 0;
    for (let y = 0; y < pieceMeta.height; y++) {
      for (let px = 0; px < pieceMeta.width; px++) {
        const bgIndex = (y * bgMeta.width + (x + px));
        const pieceIndex = (y * pieceMeta.width + px);
        const diff = bgRaw[bgIndex] - pieceRaw[pieceIndex];
        score += diff * diff;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      bestX = x;
    }
  }

  return bestX;
}

// ============================================================================
// Smooth human-like drag
// ============================================================================
async function humanLikeDrag(page, sliderSelector, targetX) {
  const slider = await page.$(sliderSelector);
  const box = await slider.boundingBox();

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();

  const steps = 25 + Math.floor(Math.random() * 20);
  let progress = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / steps;
    const ease = t * t * (3 - 2 * t);
    const x = startX + ease * targetX;
    const y = startY + Math.sin(i / 3) * 1.2;
    await page.mouse.move(x, y, { steps: 2 });
    await sleep(8 + Math.random() * 10);
  }

  await page.mouse.up();
  await sleep(1500);
}

// ============================================================================
// Main: solveDatadomeSlider
// ============================================================================
async function solveDatadomeSlider(page) {
  try {
    console.log('[DD] Slider challenge detected — starting break attempt...');

    const { bgBuffer, pieceBuffer } = await captureSliderImages(page);

    const offset = await computeOffset(bgBuffer, pieceBuffer);
    console.log('[DD] Computed slider offset:', offset);

    await humanLikeDrag(page, '.dd-sl-slider', offset);

    const success = await page.$('.dd-sl-success');
    if (success) {
      console.log('[DD] Slider solved successfully.');
      return true;
    }

    console.log('[DD] Slider solve failed — Datadome may require a retry.');
    return false;

  } catch (err) {
    console.error('[DD] Error solving slider:', err);
    return false;
  }
}

module.exports = {
  solveDatadomeSlider
};
