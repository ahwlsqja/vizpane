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

// Splits a reply at each block whose flag is true, so that each picture can be drawn where its
// block was: [{ text }, { block: i }, { text }, ...] in reply order, with i the block's index in
// mermaidBlocks(). Blank lines next to a picture are dropped and an empty text part is left out.
// Blocks whose flag is not true stay inside the text, as code.
export function splitBlocks(text, okFlags) {
  const blocks = mermaidBlocks(text);
  const parts = [];
  let at = 0;
  const addText = (t) => {
    const trimmed = t.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
    if (trimmed.trim()) parts.push({ text: trimmed });
  };
  blocks.forEach((block, i) => {
    if (okFlags[i] !== true) return;
    addText(text.slice(at, block.start));
    parts.push({ block: i });
    at = block.end;
  });
  addText(text.slice(at));
  return parts;
}

export const LEGIBLE_SCALE = 0.8;
export const MAX_COLUMNS = 120;
export const MAX_ROWS = 30;
export const MAX_SCREENS = 2;
const KITTY_MAX = 255;

// Cell box for a picture. The terminal stretches the picture to fill the box, so the box has to
// carry the picture's aspect ratio. Small pictures keep their size within MAX_ROWS rows. A picture
// that the row cap would shrink below LEGIBLE_SCALE grows taller instead, as far as legibility
// needs and at most MAX_SCREENS terminal heights: the transcript scrolls, and text too small to
// read is worse than a tall picture. A picture wider than the terminal can only shrink; the
// Enlarge button opens it in the side pane.
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
  if (capped.scale >= LEGIBLE_SCALE) return capped;
  // As large as the width allows, then only as tall as LEGIBLE_SCALE needs.
  const byWidth = place(KITTY_MAX);
  const needed = Math.ceil(byWidth.rows * Math.min(1, LEGIBLE_SCALE / byWidth.scale));
  const limit = Math.min(KITTY_MAX, Math.max(MAX_ROWS, MAX_SCREENS * viewport.rows - 6));
  return place(Math.max(MAX_ROWS, Math.min(needed, limit)));
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
