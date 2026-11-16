# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-16

Experimental and opt-in. Without the one line for your shell profile, the only change for Codex is the Stop hook's new status line (see Changed), which needs re-approval in `/hooks` unless cmux starts Codex with hook trust bypassed.

### Added

- Inline pictures in Codex (experimental). A per-session relay (`inline/relay.c`, about 2,900 lines of C with its output filter) passes Codex's output through a pseudo-terminal unchanged, apart from the picture data, and transmits a picture at a safe point in it. Input, terminal modes, window size and job control stay with Codex and the shell; the relay never reads the terminal. If the relay is killed, the prompt returns and `reset` repairs the terminal. The Stop hook draws each diagram as kitty Unicode-placeholder cells in its `systemMessage`, and Codex draws those cells in its own transcript, so the picture follows Codex's scrolling and repainting.
- `vizpane codex-inline` builds the renderer and the relay (`swiftc` and `cc` from the Xcode Command Line Tools), shows which Codex the relay would run, and prints the `export CMUX_CUSTOM_CODEX_PATH=...` line to add to your shell profile. vizpane does not edit dotfiles.
- `doctor` reports whether the relay is built, whether `CMUX_CUSTOM_CODEX_PATH` points to it, and which Codex it would run. `codex-inline` and `doctor` warn when `CMUX_CUSTOM_CODEX_PATH` is already set to something else; export that value as `VIZPANE_REAL_CODEX` to keep running it.
- `viz-render --cell [tty-path]` accepts a tty path (the Codex hook passes the pane's terminal), and the renderer's build stamp now includes a hash of its sources, so editing them rebuilds it.
- `scripts/check-codex-inline.mjs` (`npm run check:codex-inline`) runs a test program through a temporary relay in the current cmux pane and prints the placeholder cells of the relay's picture after exit (they should be blank) beside a control picture (it should show). The result is for you to look at. Run it only in a spare pane.
- `test/relay-osc52.test.mjs` measures how often Codex's OSC 52 clipboard fallback is cut by the relay (Codex's own write pattern against the real relay, 256 B to 4 KiB, fast and slow terminals) and prints the rates; it asserts only the control (no cuts without the relay), and the relay's own sequence integrity; the rates for every size, including 256 and 300 bytes, are printed but not asserted), and classifies cut copies the way cmux's terminal treats them.
- Tests for the relay: the output filter, a pseudo-terminal suite (job control with a real zsh, resize, concurrent writers, exit), and the hook side. `VIZPANE_FUZZ=1` runs the long fuzz of the filter and `VIZPANE_TEST_ASAN=1` builds the relay of the pseudo-terminal suite with the address and undefined-behaviour sanitizers.

### Changed

- In Codex inside the relay, the Stop hook renders the diagram synchronously and returns it in the conversation, which adds about a second (at most about 7 seconds) to the end of a turn with a new diagram; the answer itself streams as before. When the hook returns pictures, the answer is stored but not pushed to the side pane; `push --last` still shows it. A diagram that fails to render is left out and counted as "and N more" in the caption. Without the relay, and when no diagram can be drawn (it does not render in time, the pane is too small), Codex behaves as before. The relay does not engage inside GNU screen, Vim, Neovim, Emacs or JetBrains terminals, over SSH or under Herdr.
- The Codex `Stop` hook has a status line, "Rendering diagram" (`statusMessage` in `codex/hooks.json`), shown briefly at the end of every turn while the hook runs, also when nothing is drawn and without the relay. Codex asks you to approve the vizpane hook again in `/hooks` after any update (it pins the plugin's contents, and the status line also changes the hook's declaration), unless cmux starts Codex with hook trust bypassed. The cmux Codex wrapper does that, except when `cmux hooks codex install` installed all of cmux's handlers or `CMUX_CODEX_HOOKS_DISABLED=1` is set.
- `VIZPANE_INLINE=off` now also starts Codex without the relay for that launch.
- Pictures are not restored after `codex resume`, and they are freed when Codex exits (best effort). Codex inline pictures are dark unless `VIZPANE_THEME=light` is set.
- Inside the relay, the Codex hook also deletes cache files older than 7 days after each answer it draws (the Claude Code mod did this at session start only). Codex without the relay does not prune.
- Requirements: `cc` from the Xcode Command Line Tools for the Codex relay.

### Known limits

- The current build was run live with cmux 0.64.22 and Codex 0.169.0 for job control (Ctrl+Z, `bg`, `fg`, `kill %1`, with and without `stty tostop`) and one diagram turn; pictures (six, a tall one), resizing while Codex streams, Ctrl+G and `codex resume` were run live on an earlier build whose output path is the same. The facts about Codex that the relay relies on were checked in the Codex 0.169.0 source (and earlier in 0.167.2, with no change between them). Check again after updating Codex or cmux.
- With `stty tostop` set, after Ctrl+Z, `bg` and `fg`, the relayed Codex comes back without raw mode: input is collected by line and the first Enter after `/quit` becomes a newline. Stock Codex does the same when `tostop` is off (the macOS default), because it does not retry an interrupted `tcsetattr` on resume; the relay makes it happen with `tostop` on as well. The way out is `/quit` (Enter twice) and `codex resume`. A PTY test (P5g) pins the behaviour.
- Footprint, measured: about 2,900 lines of C on Codex's output path, one extra process per Codex session with about 1.5 MB resident, about 1.5% of a core while paging through a long answer, bulk output two to three times slower than without the relay (40 to 63 MB/s against about 125 MB/s), and a turn that ends 0.6 to 1.3 s later when a new diagram is drawn.
- When Codex's native macOS clipboard copy fails, its OSC 52 fallback can be cut by relayed screen text: copies of 1 KiB in about 1 of 9 to 3 of 4 tries, 4 KiB in 60% to 98%, and rarely for 256 bytes (none in our local runs, one in a CI run on a slower machine) (cut rates). cmux's terminal rejects a cut copy that is not well-formed base64, so the clipboard usually keeps what it held before and Codex says "Copy unconfirmed" (in one run, 582 of 603 cut copies would be dropped, 21 would leave a truncated copy, none had screen text in it); check the clipboard before pasting into a shell. Over SSH, in tmux and under Herdr the relay does not engage.
- Output written after the stock launcher script (`/bin/sh`, which starts node) has ended is dropped when the relay exits; not reachable with Codex 0.169.0 through `kill`. A signal sent to the whole job reaches a directly run child twice.
- If the relay is killed, the prompt comes back and the terminal is not restored (`reset`). Codex should end at its next write to its output or read of the terminal; that is inferred from its source and from stand-ins, and a Codex that is idle may stay until then.

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
