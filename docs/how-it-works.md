# How vizpane works

vizpane has no server and no daemon. It has three paths.

- **Side pane (Codex by default, and `push` for any agent).** A hook script stores the answer as a small script file, and a static HTML page in a cmux browser pane loads it. This is the path described first.
- **Inline (Claude Code).** A Claude Code mod draws the diagram as a picture under the answer. See [Inline pictures in Claude Code](#inline-pictures-in-claude-code).
- **Inline (Codex, experimental, opt-in).** A per-session relay lets Codex draw the picture in its own transcript. See [Inline pictures in Codex](#inline-pictures-in-codex-experimental).

```text
+------------------------+
| Agent TUI              |
| Claude Code or Codex   |
+-----------+------------+
            | turn ends: Stop hook, JSON on stdin
            v
+------------------------+
| vizpane hook          |  always exits 0
| writes jobs/<id>.json |
| spawns detached worker|
+-----------+------------+
            | returns at once (Codex gets {"continue":true})
            v
+------------------------+       +--------------------------------+
| Detached worker        | ----> | State root                     |
| has a mermaid fence?   | write | ~/.local/state/vizpane         |
| find or open viewer    |       |   viewer.html, vendor/ ...     |
+-----------+------------+       |   data/<workspace>/turns/*.js  |
            |                    +----------------+---------------+
            | cmux browser <surface> eval                |
            v                                            | <script src>
+------------------------+                               |
| cmux browser pane      | <-----------------------------+
| viewer.html (file://)  |
| marked, DOMPurify,     |
| Mermaid 12             |
+------------------------+
```

The worker never talks to the agent. The agent TUI keeps the terminal; the viewer is a separate pane next to it.

## The hook

`vizpane hook --agent claude|codex` is registered as the plugin's Stop hook. On every turn it:

1. Reads the hook payload from stdin.
2. Writes it to `jobs/<random>.json` in the state root.
3. Starts `vizpane _work <job>` as a detached process and returns.

All real work happens in that worker, so the agent turn never waits on cmux. Every failure is caught and written to `vizpane.log`. The hook always exits 0.

| Agent | Hook stdout |
|---|---|
| Claude Code | nothing |
| Codex | `{"continue":true}`, or with the relay `{"continue":true,"systemMessage":...}` |

In Claude Code, when the inline renderer is built and `VIZPANE_INLINE` is not `off`, the worker stores the answer in `last/` and does not publish it to the pane, because the mod already drew it. In Codex inside the relay, the hook renders the diagram itself and returns it as the `systemMessage` (see below), and stores the answer in `last/` without publishing it. Codex outside the relay is unchanged, and `push` always publishes.

The Stop payload provides three fields: `last_assistant_message`, `session_id`, `cwd`. A payload without a non-empty `last_assistant_message` is ignored.

The Claude Code plugin also registers a SessionStart hook (`startup`, `resume`, `clear`, `compact`). It copies the app files into the state root if the installed version is outdated. Inside a cmux workspace where auto push is not turned off, it adds the diagram-writing rules to the session context. The Codex plugin registers only the Stop hook; see [Codex setup](codex-setup.md).

## What is stored and where

The state root is `~/.local/state/vizpane`. Set `VIZPANE_HOME` to use another directory.

```text
<state root>/
  VERSION              installed plugin version
  viewer.html          the viewer page, with viewer.css, viewer.js, viz-core.js
  vendor/              marked, DOMPurify, Mermaid (local copies)
  bin/  lib/           copy of the CLI, so the path never changes
  bin/viz-render       inline renderer, built from inline/render.swift (with a .stamp file)
  claude/              the Claude Code mod and the logic the Codex hook shares (inline-core.mjs)
  inline/              render.swift, render.html, relay.c, relay-filter.h, LICENSES/, and cache/ (PNG pictures and size files)
  inline/sessions/     one directory per Codex session running in the relay, deleted when it ends
  relay/codex          the Codex relay, built from inline/relay.c (with a .stamp file)
  jobs/                hook payloads waiting for the worker
  vizpane.log          one line per push, one per error
  data/<workspace>/
    boot.js            list of kept turns
    turns/turn-0001.js one script file per answer
    last/<session>.json  latest answer of each session, with or without a diagram
    off                present when auto push is off for this workspace
    .lock/             held while the viewer is found or created
```

`<workspace>` is `CMUX_WORKSPACE_ID` with every character outside `A-Za-z0-9_-` replaced by `_`. Outside cmux it is `no-cmux`.

- Directories are created with mode 0700 and files with mode 0600.
- Each workspace keeps the 30 newest turns. Older turn files are deleted when a new one is written. Files in `last/` are not pruned.
- A turn file is `viz.add({...});`. The JSON is escaped so that `<` and the JavaScript line separators never appear raw in it.
- Files are written to a temporary name and renamed, so the viewer never reads a half-written file.
- The lock is a directory created with `mkdir`. A waiting process retries for up to 3000 ms. A lock older than 10000 ms is treated as stale and removed.

The app files are copied from the plugin into the state root because the viewer is loaded from `file://` and can only read scripts from its own directory tree. `vizpane sync` forces the copy (the `inline/` directory is copied too); it also happens automatically when `VERSION` differs.

## When an answer is pushed

| Case | Result |
|---|---|
| Answer has a fence whose info string is exactly `mermaid` (backticks or tildes, case-insensitive) | Pushed to the viewer |
| Answer without such a fence | Stored in `last/` only |
| A fence such as `mermaid-js`, or the word "mermaid" in prose | Not a diagram; stored only |
| `vizpane off` was run in this workspace | Stored only |
| Not inside cmux (`CMUX_WORKSPACE_ID` unset) | Stored only |
| cmux calls fail or time out (5000 ms each) | Stored only; the error is logged |

Commands, run as `node ~/.local/state/vizpane/bin/vizpane.mjs <command>`:

| Command | Effect |
|---|---|
| `push --last [--session <id>] [--title <t>]` | Push the newest stored answer of this workspace, or of one session |
| `push --file <path.md> [--title <t>] [--agent <name>]` | Push a Markdown file |
| `push --stdin [--title <t>] [--agent <name>]` | Push Markdown read from standard input |
| `open` | Open the viewer if it is not open |
| `off` / `on` | Turn automatic pushing off or on for this workspace. `push` still works while off |
| `sync` | Copy the app files into the state root now |
| `codex-inline` | Build the renderer and the Codex relay, show which Codex the relay would run, and print the `export CMUX_CUSTOM_CODEX_PATH=...` line to add to your shell profile |
| `renderer` | Build the inline renderer if it is missing, built for another version, or built from other sources. Prints one JSON line, `{"ok":true,"path":...}` or `{"ok":false,"error":...}`, and exits 0 |
| `doctor` | Check Node, the state root, version, vendor files, `CMUX_WORKSPACE_ID` and `cmux ping`. More lines report the inline renderer and the Codex relay (`ok` or `skip`) and never fail the run |

The agent-facing `viz` skill wraps these commands. `off` does not stop the answer from being stored in `last/`.

## The viewer surface

There is one viewer per cmux workspace. Claude Code and Codex answers in the same workspace appear in the same timeline, marked with a badge.

For each push the worker takes the workspace lock and then:

1. Runs `cmux tree --workspace <id> --json` and looks for a browser surface whose URL starts with `file://<state root>/viewer.html?ws=<workspace>`. The surface is found by URL because the reference printed at creation cannot be relied on later.
2. If it exists, runs `cmux browser <surface> eval` with a script that loads the new turn file. The script first checks that the page's `viz.version` equals the installed `VERSION`.
3. If the versions differ, the page answers `stale` and the worker reloads the surface with `cmux browser <surface> reload`. The reloaded page reads `boot.js`, which already lists the new turn.
4. If it does not exist, runs `cmux new-pane --type browser --direction right --focus false --url <viewer URL>`. The pane opens to the right of the agent without taking keyboard focus.

If you close the pane, the next diagram answer opens it again and `boot.js` restores the earlier cards (up to 30). Taking the lock means two agents that finish together create one viewer, not two.

The reload goes through cmux because a `file://` page that reloads itself from its own script does not finish loading in the cmux browser.

## Inline pictures in Claude Code

Claude Code can load a hooks module (a mod) from a plugin. vizpane's mod is `claude/register.tsx`, named under `modules` in `claude/hooks.json`. It hooks the rendering of each assistant message and draws a picture under the reply.

```text
assistant reply (Markdown)
        |  ui.render, AssistantMessage, terminal only
        v
 mod: find complete ```mermaid fences
        |  one render per source and theme
        v
 viz-render (Swift helper)  ->  <state root>/inline/cache/<hash>-<theme>.png
        |  offscreen WebKit view runs Mermaid 12, network loads blocked
        v
 mod: fold each drawn block to "▸ diagram N", add an Image under the reply
```

Steps:

1. At session start the mod runs `vizpane renderer`. That command syncs the app files and builds `<state root>/bin/viz-render` with `swiftc -O` if the file is missing or its stamp names another plugin version. The build takes a few seconds and happens once per version. If it cannot run (not macOS, no `swiftc`, `VIZPANE_INLINE=off`), the mod remembers that inline is unavailable.
2. The mod runs `viz-render --cell` once. The helper finds the first parent process with a controlling terminal, reads the terminal's size in cells and in pixels (`TIOCGWINSZ`), and divides by the main screen's scale factor. That gives the cell size in points. If the terminal does not report pixel sizes, the mod uses 8 points wide and an aspect of 2.1.
3. For each complete `mermaid` fence in a reply, the mod writes the source to the cache and runs `viz-render render.html source.mmd out.png dark|light`. The theme is `light` when Claude Code's theme setting contains `light`, otherwise `dark`. The helper prints the picture size in CSS pixels.
4. The mod replaces each drawn block by a one-line marker (`▸ diagram N`, or `▸ 도식 N` when `LANG` starts with `ko`) and draws an `Image` per picture under the reply, with a dim caption. A block that failed to render stays as code, and no picture or error row is added for it.
5. The size of the picture box in cells comes from the picture's size and the cell size. A small picture fits in at most 120 columns and 30 rows. When 30 rows would shrink the picture below 0.8 of its size, the box grows taller, only as far as 0.8 needs and at most two terminal heights less 6 rows: the transcript scrolls, and text too small to read is worse than a tall picture. A picture wider than the terminal can only shrink.
6. Next to each picture's label is an **Enlarge** button. Clicking it runs `vizpane push --stdin --zoom` with that diagram: the side pane draws it as vector graphics and opens it enlarged. Outside cmux, it opens the PNG in the system image viewer.

The mod renders each source once per session. The same source and theme reuse `<hash>-<theme>.png` and its size file from earlier sessions. Files older than 7 days are deleted at session start.

The pure logic (finding fences, folding, cell arithmetic, hashing) is in `claude/inline-core.mjs` and is tested with `node --test`. The cell arithmetic follows [claude-code-figures-plugin](https://github.com/natsukium/claude-code-figures-plugin) (Apache-2.0).

When the helper is unavailable, the mod does nothing and Claude Code draws the reply as usual. The Stop hook then publishes the answer to the side pane, as for Codex. A render that fails or times out (15 seconds in the helper, 20 seconds in the mod) leaves that one block as code.

`render.html` uses the same diagram upgrade (`%% viz:` comments) and the same Mermaid `secure` list as the viewer, so a diagram cannot change the theme or fonts. See [SECURITY.md](../SECURITY.md) for the isolation of the helper.

## Inline pictures in Codex (experimental)

This path is opt-in; setup is in [Codex setup](codex-setup.md#inline-pictures-experimental).

### The principle

Codex draws its own transcript and has no way to put an image into it. A picture in a terminal is placed by the terminal, not by the program that wants it, so two things have to meet: cells that Codex itself prints, and pixel data that reaches the terminal. vizpane uses the kitty graphics protocol's Unicode placeholders for the cells. A placeholder is the character U+10EEEE followed by two combining marks (row and column). Its foreground colour carries the image id. A terminal that has an image with that id draws the matching piece of the picture in each cell. The cells are ordinary text, so Codex scrolls, wraps, repaints and clips them like any other text, and the picture follows.

The hook returns those cells as the `systemMessage` of the Stop hook, and Codex prints a hook message in its transcript. What is missing is the pixel data. It has to be transmitted to the terminal at some point before the cells are drawn, and the transmit has to sit in the same output stream as the cells, because the terminal attaches a picture to the pane that received it.

Two things that do not work:

- **Writing to the pane from outside.** The hook does not own the terminal. Writing to its tty from another process lands in the middle of whatever Codex is drawing, and the terminal's parser cannot tell the difference. An escape sequence that starts in the middle of another one corrupts both.
- **Rewriting Codex's output.** Changing what Codex prints means understanding its output well enough to edit it. Any mistake changes what the user sees.

So vizpane copies Codex's output unchanged and inserts each picture's transmit once, at a point where the terminal's parser is idle. That needs a process on Codex's output path, which is what the relay is. It gives Codex a pseudo-terminal as its stdout and leaves input, terminal modes and job control on the pane.

### The components

```text
 terminal (cmux pane)
   | ^                                  <state root>/inline/sessions/s1-<pid>-<rand>/
   | |  Codex's output, unchanged,         ^ relay writes tui, resolved   | hook writes <id>.png, .cr
   | |  plus an inserted transmit          | and reads <id>.png, .cr        v and reads tui, resolved
   | |                               +-----+------+            +-----------+
   | +-------------------------------| relay      |            | Stop hook |
   |                                 | poll loop, |            | renders   |
   | keys, termios, size,            | filter     |            | the PNG,  |
   | job control: direct             +-----^------+            | builds    |
   |                                       | pty master        | the cells |
   |                                 +-----+------+            +-----^-----+
   +-------------------------------->| Codex      |-------------------+
        stdin = the pane             | stdout =   |  runs in Codex's process tree
                                     | relay pty  |
                                     +------------+
```

- **Relay** (`inline/relay.c`, `inline/relay-filter.h`). Written in C with libc only, one thread, one poll loop. It decides whether to engage, finds the real Codex, creates the session directory and starts Codex as its child in the same process group, with a pseudo-terminal as Codex's stdout (and stderr, when that was the terminal, so that Codex's own check that both are one file still holds). It reads that pseudo-terminal, runs the output through the filter and writes to the pane, waiting until the pane can take each chunk. It mirrors the pane's size into the pseudo-terminal. It never reads the pane, never changes its termios and never sets a process group. Codex keeps the pane as stdin, so keys, raw mode, window size and job control are the shell's and the kernel's, as in stock. When Codex stops (Ctrl+Z) the relay drains what Codex wrote, then stops itself with the same signal, so the shell reports the job as usual; at exit it drains, deletes the pictures it loaded and exits with Codex's status. Under `stty tostop` a write the relay makes from the background is refused with SIGTTOU; the relay holds its output until the child, which got the same group signal, has stopped, and follows that stop. Once the child is gone, what the relay still owes is dropped if the child died of a signal (`kill %1`).
- **Output filter** (`inline/relay-filter.h`). A parser of the terminal's escape sequences that follows the output as the terminal's parser does, so it knows where an insertion is safe. It also watches for the first placeholder of each picture.
- **Hook** (`lib/codex-inline.mjs`, `bin/vizpane.mjs`). Renders each diagram with the same renderer as Claude Code, publishes the PNG into the session directory and returns the placeholder cells.
- **`codex-inline`** builds the renderer and the relay and prints the export line. cmux's Codex wrapper starts the program named by `CMUX_CUSTOM_CODEX_PATH`, which is how the relay takes the place of `codex`.

### The session directory contract

The relay creates `<state root>/inline/sessions/s1-<pid>-<random>/` with mode 0700 and exports it to Codex as `VIZPANE_INLINE_DIR`. The hook runs inside Codex's process tree and inherits it. The `s1-` prefix is the contract version; a hook that does not know the prefix ignores the directory and uses the side pane.

| File | Written by | Meaning |
|---|---|---|
| `tui` | relay | present while Codex has bracketed paste on, which tells the hook a TUI is live |
| `<id>.png`, `<id>.cr` | hook | one picture, and its cell box as `columns rows`; `.cr` is written last, and the relay needs both |
| `resolved` | relay | touched each time the relay transmits a picture |
| `emitted` | hook | touched before a reply that publishes a new picture |
| `strikes`, `incompatible` | hook | the canary, below |

`<id>` is six hex digits, an id between 0x100000 and 0x7FFFFF, derived from the picture and its box so that the same picture keeps its id.

### The insertion rules

1. **When.** The first time a placeholder for a known id is about to be drawn, the filter transmits that picture (`a=T,U=1,f=100,t=f,q=2`, a path to the PNG in the session directory). Each id is transmitted once while it is loaded.
2. **Where.** Only at a point where the terminal's parser is in its ground state, no UTF-8 character is half written and no chunked graphics load is open. The transmit goes in front of the placeholder if it can. Otherwise it waits and goes in at the next safe point: in front of an escape or an ASCII byte, or after a complete sequence. It is never placed between a character and its combining marks.
3. **Cleanup.** Before Codex leaves the alternate screen, and at exit, the filter deletes the images it loaded (`a=d,d=I,q=2`). That is best effort: in rare cases an image stays in cmux's memory until the pane closes.
4. **Nothing else.** It does not change cursor, colours or modes, and it never asks the terminal a question (`q=2` suppresses every reply). Every file it reads is checked first: a regular PNG in the session directory, within size and dimension limits and within a memory budget for loaded images.

### The end of a turn

Hook output arrives while Codex draws the transcript. The hook renders each diagram (up to three at a time, at most six per answer, within a seven-second budget; the hook's own timeout is ten), publishes the files, and prints the reply. The relay sees the placeholders in Codex's output and transmits the pictures just before they are drawn. Codex then repaints those cells on every redraw, and the terminal keeps showing the picture as long as the image is loaded.

### Failure handling

| Situation | Result |
|---|---|
| The relay cannot start (no cc, no pty, a setup error) | It runs the real Codex directly |
| Not in cmux, not a terminal, tmux or zellij, an SSH session or Herdr, `NO_COLOR`, `VIZPANE_INLINE=off`, `exec` and other non-interactive subcommands | The relay does not engage; Codex runs as stock |
| The relay dies (SIGKILL, a fault signal such as SIGABRT or SIGSEGV sent to it, or a bug; it catches the other terminating signals) | The shell gets the terminal back at once. Nothing restores the terminal, so type `reset`. Codex's output has no reader, so Codex should end at its next write to it or read of the terminal (inferred from its source and stand-ins; a Codex that is idle may stay until then, so end a leftover one with `kill`). `codex resume` continues the conversation |
| The renderer is missing (also after a vizpane update, until `codex-inline` or `renderer` runs again), no diagram renders in time, the pane is too small | The answer goes to the side pane |
| One diagram of several does not render | It is left out and counted as "and N more" in the caption; the answer is not pushed, `push --last` shows all |
| A terminal emulator inside the pane (GNU screen, Vim, Neovim, Emacs, JetBrains) | The relay does not engage |
| Pictures were published but never transmitted (for example the answer scrolled out of view) twice in a row | The session is marked `incompatible` and uses the side pane from then on. One success resets the count |
| Codex or cmux changes in a way that breaks the assumptions above | A picture can be missing or drawn wrongly; Codex's text is not lost. Re-check after updating either. The assumptions about Codex were checked in the 0.169.0 source; the current build was run live with Codex 0.169.0 and cmux 0.64.22 for job control and one diagram turn, and an earlier build with the same output path for pictures, resizing, Ctrl+G and `codex resume` |

The relay never reads what you type. Keys go straight from the terminal to Codex. A process that still holds the relay's pseudo-terminal when the relay's child has exited, whether one Codex left behind or the program behind a forking launcher (the stock `codex` script) whose launcher died first, loses it when the relay exits (EIO on write). See [SECURITY.md](../SECURITY.md).

Known differences from stock Codex, all bounded:

- With `stty tostop` set, after Ctrl+Z, `bg` and `fg`, Codex comes back without raw mode. On resume Codex writes `?2004h` to stdout and then calls `tcsetattr` for raw mode, and it does not retry when that call is interrupted (Codex 0.169.0). Stock Codex is stopped by `tostop` at the write, so its `tcsetattr` runs in the foreground; behind the relay the write goes to the relay's pseudo-terminal, which is not Codex's controlling terminal, so `tostop` does not stop it and Codex is stopped at the `tcsetattr`. The result equals stock Codex without `tostop` (the macOS default). The relay's own held bytes are written after `fg`, so the bracketed paste order matches stock. There is no fix inside the relay that does not race Codex (stopping the job when it continues in the background would make the relay decide job control, which it follows and does not decide). The way out is `/quit` and `codex resume`. `test/relay-pty.test.mjs` (P5g) pins it; turn that test around if Codex starts retrying.
- A program that writes to the terminal directly lands between the relay's chunks, except in a string with no cut point (a picture chunk, an OSC 8 link). A write above 256 bytes can be cut by a chunk. In practice that is Codex's OSC 52 clipboard fallback, which is used only when Codex's native macOS clipboard copy fails: measured, copies of 1 KiB were cut in 11% to 77% of the tries and 4 KiB in 60% to 98%, with stray text until the next redraw. cmux's terminal then rejects a cut copy that is not well-formed base64, so the clipboard usually keeps what it held before and Codex says "Copy unconfirmed"; in one run 582 of 603 cut copies would be dropped and 21 would leave a truncated copy. Check the clipboard before pasting it into a shell. See [SECURITY.md](../SECURITY.md) and [the setup guide](codex-setup.md#clipboard-copies-can-be-cut-and-then-fail-only-when-codexs-native-clipboard-fails).
- If the relay is killed, nothing restores the terminal: type `reset`.
- `kill -TSTP <pid of the relay>` alone does nothing; Ctrl+Z, `kill -TSTP %1` and SIGSTOP work.
- Each resize sends the job one extra SIGWINCH 40 ms after the first, which Codex handles as a redraw. A program that reads the size from stdout (vim) may draw once at the old size first.
- In a cooked phase (start-up, exit) Ctrl+C flushes the terminal's output queue; the relay still writes the up to about 2.5 KB it holds, which stock Codex would not.
- An editor that sets output modes on its stdout (not stdin) changes the pseudo-terminal, not the pane. vim and pico set them on stdin; others are not checked.
- Output throughput is 40 to 63 MB/s instead of about 125 MB/s with an instant reader; Codex prints far less.
- Footprint: about 2,900 lines of C on the output path, one extra process per Codex session (the relay) with about 1.5 MB resident, about 1.5% of a core while paging through a long answer, a turn that ends 0.6 to 1.3 s later when a new diagram is drawn, and Codex's output up to about 2.5 KB ahead of the pane. The numbers and how they were measured are in [the setup guide](codex-setup.md#cost).

## Rendering in the page

Each card goes through these steps, in this order:

```text
Markdown --> marked --> DOMPurify --> find ```mermaid blocks
                                             |
                                             v
  SVG scrub <-- Mermaid 12 <-- semantic classes <-- upgradeSource
   (strict)
```

1. marked converts the answer from Markdown to HTML.
2. DOMPurify sanitises the HTML. Tags that can load or run something (`style`, `iframe`, `svg`, `form` and others) and attributes such as `style` and `srcset` are removed. Images are kept only as inline `data:image/png|jpeg|gif|webp;base64` URLs. Other images are replaced by a text placeholder.
3. Code blocks marked `mermaid` are found in the sanitised HTML, and their source is read back as text.
4. `upgradeSource` turns `%% viz:` comment lines into Mermaid syntax. See [Diagram comments](diagram-comments.md).
5. For flowcharts, `classDef` lines are added for the semantic colour names that the diagram uses, in light or dark values.
6. Mermaid 12 renders the SVG with `securityLevel: 'strict'`. A diagram cannot override the theme, fonts or security settings.
7. The SVG is parsed in an inert document and scrubbed: external `image`, `use` and `feImage` references, `@import` and remote `url()` are removed. The result is inserted into the card.

If Mermaid rejects a diagram, the card shows an error box with Mermaid's message and the diagram source. Other diagrams in the same answer still render. The error is available as `viz.errors()` in the page.

Width policy: if the pane's inner width is at least 0.7 of the diagram's natural width, the diagram scales to fit. Below that, it keeps its natural width and the card scrolls horizontally. This keeps text readable in a narrow pane.

Interface: a button shows or hides the source of each diagram, a click on a diagram opens it enlarged (Escape or another click closes it), and a header button hides the prose so that only diagrams remain. Links in answers are not followed. The interface text is English, or Korean when the browser language is Korean.

## Theme

The viewer follows `prefers-color-scheme`. To force a theme, set `VIZPANE_THEME=light` or `VIZPANE_THEME=dark` in the environment of the agent; the value is passed to the viewer as `&theme=` in the pane URL. Any other value is ignored. The setting applies when a pane is created; close the pane to apply a changed value.

## Why not ...

| Alternative | Why it was not used |
|---|---|
| Inline images for Codex through an extension | Codex has no extension point for drawing into the conversation. Claude Code has one, and uses it. For Codex the options are a relay on Codex's output path (opt-in, above) or the side pane. |
| A relay that carries input and output (a full pseudo-terminal proxy) | Whoever reads the keyboard must hand unread keys back when Codex stops or exits, and that hand-back races. An earlier, unreleased design corrupted pasted input in tests, and its job control and `kill %1` differed from stock. Only the output needs a byte inserted, so only the output goes through the relay. |
| A local web server | Not needed. A static page at `file://` plus `cmux browser eval` is enough, and there is no process to start, stop or secure. |
| An MCP tool | The agent would have to call it on every answer. A Stop hook runs without the agent's involvement. |
