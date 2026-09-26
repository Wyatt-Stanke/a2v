export const WIDTH = 1920;
export const HEIGHT = 1080;

const BG = '#ffffff';
const INK = '#111418';
const MUTED = '#5b6470';
const ACCENT = '#9cc9ee';
const FONT = 'Roboto, "Helvetica Neue", Arial, sans-serif';

export const loadFonts = () =>
  Promise.all([
    document.fonts.load(`700 120px Roboto`),
    document.fonts.load(`400 56px Roboto`),
  ]).catch(() => {});

const wrap = (ctx, text, maxWidth) => {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
};

// Shrinks the font until the text fits within maxLines.
const fit = (ctx, text, weight, size, minSize, maxWidth, maxLines) => {
  let lines;
  for (; size >= minSize; size -= 4) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    lines = wrap(ctx, text, maxWidth);
    if (lines.length <= maxLines) break;
  }
  return { size: Math.max(size, minSize), lines };
};

/** Draws the title card onto a canvas whose drawing buffer is WIDTH x HEIGHT. */
export const drawCard = (canvas, title, subtitle) => {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Accent stripe: a thin line near the bottom edge.
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, HEIGHT - 132, WIDTH, 4);

  const maxWidth = WIDTH - 320;
  const t = fit(ctx, title.trim() || 'Untitled', 700, 128, 56, maxWidth, 3);
  const s = subtitle.trim() ? fit(ctx, subtitle.trim(), 400, 56, 32, maxWidth, 2) : null;

  const tLine = t.size * 1.12;
  const sLine = s ? s.size * 1.3 : 0;
  const gap = s ? 72 : 0;
  const blockH = t.lines.length * tLine + (s ? gap + s.lines.length * sLine : 0);
  let y = (HEIGHT - 60 - blockH) / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = INK;
  ctx.font = `700 ${t.size}px ${FONT}`;
  for (const l of t.lines) {
    ctx.fillText(l, WIDTH / 2, y);
    y += tLine;
  }

  if (s) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(WIDTH / 2 - 48, y + gap / 2 - 2, 96, 4);
    y += gap;
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${s.size}px ${FONT}`;
    for (const l of s.lines) {
      ctx.fillText(l, WIDTH / 2, y);
      y += sLine;
    }
  }
};
