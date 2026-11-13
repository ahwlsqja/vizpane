// Pure logic of the inline mod (register.tsx). Plain ESM with no imports so that node:test can load it.

const OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`\n]*$/;

// Complete ```mermaid fences of a reply, in order: { source, start, end } with offsets of the
// whole fence (opening line to closing line, no trailing newline). A fence of another language
// is skipped as a whole, so a mermaid fence quoted inside it does not count, and a fence that is
// not closed yet (a reply still streaming) is ignored.
export function mermaidBlocks(text) {
  const blocks = [];
  if (typeof text !== 'string') return blocks;
  const lines = text.split('\n');
  let offset = 0;
  let open = null;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const lineStart = offset;
    offset += raw.length + 1;
    if (open === null) {
      const m = OPEN.exec(line);
      if (m) open = { char: m[2][0], size: m[2].length, mermaid: m[3].toLowerCase() === 'mermaid', start: lineStart, bodyStart: offset };
      continue;
    }
    const close = new RegExp(`^[ \\t]*\\${open.char}{${open.size},}[ \\t]*$`).test(line);
    if (!close) continue;
    if (open.mermaid) {
      const body = text.slice(open.bodyStart, Math.max(open.bodyStart, lineStart - 1));
      blocks.push({ source: body.replace(/\r$/gm, ''), start: open.start, end: lineStart + raw.length });
    }
    open = null;
  }
  return blocks;
}

// Replaces each block whose flag is true by a one-line marker; the others stay as code.
export function foldBlocks(text, okFlags, label) {
  const blocks = mermaidBlocks(text);
  let out = '';
  let at = 0;
  blocks.forEach((block, i) => {
    if (okFlags[i] !== true) return;
    out += text.slice(at, block.start) + `▸ ${label} ${i + 1}`;
    at = block.end;
  });
  return out + text.slice(at);
}

export const LEGIBLE_SCALE = 0.6;
export const MAX_COLUMNS = 120;
export const MAX_ROWS = 30;
const KITTY_MAX = 255;

// Cell box for a picture. The terminal stretches the picture to fill the box, so the box has to
// carry the picture's aspect ratio. A picture that the row cap would shrink below LEGIBLE_SCALE
// gets the terminal's height (less 6 rows for the prompt) instead.
// width and height are css px; cell is { width: points per cell, aspect: height / width }.
// The layout arithmetic follows natsukium/claude-code-figures-plugin (Apache-2.0),
// hooks/layout.ts, https://github.com/natsukium/claude-code-figures-plugin
export function fitCells(width, height, viewport, cell) {
  const ratio = height / width / cell.aspect;
  const widest = Math.min(MAX_COLUMNS, Math.max(1, viewport.columns - 4));
  const place = (maxRows) => {
    let columns = Math.min(widest, Math.ceil(width / cell.width));
    let rows = Math.round(columns * ratio);
    if (rows > maxRows) {
      rows = maxRows;
      columns = Math.round(rows / ratio);
    }
    columns = Math.max(1, Math.min(KITTY_MAX, columns));
    rows = Math.max(1, Math.min(KITTY_MAX, rows));
    return { columns, rows, scale: Math.min(1, (columns * cell.width) / width) };
  };
  const capped = place(MAX_ROWS);
  const tallest = Math.min(KITTY_MAX, viewport.rows - 6);
  return capped.scale >= LEGIBLE_SCALE || tallest <= MAX_ROWS ? capped : place(tallest);
}

// Two FNV-1a passes with different seeds: a cache key, not a security boundary.
export function hashSource(text) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(a)}${hex(b)}-${text.length.toString(16)}`;
}
