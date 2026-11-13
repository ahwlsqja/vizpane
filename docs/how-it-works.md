# How vizpane works

vizpane has no server and no daemon. A hook script stores the answer as a small script file, and a static HTML page in a cmux browser pane loads it.

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
| Codex | `{"continue":true}` |

The Stop payload provides three fields: `last_assistant_message`, `session_id`, `cwd`. A payload without a non-empty `last_assistant_message` is ignored.

The Claude Code plugin also registers a SessionStart hook (`startup`, `resume`, `clear`, `compact`). It copies the viewer into the state root if the installed version is outdated. Inside a cmux workspace where auto push is not turned off, it adds the diagram-writing rules to the session context. The Codex plugin registers only the Stop hook; see [Codex setup](codex-setup.md).

## What is stored and where

The state root is `~/.local/state/vizpane`. Set `VIZPANE_HOME` to use another directory.

```text
<state root>/
  VERSION              installed plugin version
  viewer.html          the viewer page, with viewer.css, viewer.js, viz-core.js
  vendor/              marked, DOMPurify, Mermaid (local copies)
  bin/  lib/           copy of the CLI, so the path never changes
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

The app files are copied from the plugin into the state root because the viewer is loaded from `file://` and can only read scripts from its own directory tree. `vizpane sync` forces the copy; it also happens automatically when `VERSION` differs.

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
| `doctor` | Check Node, the state root, version, vendor files, `CMUX_WORKSPACE_ID` and `cmux ping` |

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
| Inline images in the terminal | The agent TUI owns the screen. A tool cannot draw into the conversation. |
| A local web server | Not needed. A static page at `file://` plus `cmux browser eval` is enough, and there is no process to start, stop or secure. |
| An MCP tool | The agent would have to call it on every answer. A Stop hook runs without the agent's involvement. |
