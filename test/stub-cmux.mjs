// Test helper: a fake cmux executable that logs its argv and prints canned output.
import { writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function makeStub(dir, tree = { windows: [] }) {
  const bin = join(dir, 'cmux-stub');
  const log = join(dir, 'cmux-calls.log');
  const treeFile = join(dir, 'cmux-tree.json');
  const evalFile = join(dir, 'cmux-eval.txt');
  writeFileSync(treeFile, JSON.stringify(tree));
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  tree) cat '${treeFile}' ;;
  new-pane) echo "OK surface:9 pane:1 workspace:1" ;;
  browser) if [ "$3" = "eval" ] && [ -f '${evalFile}' ]; then cat '${evalFile}'; else echo "loaded"; fi ;;
  ping) echo "PONG" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    setTree: (t) => writeFileSync(treeFile, JSON.stringify(t)),
    // What `browser <ref> eval` prints; the default is "loaded".
    setEvalAnswer: (text) => writeFileSync(evalFile, text + '\n'),
  };
}

export const treeWith = (url) => ({
  windows: [{ workspaces: [{ panes: [{ surfaces: [
    { ref: 'surface:1', type: 'terminal', url: null },
    { ref: 'surface:4', type: 'browser', url, title: 'x', pane_ref: 'pane:2' },
  ] }] }] }],
});
