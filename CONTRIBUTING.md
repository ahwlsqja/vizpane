# Contributing

Bug reports, feature requests and pull requests are welcome. For a larger change, open an issue first so the direction can be agreed before you write code.

## Requirements

- Node.js 20 or later. There are no dependencies to install.
- cmux, only for the end-to-end script. Unit tests do not need it.
- `gh` and `cargo`, only for the Codex terminal check.
- `cc` (Xcode Command Line Tools), for the Codex relay tests. The filter tests are written to build on macOS and Linux (Linux: untested until CI runs); the pseudo-terminal tests run on macOS only and are skipped elsewhere. The job-control cases drive a real `/bin/zsh -i` and are skipped where it is missing.

## Tests

```sh
node --test
```

The relay tests compile `plugins/vizpane/inline/relay.c` with `cc` (the pseudo-terminal suite has timing-based cases and takes about six minutes, because it builds the relay twice). Two environment variables change how they build and run:

- `VIZPANE_FUZZ=1` runs 10^6 random streams through the output filter instead of 2*10^4 (`VIZPANE_FUZZ_SEED` changes the base seed). The filter tests always run under AddressSanitizer and UndefinedBehaviorSanitizer, and an independent lexer in `test/helpers/vtlex.mjs` checks where insertions land.
- `VIZPANE_TEST_ASAN=1` builds the relay of the pseudo-terminal suite with the same sanitizers. Use it when you change `relay.c` or `relay-filter.h`.

`test/relay-osc52.test.mjs` is a measurement: it builds the relay and a writer that has Codex's write pattern (a frame to stdout, then an OSC 52 to `/dev/tty`), runs them against a terminal that reads fast or slowly, and prints how often the copy was cut. It takes about a minute. The rates depend on the machine, so only the control and the relay's own sequence integrity are asserted (the rate for every size, 256 and 300 bytes included, is printed, not asserted). Run it after any change to how the relay writes (chunk size, the free-space rule) and update every place that carries the numbers: `docs/codex-setup.md` (the master copy), `SECURITY.md`, `docs/how-it-works.md`, `README.md`, `README.ko.md`, `CHANGELOG.md` and the header of `plugins/vizpane/inline/relay.c`.

Unit tests cover the store, hook, cmux handling (against a stub executable), fence extraction, the viewer logic in `viz-core.js`, the inline mod's pure logic (`claude/inline-core.mjs`) and the renderer build logic (with an injected build, so no test compiles Swift). They run without cmux.

```sh
node scripts/e2e-cmux.mjs
```

The end-to-end script drives a real viewer. It must run inside a cmux terminal (`CMUX_WORKSPACE_ID` set). It uses a temporary state root, opens a viewer pane in the current workspace, pushes fixtures, checks the live page through `cmux browser eval`, and closes the pane. Pass `--keep` to leave the pane open. Run it when you change `viewer.js`, `viz-core.js`, `lib/cmux.mjs` or the sanitising rules.

## Scripts

| Command | Purpose |
|---|---|
| `node scripts/vendor.mjs` | Reinstalls the pinned versions of Mermaid, marked and DOMPurify into a temporary directory and copies the bundles and licence files to `plugins/vizpane/viewer/vendor`. Needs `npm` and network access. When you change a version, change it in the script too. |
| `node scripts/check-inline.mjs` | Builds the inline renderer into a temporary directory and draws the three examples of the `viz-style` skill to PNG files, printing each size, and checks that the renderer sends no network request. macOS only; needs `swiftc` and a login session. Run it when you change `inline/`. |
| `node scripts/check-codex-inline.mjs` (`npm run check:codex-inline`) | Builds the Codex relay into a temporary state root, runs a test program through it in the current pane so that a picture is drawn, then shows, on the alternate screen, the placeholder cells of that picture (they must be blank) next to a control picture the script loads itself (it must show). You judge the result by eye. No model calls. macOS and cmux only, and it refuses to run elsewhere. **Run it only in a spare cmux pane**, never in a pane that holds a live agent session: it takes over the pane's terminal. |
| `node scripts/check-codex-terminal.mjs` | Builds the Codex TUI's Mermaid text renderer from the installed Codex version and checks that every Mermaid example in the `viz-style` skill is accepted. Needs `gh`, `cargo` and `codex`. Options: `--width <columns>`, `--tag <tag>`, and file paths. |

## Versions

The version is stored in four places that must match:

- `plugins/vizpane/VERSION`
- `VERSION` in `plugins/vizpane/viewer/viewer.js`
- `plugins/vizpane/.claude-plugin/plugin.json`
- `plugins/vizpane/.codex-plugin/plugin.json`

A unit test fails if they differ. A mismatch would make every push reload the viewer, because the page compares its `viz.version` with `VERSION`. When you release, also update `package.json`, `.claude-plugin/marketplace.json` and `CHANGELOG.md`. The renderer is rebuilt on users' machines at the next Claude Code session start or by `vizpane renderer` or `vizpane codex-inline`; the relay only by `vizpane codex-inline` (until then the old binary keeps running and `doctor` reports `skip`). A change to `inline/` should come with a version bump.

## Code style

- Node built-ins only. Do not add a dependency.
- No build step. The repository contains what runs.
- Plugin code is ES modules (`.mjs`). Viewer code is classic scripts, not modules, because the page runs from `file://` where modules and `fetch()` of local files are blocked. `viz-core.js` must not touch the DOM so that tests can load it in `node:vm`.
- The hook must never fail the agent. Anything that runs from a hook catches its errors and logs them.
- Anything derived from an answer is untrusted. Never insert it with `innerHTML` without sanitising it, and never build a shell command from it.
- Keep comments short and explain why, not what.

## Pull requests

A good pull request:

- Does one thing and says why in the description.
- Adds or updates a test for the behaviour it changes, or says why it cannot.
- Passes `node --test`. For viewer or cmux changes, say whether you ran `node scripts/e2e-cmux.mjs`.
- Updates the documentation in `docs/` when behaviour changes. If you change a `%% viz:` verb, update `docs/diagram-comments.md`, the `viz-style` skill and the session context in `plugins/vizpane/lib/payload.mjs` together.
- Adds a line to `CHANGELOG.md` under an `Unreleased` heading.

Security issues go through the process in [SECURITY.md](SECURITY.md), not through public issues.
