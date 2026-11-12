// Fence info string must be exactly "mermaid" (case-insensitive); prose mentions do not count.
const FENCE = /^ *(?:`{3,}|~{3,}) *mermaid *$/im;

export function hasMermaid(md) {
  return typeof md === 'string' && FENCE.test(md);
}

const MAX_TITLE = 60;
const NO_TITLE = '(제목 없음)';

export function titleOf(md) {
  if (typeof md !== 'string') return NO_TITLE;
  let inFence = false;
  let firstLine = null;
  for (const line of md.split(/\r?\n/)) {
    if (/^ *(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h && h[1]) return h[1].slice(0, MAX_TITLE);
    if (firstLine === null && line.trim()) firstLine = line.trim();
  }
  if (firstLine === null) return NO_TITLE;
  return firstLine.replace(/[*_`]/g, '').slice(0, MAX_TITLE) || NO_TITLE;
}
