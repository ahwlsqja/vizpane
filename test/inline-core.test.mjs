import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mermaidBlocks, splitBlocks, fitCells, hashSource } from '../plugins/vizpane/claude/inline-core.mjs';

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

test('splitBlocks puts each drawn block between the text around it, numbering by position', () => {
  const text = reply('A', '', '```mermaid', FLOW, '```', '', 'B', '```mermaid', 'flowchart LR\n  X --> Y', '```', 'C');
  assert.deepEqual(splitBlocks(text, [true, true]), [{ text: 'A' }, { block: 0 }, { text: 'B' }, { block: 1 }, { text: 'C' }]);
  // A block that was not drawn stays in the text as code.
  assert.deepEqual(splitBlocks(text, [true, false]), [{ text: 'A' }, { block: 0 }, { text: reply('B', '```mermaid', 'flowchart LR\n  X --> Y', '```', 'C') }]);
  assert.deepEqual(splitBlocks(text, [false, false]), [{ text }]);
  assert.deepEqual(splitBlocks('no fence', []), [{ text: 'no fence' }]);
});

test('splitBlocks leaves out empty text around a block at the start or the end, and keeps indentation', () => {
  assert.deepEqual(splitBlocks(reply('```mermaid', FLOW, '```'), [true]), [{ block: 0 }]);
  assert.deepEqual(splitBlocks(reply('```mermaid', FLOW, '```', '', '  - item'), [true]), [{ block: 0 }, { text: '  - item' }]);
  assert.deepEqual(splitBlocks(reply('intro', '```mermaid', FLOW, '```', '```mermaid', FLOW, '```'), [true, true]), [{ text: 'intro' }, { block: 0 }, { block: 1 }]);
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

test('fitCells: a picture that stays legible within 30 rows is capped at 30 rows', () => {
  // 600 x 600 px: 75 columns would need 38 rows; capped to 30 rows, 60 columns, scale 0.8.
  const r = fitCells(600, 600, { columns: 100, rows: 40 }, CELL);
  assert.equal(r.rows, 30);
  assert.equal(r.columns, 60);
  assert.equal(r.scale, 0.8);
});

test('fitCells: a tall picture grows past 30 rows only as far as scale 0.8 needs', () => {
  // 600 x 1200 px: within 30 rows it would be at scale 0.4; at scale 0.8 it needs 60 rows.
  const r = fitCells(600, 1200, { columns: 100, rows: 60 }, CELL);
  assert.equal(r.rows, 60);
  assert.equal(r.columns, 60);
  assert.equal(r.scale, 0.8);
});

test('fitCells: a tall picture is at most two terminal heights (less 6 rows)', () => {
  // On a 30-row terminal the same picture may take 54 rows, so it ends at scale 0.72.
  const r = fitCells(600, 1200, { columns: 100, rows: 30 }, CELL);
  assert.equal(r.rows, 54);
  assert.equal(r.columns, 54);
  assert.equal(r.scale, 0.72);
  // A very tall one stops at the same limit.
  assert.equal(fitCells(300, 6000, { columns: 100, rows: 40 }, CELL).rows, 74);
});

test('fitCells: a picture limited by the terminal width does not grow taller', () => {
  // 2000 x 600 px on 100 columns: 96 columns, 14 rows, scale 0.384; more rows cannot help.
  const r = fitCells(2000, 600, { columns: 100, rows: 40 }, CELL);
  assert.deepEqual({ columns: r.columns, rows: r.rows }, { columns: 96, rows: 14 });
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
