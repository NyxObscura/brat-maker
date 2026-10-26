import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANVAS_SIZE = 500;
const SCALE       = 2;

// ── Font Registration ─────────────────────────────────────────────────────────
// Karena imageGenerator.js diimpor oleh setiap worker thread secara independen,
// GlobalFonts.registerFromPath() dipanggil di setiap worker — ini normal.
const APPLE_EMOJI_PATH = join(__dirname, 'fonts', 'AppleColorEmoji.ttf');
const NOTO_EMOJI_PATH  = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf';

let emojiFont = 'sans-serif'; // Ultimate fallback

if (existsSync(APPLE_EMOJI_PATH)) {
  GlobalFonts.registerFromPath(APPLE_EMOJI_PATH, 'Apple Color Emoji');
  emojiFont = 'Apple Color Emoji';
  console.log(`[font:${process.pid}] Using Apple Color Emoji`);
} else if (existsSync(NOTO_EMOJI_PATH)) {
  GlobalFonts.registerFromPath(NOTO_EMOJI_PATH, 'Noto Color Emoji');
  emojiFont = 'Noto Color Emoji';
  console.log(`[font:${process.pid}] Using Noto Color Emoji (fallback)`);
} else {
  console.warn(`[font:${process.pid}] No emoji font found. Emoji may not render correctly.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeColor(color, fallback) {
  if (!color) return fallback;
  const hex = color.startsWith('#') ? color : `#${color}`;
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex) ? hex : fallback;
}

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 200);
}

function measureWidth(ctx, str) {
  return ctx.measureText(str).width;
}

/**
 * Word-wrap dengan force-break untuk kata terlalu lebar.
 * Menggunakan Intl.Segmenter untuk handle emoji multi-codepoint (👨‍👩‍👧‍👦 dll).
 */
function wrapWords(ctx, words, maxWidth) {
  const lines     = [];
  let   current   = '';
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

  for (const word of words) {
    if (measureWidth(ctx, word) > maxWidth) {
      if (current) { lines.push(current); current = ''; }

      const clusters = [...segmenter.segment(word)].map(s => s.segment);
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
      if (chunk) current = chunk;
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

function setFont(ctx, fontSize) {
  ctx.font = `${fontSize}px Arial, "${emojiFont}", sans-serif`;
}

/**
 * Cari ukuran font terbesar yang muat dalam canvas (1 kolom atau 2 kolom).
 * Iterasi dari font max ke min dengan step 2px.
 */
function fitLayout(ctx, words, availW, availH) {
  const MAX_FONT = 200 * SCALE;
  const MIN_FONT =  20 * SCALE;
  const COL_GAP  =  25 * SCALE;

  for (let fs = MAX_FONT; fs >= MIN_FONT; fs -= 2) {
    setFont(ctx, fs);
    const lh = Math.round(fs * 1.20);

    // Cek apakah ada kata yang kepanjangan di ukuran font ini (mencegah kata terpotong)
    const canFit1Col = !words.some(w => measureWidth(ctx, w) > availW);

    // Coba 1 kolom (Hanya jika kata tidak ada yang terpotong)
    if (canFit1Col) {
      const lines1 = wrapWords(ctx, words, availW);
      if (lines1.length * lh <= availH) {
        return {
          fontSize:    fs,
          lineHeight:  lh,
          renderLines: lines1.map((line, i) => ({ x: 0, y: i * lh, text: line })),
        };
      }
    }

    // Coba 2 kolom
    const colW = Math.floor((availW - COL_GAP) / 2);
    // Cek apakah ada kata yang kepanjangan untuk lebar 1 kolom (mencegah kata terpotong vertikal)
    const canFit2Col = !words.some(w => measureWidth(ctx, w) > colW);

    if (canFit2Col) {
      const maxPerCol = Math.floor(availH / lh);

      let splitIdx = words.length;
      for (let i = 1; i <= words.length; i++) {
        const left = wrapWords(ctx, words.slice(0, i), colW);
        if (left.length > maxPerCol) { splitIdx = i - 1; break; }
        splitIdx = i;
      }

      const leftLines  = wrapWords(ctx, words.slice(0, splitIdx), colW);
      const rightLines = wrapWords(ctx, words.slice(splitIdx),    colW);

      if (Math.max(leftLines.length, rightLines.length) * lh <= availH) {
        return {
          fontSize:    fs,
          lineHeight:  lh,
          renderLines: [
            ...leftLines.map((line, i)  => ({ x: 0,              y: i * lh, text: line })),
            ...rightLines.map((line, i) => ({ x: colW + COL_GAP, y: i * lh, text: line })),
          ],
        };
      }
    }
  }

  // Fallback minimum
  setFont(ctx, MIN_FONT);
  const lh    = Math.round(MIN_FONT * 1.20);
  const lines = wrapWords(ctx, words, availW);
  return {
    fontSize:    MIN_FONT,
    lineHeight:  lh,
    renderLines: lines.map((line, i) => ({ x: 0, y: i * lh, text: line })),
  };
}

// ── Main Export ───────────────────────────────────────────────────────────────

export async function generateBratImage({ text, bg, color }) {
  const safeText = sanitizeText(text);
  if (!safeText) throw new Error('Parameter "text" wajib diisi dan tidak boleh kosong.');

  const bgColor   = sanitizeColor(bg,    '#ffffff');
  const textColor = sanitizeColor(color, '#000000');

  const W      = CANVAS_SIZE * SCALE;
  const H      = CANVAS_SIZE * SCALE;
  const pad    = 35 * SCALE;
  const availW = W - pad * 2;
  const availH = H - pad * 2;

  // Canvas utama (background)
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, W, H);

  const words = safeText.split(/\s+/).filter(Boolean);
  setFont(ctx, 200 * SCALE); // Probe awal untuk fitLayout
  const layout = fitLayout(ctx, words, availW, availH);

  // Canvas offscreen untuk render teks (sebelum blur)
  const textCanvas = createCanvas(W, H);
  const tCtx       = textCanvas.getContext('2d');
  tCtx.fillStyle    = textColor;
  tCtx.textAlign    = 'left';
  tCtx.textBaseline = 'top';
  setFont(tCtx, layout.fontSize);

  // ── LOGIKA BARU: JUSTIFY TEXT (RATA KANAN-KIRI) ──

  // 1. Cari lebar target (maksimal) untuk setiap kolom (berdasarkan posisi x)
  const colMaxWidths = {};
  for (const { x, text: line } of layout.renderLines) {
    const w = tCtx.measureText(line).width;
    if (!colMaxWidths[x] || w > colMaxWidths[x]) {
      colMaxWidths[x] = w;
    }
  }

  // 2. Render tiap baris dengan memanipulasi spasi
  for (const { x, y, text: line } of layout.renderLines) {
    const lineWords = line.split(' ');
    const targetW = colMaxWidths[x];

    if (lineWords.length === 1) {
      // Jika baris cuma berisi 1 kata, render biasa (rata kiri kolom)
      tCtx.fillText(line, pad + x, pad + y);
    } else {
      // Hitung total lebar murni dari teks (tanpa spasi)
      let totalWordsWidth = 0;
      const wordWidths = lineWords.map(w => {
        const wLen = tCtx.measureText(w).width;
        totalWordsWidth += wLen;
        return wLen;
      });

      // Sisa ruang kosong didistribusikan merata ke celah (spasi) antar kata
      const totalGapSpace = targetW - totalWordsWidth;
      const spacePerGap = totalGapSpace / (lineWords.length - 1);

      let currentX = pad + x;
      for (let i = 0; i < lineWords.length; i++) {
        tCtx.fillText(lineWords[i], currentX, pad + y);
        currentX += wordWidths[i] + spacePerGap;
      }
    }
  }

  // Brat-style blur: 6px di 2× scale = 3px efektif di output 500×500
  ctx.filter = 'blur(6px)';
  ctx.drawImage(textCanvas, 0, 0);
  ctx.filter = 'none';

  // Downscale ke output final 500×500
  const out    = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const outCtx = out.getContext('2d');
  outCtx.drawImage(canvas, 0, 0, W, H, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  return out.encode('png');
}
