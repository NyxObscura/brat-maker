// src/imageGeneratorBackup.js

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANVAS_SIZE = 500;
const SCALE = 2;

// ── Font Registration ────────────────────────────────────────────────────────
// Register Apple Color Emoji (taruh di src/fonts/AppleColorEmoji.ttf)
// Download: https://github.com/nicowillis/apple-color-emoji/raw/main/AppleColorEmoji.ttf
// Fallback: Noto Color Emoji (sudah ada di Ubuntu)
const APPLE_EMOJI_PATH = join(__dirname, 'fonts', 'AppleColorEmoji.ttf');
const NOTO_EMOJI_PATH  = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf';

let emojiFont = 'Noto Color Emoji';

if (existsSync(APPLE_EMOJI_PATH)) {
  GlobalFonts.registerFromPath(APPLE_EMOJI_PATH, 'Apple Color Emoji');
  emojiFont = 'Apple Color Emoji';
  console.log('[font] Using Apple Color Emoji');
} else if (existsSync(NOTO_EMOJI_PATH)) {
  GlobalFonts.registerFromPath(NOTO_EMOJI_PATH, 'Noto Color Emoji');
  emojiFont = 'Noto Color Emoji';
  console.log('[font] Using Noto Color Emoji (fallback)');
} else {
  console.warn('[font] No emoji font found. Emoji may not render.');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeColor(color, fallback) {
  if (!color) return fallback;
  const hex = color.startsWith('#') ? color : `#${color}`;
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex) ? hex : fallback;
}

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  // Izinkan emoji (semua unicode), strip hanya control chars
  return text.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 200);
}

// Deteksi apakah string mengandung emoji
const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;

function hasEmoji(str) {
  return EMOJI_REGEX.test(str);
}

/**
 * Ukur lebar string dengan memperhitungkan emoji.
 * napi-rs/canvas dengan font stack "Arial, EmojiFont" sudah handle ini,
 * tapi kita perlu pastikan ctx.font sudah diset dengan fallback emoji.
 */
function measureWidth(ctx, str) {
  return ctx.measureText(str).width;
}

/**
 * Word-wrap dengan force-break untuk kata yang lebih lebar dari maxWidth.
 * Iterasi per Unicode grapheme cluster (handle emoji multi-codepoint).
 */
function wrapWords(ctx, words, maxWidth) {
  const lines = [];
  let current = '';

  for (const word of words) {
    if (measureWidth(ctx, word) > maxWidth) {
      if (current) { lines.push(current); current = ''; }

      // Pecah per grapheme cluster (handle emoji seperti 👨‍👩‍👧‍👦)
      const clusters = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(word)]
        .map(s => s.segment);

      let chunk = '';
      for (const cluster of clusters) {
        const test = chunk + cluster;
        if (measureWidth(ctx, test) <= maxWidth) {
          chunk = test;
        } else {
          if (chunk) lines.push(chunk);
          chunk = cluster;
        }
      }
      if (chunk) { current = chunk; }
      continue;
    }

    const test = current ? `${current} ${word}` : word;
    if (measureWidth(ctx, test) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fitLayout(ctx, words, availW, availH) {
  const MAX_FONT = 200 * SCALE;
  const MIN_FONT =  20 * SCALE;
  const COL_GAP  =  25 * SCALE;

  for (let fs = MAX_FONT; fs >= MIN_FONT; fs -= 2) {
    setFont(ctx, fs);
    const lh = Math.round(fs * 1.20);

    // 1 kolom
    const lines1  = wrapWords(ctx, words, availW);
    const totalH1 = lines1.length * lh;
    if (totalH1 <= availH) {
      return {
        fontSize: fs,
        lineHeight: lh,
        renderLines: lines1.map((line, i) => ({ x: 0, y: i * lh, text: line })),
      };
    }

    // 2 kolom
    const colW      = Math.floor((availW - COL_GAP) / 2);
    const maxPerCol = Math.floor(availH / lh);

    let splitIdx = words.length;
    for (let i = 1; i <= words.length; i++) {
      const left = wrapWords(ctx, words.slice(0, i), colW);
      if (left.length > maxPerCol) { splitIdx = i - 1; break; }
      splitIdx = i;
    }

    const leftLines  = wrapWords(ctx, words.slice(0, splitIdx), colW);
    const rightLines = wrapWords(ctx, words.slice(splitIdx),    colW);
    const totalH2    = Math.max(leftLines.length, rightLines.length) * lh;

    if (totalH2 <= availH) {
      return {
        fontSize: fs,
        lineHeight: lh,
        renderLines: [
          ...leftLines.map((line, i)  => ({ x: 0,              y: i * lh, text: line })),
          ...rightLines.map((line, i) => ({ x: colW + COL_GAP, y: i * lh, text: line })),
        ],
      };
    }
  }

  setFont(ctx, MIN_FONT);
  const lh    = Math.round(MIN_FONT * 1.20);
  const lines = wrapWords(ctx, words, availW);
  return {
    fontSize: MIN_FONT,
    lineHeight: lh,
    renderLines: lines.map((line, i) => ({ x: 0, y: i * lh, text: line })),
  };
}

/**
 * Set font dengan fallback emoji.
 * Font stack: teks pakai Arial, emoji pakai Apple/Noto Color Emoji.
 * napi-rs/canvas memilih font per-glyph secara otomatis dari stack ini.
 */
function setFont(ctx, fontSize) {
  ctx.font = `${fontSize}px Arial, "${emojiFont}", sans-serif`;
}

// ── Main Export ──────────────────────────────────────────────────────────────

export async function generateBratImage({ text, bg, color }) {
  const safeText = sanitizeText(text);
  if (!safeText) throw new Error('Parameter "text" wajib diisi dan tidak boleh kosong.');

  const bgColor   = sanitizeColor(bg,    '#ffffff');
  const textColor = sanitizeColor(color, '#000000');

  const W = CANVAS_SIZE * SCALE;
  const H = CANVAS_SIZE * SCALE;

  const pad    = 35 * SCALE;
  const availW = W - pad * 2;
  const availH = H - pad * 2;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, W, H);

  const words  = safeText.split(/\s+/).filter(Boolean);

  // Probe ctx untuk fitLayout (setFont dipanggil di dalam)
  setFont(ctx, 200 * SCALE);
  const layout = fitLayout(ctx, words, availW, availH);

  // Render teks ke offscreen canvas
  const textCanvas = createCanvas(W, H);
  const tCtx       = textCanvas.getContext('2d');
  tCtx.fillStyle    = textColor;
  tCtx.textAlign    = 'left';
  tCtx.textBaseline = 'top';
  setFont(tCtx, layout.fontSize);

  for (const { x, y, text: line } of layout.renderLines) {
    tCtx.fillText(line, pad + x, pad + y);
  }

  // Blur brat style (6px di 2x = 3px efektif)
  ctx.filter = `blur(6px)`;
  ctx.drawImage(textCanvas, 0, 0);
  ctx.filter = 'none';

  // Downscale ke 500x500
  const out    = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const outCtx = out.getContext('2d');
  outCtx.drawImage(canvas, 0, 0, W, H, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  return out.encode('png');
}
