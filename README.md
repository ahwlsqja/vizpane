# vizpane

**Rendered Mermaid diagrams for Claude Code and Codex. Claude Code draws them inside the conversation; Codex shows them in a cmux pane next to the agent.**

[![test](https://github.com/ahwlsqja/vizpane/actions/workflows/test.yml/badge.svg)](https://github.com/ahwlsqja/vizpane/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform: macOS + cmux](https://img.shields.io/badge/platform-macOS%20%2B%20cmux-lightgrey.svg)](https://cmux.com)

[한국어](README.ko.md)

Terminal coding agents print Mermaid as source code. vizpane draws the diagram instead.

- **Claude Code:** the picture appears inside the conversation, directly under the answer, and the code block folds to one line. This uses a Claude Code mod and works in Ghostty-based terminals such as cmux, and in kitty.
- **Codex:** the answer is shown with the diagram drawn, in a browser pane inside [cmux](https://cmux.com), the moment the agent finishes its turn. Codex has no extension point for pictures in the conversation.

There is no server, no daemon and no tool call for the agent to make.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/sequence-dark.png">
  <img src="docs/images/sequence-light.png" alt="A Claude Code answer rendered by vizpane: a sequence diagram of Flink's two-phase commit to Kafka, with grouped participants, numbered steps and shaded phases, followed by the reading order and a table." width="820">
</picture>

## What it does

| | |
|---|---|
| **Automatic** | In Claude Code, a ` ```mermaid ` block is drawn under the answer. In Codex, an answer with such a block appears in the pane when the turn ends. Answers without a diagram stay out of the way, and you can show one in the pane on request. |
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

## Use

Ask the agent to explain something with a diagram. In Claude Code the picture appears under the answer; click **Enlarge** next to it to open the diagram enlarged in the side pane. In Codex the pane opens to the right of the terminal when the turn ends, without taking keyboard focus.

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
| `VIZPANE_THEME=light` or `dark` | Force a theme instead of following the system |
| `VIZPANE_HOME=/path` | Keep state somewhere other than `~/.local/state/vizpane` |
| `VIZPANE_INLINE=off` | Do not draw pictures inside Claude Code. Answers go to the pane again |

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

This is the path for Codex and for `push`. In Claude Code the mod draws the picture and the Stop hook only stores the answer; see [docs/how-it-works.md](docs/how-it-works.md#inline-pictures-in-claude-code).

The hook passes the finished answer to a detached worker and returns immediately, so it never delays or fails a turn. The worker stores the answer, and if it contains a diagram, tells the open viewer page to load it. Details are in [docs/how-it-works.md](docs/how-it-works.md).

## Security

Answers are treated as untrusted input. The inline renderer draws diagrams in an offscreen WebKit view with network loads blocked. The viewer sanitises HTML with DOMPurify, runs Mermaid at its strict security level, strips remote images and external references from rendered SVG, and never follows links. State is stored with owner-only permissions. See [SECURITY.md](SECURITY.md) for the threat model and how to report a problem.

## Limitations

- **The side pane needs cmux.** The pane is a cmux browser surface. Outside cmux, Codex answers are stored and nothing opens.
- **Inline pictures work in Claude Code only.** Claude Code has an extension point for drawing images in the conversation. Codex has none, so its pictures stay in the side pane.
- **Inline pictures need macOS, `swiftc` and an image-capable terminal.** Where they are missing, Claude Code shows the code block as before and the answer goes to the pane.
- **Inline pictures are diagrams only.** The renderer draws Mermaid and nothing else.
- **One pane per cmux workspace.** Every agent in the workspace shares it.
- **Mermaid is pinned** to the version in `plugins/vizpane/viewer/vendor/VERSIONS.json`.
- **Agents follow the diagram rules most of the time, not always.** The rules are instructions. A diagram that ignores them still renders as ordinary Mermaid.
- **Wide diagrams scroll.** Keep sequence diagrams to five participants; the guide tells agents the same.

## Development

```bash
node --test                           # unit and contract tests, no cmux needed
node scripts/e2e-cmux.mjs             # end-to-end, run inside a cmux terminal
node scripts/vendor.mjs               # refresh the vendored browser libraries
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The viewer bundles Mermaid, marked and DOMPurify; their licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
