import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mermaidBlocks, foldBlocks, fitCells, hashSource } from '../plugins/vizpane/claude/inline-core.mjs';

const CELL = { width: 8, aspect: 2 };
const FLOW = 'flowchart TB\n  A --> B';
const reply = (...parts) => parts.join('\n');

test('mermaidBlocks finds complete mermaid fences in order', () => {
  const text = reply('Intro', '```mermaid', FLOW, '```', 'Between', '~~~Mermaid', 'sequenceDiagram\n  A->>B: hi', '~~~', 'End');
  const blocks = mermaidBlocks(text);
  assert.deepEqual(blocks.map((b) => b.source), [FLOW, 'sequenceDiagram\n  A->>B: hi']);
  assert.equal(text.slice(blocks[0].start, blocks[0].end), '```mermaid\n' + FLOW + '\n```');
});

test('mermaidBlocks ignores an unclosed fence and other languages', () => {
  assert.deepEqual(mermaidBlocks(reply('```mermaid', FLOW)), []);
  assert.deepEqual(mermaidBlocks(reply('```js', 'const a = 1', '```')), []);
  assert.deepEqual(mermaidBlocks(reply('```mermaid-js', FLOW, '```')), []);
  assert.deepEqual(mermaidBlocks('the word mermaid in prose'), []);
  assert.deepEqual(mermaidBlocks(undefined), []);
});

test('a mermaid fence quoted inside another fence does not count', () => {
  const text = reply('````md', '```mermaid', FLOW, '```', '````', '```mermaid', 'stateDiagram-v2\n  A --> B', '```');
  assert.deepEqual(mermaidBlocks(text).map((b) => b.source), ['stateDiagram-v2\n  A --> B']);
});

test('an unclosed fence after a complete one keeps the complete one', () => {
  const text = reply('```mermaid', FLOW, '```', '```mermaid', 'flowchart LR');
  assert.equal(mermaidBlocks(text).length, 1);
});

test('foldBlocks folds only the rendered blocks, numbering by position', () => {
  const text = reply('A', '```mermaid', FLOW, '```', 'B', '```mermaid', 'flowchart LR\n  X --> Y', '```', 'C');
  assert.equal(foldBlocks(text, [true, false], 'diagram'), reply('A', '▸ diagram 1', 'B', '```mermaid', 'flowchart LR\n  X --> Y', '```', 'C'));
  assert.equal(foldBlocks(text, [false, true], '도식'), reply('A', '```mermaid', FLOW, '```', 'B', '▸ 도식 2', 'C'));
  assert.equal(foldBlocks(text, [false, false], 'diagram'), text);
  assert.equal(foldBlocks('no fence', [], 'diagram'), 'no fence');
});

test('fitCells: width in cells follows the picture, rows keep the aspect ratio', () => {
  const r = fitCells(400, 200, { columns: 100, rows: 40 }, CELL);
  assert.deepEqual({ columns: r.columns, rows: r.rows }, { columns: 50, rows: 13 });
  assert.equal(r.scale, 1);
});

test('fitCells: columns are capped by the viewport (less 4) and by 120', () => {
  assert.equal(fitCells(2000, 200, { columns: 60, rows: 40 }, CELL).columns, 56);
  assert.equal(fitCells(2000, 200, { columns: 300, rows: 40 }, CELL).columns, 120);
});

test('fitCells: rows are capped at 30 and columns follow when scale stays legible', () => {
  // 600 x 1200 px: 75 columns would need 75 * 2 / 2 = 75 rows; capped to 30, so 30 columns.
  const r = fitCells(600, 1200, { columns: 100, rows: 30 }, CELL);
  assert.equal(r.rows, 30);
  assert.equal(r.columns, 30);
  assert.equal(r.scale, 0.4);
});

test('fitCells: a picture shrunk under 0.6 grows to the viewport height less 6 rows', () => {
  const r = fitCells(600, 1200, { columns: 100, rows: 60 }, CELL);
  assert.equal(r.rows, 54);
  assert.equal(r.columns, 54);
  assert.ok(r.scale >= 0.6 && r.scale < 1);
});

test('fitCells: a short viewport does not raise the cap', () => {
  const r = fitCells(600, 1200, { columns: 100, rows: 36 }, CELL);
  assert.equal(r.rows, 30);
});

test('fitCells: results are clamped to 1..255', () => {
  const tiny = fitCells(1, 1, { columns: 100, rows: 40 }, { width: 1000, aspect: 1000 });
  assert.deepEqual({ columns: tiny.columns, rows: tiny.rows }, { columns: 1, rows: 1 });
  const huge = fitCells(100000, 50, { columns: 1000, rows: 1000 }, { width: 0.1, aspect: 1 });
  assert.ok(huge.columns <= 255 && huge.rows <= 255 && huge.rows >= 1);
  assert.ok(fitCells(100, 100000, { columns: 1000, rows: 1000 }, CELL).rows <= 255);
});

test('hashSource is stable, distinguishes sources and is file-name safe', () => {
  assert.equal(hashSource(FLOW), hashSource(FLOW));
  assert.notEqual(hashSource(FLOW), hashSource(FLOW + ' '));
  assert.notEqual(hashSource('ab'), hashSource('ba'));
  assert.match(hashSource(FLOW), /^[0-9a-f]{16}-[0-9a-f]+$/);
  assert.match(hashSource(''), /^[0-9a-f]{16}-0$/);
});
