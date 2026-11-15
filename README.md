# vizpane

**Rendered Mermaid diagrams for Claude Code and Codex. Claude Code draws them inside the conversation. Codex does too with an opt-in, experimental relay; without it, Codex shows them in a cmux pane next to the agent.**

[![test](https://github.com/ahwlsqja/vizpane/actions/workflows/test.yml/badge.svg)](https://github.com/ahwlsqja/vizpane/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform: macOS + cmux](https://img.shields.io/badge/platform-macOS%20%2B%20cmux-lightgrey.svg)](https://cmux.com)

[한국어](README.ko.md)

Terminal coding agents print Mermaid as source code. vizpane draws the diagram instead.

- **Claude Code:** the picture appears inside the conversation, directly under the answer, and the code block folds to one line. This uses a Claude Code mod and works in Ghostty-based terminals such as cmux, and in kitty.
- **Codex:** by default the answer is shown with the diagram drawn, in a browser pane inside [cmux](https://cmux.com), the moment the agent finishes its turn. Codex has no extension point for pictures in the conversation, so vizpane can also run Codex through a terminal relay that lets Codex draw the picture in its own transcript. That is opt-in and experimental; see [Inline pictures (experimental)](#inline-pictures-experimental).

There is no server, no daemon and no tool call for the agent to make.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/sequence-dark.png">
  <img src="docs/images/sequence-light.png" alt="A Claude Code answer rendered by vizpane: a sequence diagram of Flink's two-phase commit to Kafka, with grouped participants, numbered steps and shaded phases, followed by the reading order and a table." width="820">
</picture>

## What it does

| | |
|---|---|
| **Automatic** | In Claude Code, a ` ```mermaid ` block is drawn under the answer. In Codex, an answer with such a block appears in the pane when the turn ends, or under the answer if you turned on the inline relay. Answers without a diagram stay out of the way, and you can show one in the pane on request. |
| **Rich pictures from plain Mermaid** | Agents write a small, safe subset of Mermaid and describe shapes, colours and grouping in `%% viz:` comment lines. The viewer turns those into cylinders for stores, queues for topics, layer boxes, shaded phases and numbered steps. |
| **One timeline in the pane** | Codex answers, and anything you send with `push`, land in one pane per cmux workspace, each with its own badge. |
| **Untrusted by default** | Answers can contain text fetched from the web. HTML is sanitised, scripts never run, and remote images and stylesheets are removed. |
| **Hard to break** | A diagram with a syntax error shows the error and its source while the rest of the answer renders. Close the pane and the next diagram reopens it with earlier answers restored. |
| **Local** | Files under `~/.local/state/vizpane`, readable only by you. No network requests. |

## Plain Mermaid in, picture out

The agent writes this:

````markdown
```mermaid
flowchart TB
  %% viz: store pg
  %% viz: table ch
  %% viz: stream topic dlq
  %% viz: proc dbz job
  %% viz: decide ins
  %% viz: fail dlq
  %% viz: ok done
  pg["PostgreSQL<br/>orders"]
  dbz["Debezium"]
  topic["Kafka · orders.cdc"]
  job["Flink job<br/>dedup · batch"]
  ins{"INSERT ok?"}
  ch["ClickHouse<br/>orders_clean"]
  dlq["Kafka · orders.dlq"]
  done(["commit offset"])
  pg --> dbz --> topic --> job --> ins
  ins -->|"yes"| ch --> done
  ins -.->|"failed 5 times"| dlq
```
````

and the picture looks like this (in Codex it is in the pane; in Claude Code it is drawn under the answer):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/flow-dark.png">
  <img src="docs/images/flow-light.png" alt="The flowchart above rendered by vizpane: cylinders for PostgreSQL and ClickHouse, queue shapes for the Kafka topics, a yellow decision node, and a red dead-letter topic on the failure path." width="820">
</picture>

The comments are ordinary Mermaid comments, so the diagram stays valid everywhere else. The full list is in [docs/diagram-comments.md](docs/diagram-comments.md).

Layers and CJK labels work the same way:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/medallion-dark.png">
  <img src="docs/images/medallion-light.png" alt="A medallion pipeline with Korean labels rendered by vizpane: Bronze, Silver and Gold layer boxes containing table nodes, and a table of partition and sort keys below." width="820">
</picture>

## Requirements

- macOS with [cmux](https://cmux.com) (tested with 0.64)
- Node.js 20 or later
- Claude Code, Codex CLI, or both
- For pictures inside Claude Code: Claude Code 2.1.290 or later, a terminal that can show images (Ghostty, cmux or kitty), and the Xcode Command Line Tools (`xcode-select --install`). `swiftc` from the tools builds the renderer once, in a few seconds. Without them Claude Code works as before and diagrams go to the pane.
- For pictures inside Codex (experimental): the same tools, which also provide `cc` to build the relay, and Codex started inside cmux. See [Inline pictures (experimental)](#inline-pictures-experimental).

## Install

### Claude Code

```bash
claude plugin marketplace add ahwlsqja/vizpane
claude plugin install vizpane@vizpane
```

Start a new session inside cmux. The plugin tells the agent how to write diagrams at session start, and builds the renderer on the first start after an install or update.

### Codex

```bash
codex plugin marketplace add ahwlsqja/vizpane
codex plugin add vizpane@vizpane
```

Then do two things once:

1. Open `/hooks` in Codex and approve the vizpane `Stop` hook.
2. Paste the diagram rules into `~/.codex/AGENTS.md`. The block is in [docs/codex-setup.md](docs/codex-setup.md).

Start a new Codex session, or continue an existing one with `codex resume <session id>`. A session that was already running when you installed vizpane does not have the hook; see [Sessions that were already running](docs/codex-setup.md#sessions-that-were-already-running).

#### Inline pictures (experimental)

A third step is optional. By default Codex answers with a diagram open in the side pane. To have the picture drawn inside the Codex conversation instead, run this once:

```bash
node ~/.local/state/vizpane/bin/vizpane.mjs codex-inline
```

It builds the renderer and the relay with the Xcode Command Line Tools (`swiftc` and `cc`), checks which Codex it would run, and prints one line like this:

```bash
export CMUX_CUSTOM_CODEX_PATH="$HOME/.local/state/vizpane/relay/codex"
```

Add that line to your shell profile yourself (vizpane never edits dotfiles) and open a new cmux pane. If `CMUX_CUSTOM_CODEX_PATH` was already set to your own Codex, also export it as `VIZPANE_REAL_CODEX` (the command warns you). You still type `codex` or `codex resume`. The relay passes Codex's output through unchanged and adds each picture's data once, at a safe point in the stream; your keys, the terminal's modes and its size stay with Codex and your shell, and the relay never reads what you type. Ctrl+Z, `fg`, `bg` and `kill %1` are meant to work as they do without the relay, with one known difference (see Limitations). Codex shows the answer as it streams; when the turn ends the hook renders the diagram and the picture appears under the answer, so the end of the turn is about a second later (at most about 7 seconds). Pictures are not restored after `codex resume`. After a vizpane update, run the command again, or answers go back to the side pane. The current build was run live with cmux 0.64.22 and Codex 0.169.0 for job control (Ctrl+Z, `bg`, `fg` and `kill %1`, with and without `stty tostop`) and one diagram turn; pictures (six, and a tall one), resizing while Codex streams, Ctrl+G and `codex resume` were run live on an earlier build whose output path is the same. The facts about Codex it relies on were checked in the 0.169.0 source.

It is experimental because the relay is the foreground process of the pane and has to follow how cmux's terminal parses output. It adds about 2,900 lines of C on Codex's output path, one extra process per Codex session (about 1.5 MB of memory), about 1.5% of a core while you page through a long answer, and output that is two to three times slower than without it (40 to 63 MB/s against about 125 MB/s, far above what Codex prints). A clipboard copy can fail in one rare case (see Limitations). Read [the setup guide](docs/codex-setup.md#inline-pictures-experimental) and [SECURITY.md](SECURITY.md) before you turn it on. To turn it off for one launch, run `VIZPANE_INLINE=off codex`. To turn it off for good, delete the export line.

## Use

Ask the agent to explain something with a diagram. In Claude Code the picture appears under the answer; click **Enlarge** next to it to open the diagram enlarged in the side pane. In Codex the pane opens to the right of the terminal when the turn ends, without taking keyboard focus; with the experimental inline relay the picture appears in the conversation instead.

The pane and these commands work for both agents. Everything else goes through one command. Ask the agent ("show that in the pane") and the bundled `viz` skill runs it, or run it yourself:

```bash
node ~/.local/state/vizpane/bin/vizpane.mjs <command>
```

| Command | Effect |
|---|---|
| `push --last` | Show the last answer, with or without a diagram |
| `push --file notes.md` | Show a Markdown file |
| `push --stdin` | Show Markdown piped in on standard input |
| `push ... --zoom` | Also open the first diagram enlarged |
| `open` | Open the pane |
| `off` / `on` | Turn automatic display off or on for this cmux workspace |
| `doctor` | Check the installation |

In the pane, click a diagram to enlarge it, use **Source** to see the Mermaid text, and **Diagrams only** to hide the prose.

### Settings

| Environment variable | Effect |
|---|---|
| `VIZPANE_THEME=light` or `dark` | Force a theme instead of following the system. Codex inline pictures are dark unless this is `light` |
| `VIZPANE_HOME=/path` | Keep state somewhere other than `~/.local/state/vizpane` |
| `VIZPANE_INLINE=off` | Do not draw pictures inside Claude Code or Codex. Answers go to the pane again. For Codex it also starts Codex without the relay for that launch |

## Use with the figures plugin

For LaTeX math, D2, Graphviz and SVG, install [natsukium/claude-code-figures-plugin](https://github.com/natsukium/claude-code-figures-plugin). Without a setting, figures draws Mermaid with its built-in renderer and both plugins draw the same diagram. Set its `renderers` option to `mmdc`: figures then uses only mermaid-cli for Mermaid, and while `mmdc` is not installed it skips Mermaid blocks and leaves them to vizpane.

```bash
echo '{"renderers":"mmdc"}' | claude plugin configure figures@figures --values-stdin
```

## How it works

```text
 agent (TUI)                                       cmux browser pane
+---------------------------+                     +---------------------------+
| Claude Code / Codex       |                     | viewer.html (file://)     |
| answer: markdown + mermaid|                     | marked + DOMPurify        |
+-------------+-------------+                     | + Mermaid 12              |
              | Stop hook                         +-------------^-------------+
              v                                                 |
+---------------------------+   has a mermaid block?            |
| vizpane hook (Node)       |------ yes ---> write turn file ---+
| hands off, exits at once  |                then `cmux browser eval`
+---------------------------+------ no ----> store only
```

This is the path for Codex without the relay, and for `push`. In Claude Code the mod draws the picture and the Stop hook only stores the answer; see [docs/how-it-works.md](docs/how-it-works.md#inline-pictures-in-claude-code). With the Codex relay turned on, the hook renders the diagram and Codex draws it in its own transcript; see [docs/how-it-works.md](docs/how-it-works.md#inline-pictures-in-codex-experimental).

Without the Codex relay the hook passes the finished answer to a detached worker and returns immediately, so it never delays or fails a turn. With the relay the hook renders synchronously (up to about 7 seconds) and stores the answer itself, as described above. The worker stores the answer, and if it contains a diagram, tells the open viewer page to load it. Details are in [docs/how-it-works.md](docs/how-it-works.md).

## Security

Answers are treated as untrusted input. The inline renderer draws diagrams in an offscreen WebKit view with network loads blocked. The viewer sanitises HTML with DOMPurify, runs Mermaid at its strict security level, strips remote images and external references from rendered SVG, and never follows links. State is stored with owner-only permissions. See [SECURITY.md](SECURITY.md) for the threat model and how to report a problem.

## Limitations

- **The side pane needs cmux.** The pane is a cmux browser surface. Outside cmux, Codex answers are stored and nothing opens.
- **Claude Code has an extension point for pictures, Codex does not.** In Claude Code the picture is drawn by a mod. Codex has no such point, so vizpane runs Codex through a terminal relay, and only if you opt in. Without it, Codex pictures stay in the side pane.
- **Codex inline pictures are experimental and macOS plus cmux only.** They need the relay from `codex-inline`, the export line in your shell profile, and `swiftc` and `cc` from the Xcode Command Line Tools. If the relay dies, the prompt comes back at once but the terminal is not restored (type `reset`); Codex should end at its next write to its output or read of the terminal (inferred from its source and from stand-ins, not measured with a real Codex; an idle one may stay, so end a leftover one with `kill`), and `codex resume` continues the session.
- **Codex inline pictures are not kept.** They do not come back after `codex resume`, and they are freed when Codex exits (best effort; in no-alt-screen mode the scrollback keeps blank boxes). The end of a diagram turn is about a second later (at most about 7 seconds) while the hook renders the picture, which appears under the answer.
- **`bg` and `fg` with `stty tostop` leave Codex without raw mode.** In a shell with `stty tostop` set (not the macOS default), after Ctrl+Z, `bg` and `fg`, the relayed Codex comes back without raw mode: input is collected by line and the first Enter after `/quit` becomes a newline. Stock Codex does the same when `tostop` is off, because it does not retry an interrupted `tcsetattr` after a resume; the relay makes it happen with `tostop` on as well, since Codex's output is then no longer on its controlling terminal. Type `/quit` and press Enter twice, then `codex resume`. Ctrl+Z and `fg` without `bg` are not affected.
- **`/copy` can fail when Codex's native clipboard fails.** Codex copies through the macOS clipboard and uses an OSC 52 sequence only when that fails. With the relay that sequence can be cut by Codex's own screen text: copies of 1 KiB in about 1 of 9 to 3 of 4 tries, 4 KiB in 60% to 97%, never up to 300 bytes (cut rates, measured with Codex's write pattern; `test/relay-osc52.test.mjs` prints them). cmux's terminal then rejects the copy as invalid base64 in nearly every case, so the clipboard keeps what it held before, and Codex says "Copy unconfirmed". Treat that message as the cue to check the clipboard before you paste it into a shell: it may hold an older copy. A few cut copies (21 of 603 in one run) can leave a truncated copy. See [SECURITY.md](SECURITY.md).
- **Claude Code inline pictures need macOS, `swiftc` and an image-capable terminal.** Where they are missing, Claude Code shows the code block as before and the answer goes to the pane.
- **Inline pictures are diagrams only.** The renderer draws Mermaid and nothing else.
- **One pane per cmux workspace.** Every agent in the workspace shares it.
- **Mermaid is pinned** to the version in `plugins/vizpane/viewer/vendor/VERSIONS.json`.
- **Agents follow the diagram rules most of the time, not always.** The rules are instructions. A diagram that ignores them still renders as ordinary Mermaid.
- **Wide diagrams scroll.** Keep sequence diagrams to five participants; the guide tells agents the same.

## Development

```bash
node --test                           # unit and contract tests, no cmux needed
node scripts/e2e-cmux.mjs             # end-to-end, run inside a cmux terminal
npm run check:codex-inline            # Codex relay on screen, run in a spare cmux pane only
node scripts/vendor.mjs               # refresh the vendored browser libraries
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The viewer bundles Mermaid, marked and DOMPurify; their licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
