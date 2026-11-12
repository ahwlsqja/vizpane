import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from './store.mjs';

// Logging must never break a hook, so every failure is swallowed.
export function log(line) {
  try {
    const root = stateRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(join(root, 'vizpane.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {}
}
