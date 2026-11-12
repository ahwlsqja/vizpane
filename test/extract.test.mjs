import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMermaid, titleOf } from '../plugins/vizpane/lib/extract.mjs';

test('hasMermaid: backtick fence', () => {
  assert.equal(hasMermaid('a\n```mermaid\ngraph TD\n```\n'), true);
});
test('hasMermaid: leading spaces', () => {
  assert.equal(hasMermaid('  ```mermaid\ngraph TD\n```'), true);
});
test('hasMermaid: tilde fence', () => {
  assert.equal(hasMermaid('~~~mermaid\ngraph TD\n~~~'), true);
});
test('hasMermaid: uppercase info string', () => {
  assert.equal(hasMermaid('```Mermaid\ngraph TD\n```'), true);
});
test('hasMermaid: longer fence', () => {
  assert.equal(hasMermaid('````mermaid\ngraph TD\n````'), true);
});
test('hasMermaid: other language is not a match', () => {
  assert.equal(hasMermaid('```js\nconst mermaid = 1;\n```'), false);
  assert.equal(hasMermaid('```mermaidx\nfoo\n```'), false);
});
test('hasMermaid: word in prose is not a match', () => {
  assert.equal(hasMermaid('Use a mermaid diagram here. ```mermaid inline```'), false);
  assert.equal(hasMermaid('mermaid'), false);
});
test('hasMermaid: empty / non-string', () => {
  assert.equal(hasMermaid(''), false);
  assert.equal(hasMermaid(undefined), false);
});

test('titleOf: first heading wins', () => {
  assert.equal(titleOf('intro\n\n## Flink exactly-once\n\n# Later'), 'Flink exactly-once');
});
test('titleOf: no heading uses first non-empty line, emphasis removed', () => {
  assert.equal(titleOf('\n\n**한 줄 결론:** `foo`_bar_ 입니다\nsecond'), '한 줄 결론: foobar 입니다');
});
test('titleOf: cut at 60 chars', () => {
  assert.equal(titleOf('x'.repeat(100)).length, 60);
  assert.equal(titleOf('# ' + 'y'.repeat(100)).length, 60);
});
test('titleOf: empty input', () => {
  assert.equal(titleOf(''), '(제목 없음)');
  assert.equal(titleOf('  \n \n'), '(제목 없음)');
  assert.equal(titleOf(null), '(제목 없음)');
});
test('titleOf: a # line inside a code fence is not a heading', () => {
  assert.equal(titleOf('text first\n```sh\n# comment\n```'), 'text first');
});
