# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
