# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-11-15

### Added

- An **Enlarge** button next to each picture in Claude Code. It opens the diagram enlarged in the cmux side pane, drawn as vector graphics; outside cmux it opens the PNG in the system image viewer.
- `push --zoom` asks the side pane to open the first diagram of the pushed answer enlarged.

### Changed

- Pictures in Claude Code keep their text legible. A tall diagram that would shrink below 0.8 of its size within 30 rows now grows taller, only as far as needed and at most two terminal heights, instead of shrinking to fit one screen.

## [0.3.0] - 2026-11-14

### Added

- Inline pictures in Claude Code. A Claude Code mod draws each ```mermaid block of a reply as a picture directly under the reply, and folds the code block to one line.
- A native renderer, `inline/render.swift`, that draws a diagram to PNG in an offscreen WebKit view with network loads blocked, and reports the terminal's cell size. `vizpane renderer` builds it once per version with `swiftc`.
- `doctor` reports whether the inline renderer is built.
- `VIZPANE_INLINE=off` turns the inline path off.
- `scripts/check-inline.mjs` builds the renderer, draws the examples of the diagram guide, and checks that the renderer sends no network request (against a control build without the block rules).

### Changed

- In Claude Code, when the inline renderer is built, the Stop hook stores the answer but no longer publishes it to the side pane. Codex and `push` are unchanged.
- The diagram guide and the session context say where the picture appears for each agent. `flowchart LR` is allowed for up to six nodes in a line.
- Requirements: Claude Code 2.1.290 or later and the Xcode Command Line Tools for inline pictures.

## [0.2.1] - 2026-11-13

### Added

- `push --stdin` shows Markdown piped in on standard input, so an agent can show an answer with one command.
- Guidance for sessions that were already running when vizpane was installed: the Codex setup guide, the `AGENTS.md` block and the `viz` skill now explain that such a session has no hook, how to restart it, and how to show answers by hand until then.

### Changed

- `push --file` with an empty file now fails with an error instead of adding an empty card.

## [0.2.0] - 2026-11-13

First public release.

### Added

- Stop hook for Claude Code and Codex that hands the answer to a detached worker and always exits 0.
- Viewer page in a cmux browser pane, one per workspace, created to the right of the agent without taking focus, found by URL, and reopened on demand with earlier cards restored.
- Rendering of ```mermaid blocks with marked, DOMPurify and Mermaid 12, with light and dark themes, `VIZPANE_THEME` override, and an error box that shows the diagram source when rendering fails.
- `%% viz:` comment syntax for flowcharts (shapes, semantic colours, Medallion layers, groups) and sequence diagrams (participant kinds, boxes, phases, automatic step numbers).
- Sanitising of untrusted answers: HTML filtering, no remote images, strict Mermaid security level, SVG scrub, and no link navigation.
- Local state under `~/.local/state/vizpane` (`VIZPANE_HOME` to override) with owner-only permissions, the 30 newest turns per workspace, and a workspace lock.
- `vizpane` CLI with `push --last`, `push --file`, `open`, `off`, `on`, `sync` and `doctor`, plus the `viz` skill that wraps it.
- `viz-style` skill and Claude Code session context that teach agents the plain Mermaid subset and the comment syntax, and a version check that reloads an outdated viewer page through cmux.
- Marketplace and plugin manifests for Claude Code and Codex.
- Test suite (`node --test`), a cmux end-to-end script, a vendoring script, and a Codex terminal renderer check.
