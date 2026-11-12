# Codex setup

## Install

```sh
codex plugin marketplace add ahwlsqja/vizpane
codex plugin add vizpane@vizpane
```

The plugin registers a Stop hook and the `viz` and `viz-style` skills. The CLI is copied to `~/.local/state/vizpane/bin/vizpane.mjs` the first time a diagram answer is pushed, or when you run `vizpane.mjs sync` from the plugin directory.

## Approve the hook

Codex runs a plugin hook only after you have approved it.

1. Start Codex and open `/hooks`.
2. Find the vizpane Stop hook and approve it. You do this once.

Until the hook is approved, Codex skips it and nothing reaches the viewer. If Codex is started with hook trust bypassed, no approval is needed. The Codex wrapper in cmux 0.64 starts Codex that way.

## Add the diagram rules to AGENTS.md

The Claude Code plugin adds the diagram-writing rules to each session through a SessionStart hook. The Codex plugin does not. Without the rules, Codex may skip the `%% viz:` comments or use syntax outside the plain subset, and it may not open the `viz-style` skill on its own.

Add this block to `~/.codex/AGENTS.md`:

````markdown
## vizpane

In a cmux workspace with vizpane, a ```mermaid code block in an answer is rendered as a picture in the pane next to the terminal.

Add a Mermaid diagram when an explanation involves three or more relations, branches, boundaries or time-ordered steps. Draw only what has been verified. Rules and examples are in the viz-style skill.

Write the diagram body in the plain subset. For flowchart use the TB direction: id["label"], id{"decision"}, id(["end"]), -->, -.->, -->|"label"|. For sequenceDiagram use: participant/actor ID as Label, ->>, -->>, --x, Note over, alt/else/loop/opt. Do not use subgraph, class, style, ==>, autonumber, box or rect.

Write shape, colour and grouping as comment lines above the node declarations. flowchart: %% viz: stream|store|table|proc|decide|fail|ok|ext <id...> and %% viz: bronze|silver|gold|group <id...> as Title. sequenceDiagram: %% viz: queue|database|control <id...>, %% viz: box <id...> as Title, and %% viz: phase ... %% viz: end around a phase. In <id...> write the declared identifier, not the label (for participant K as Kafka, write K).

An answer without a diagram is not shown automatically. If the user asks to show the previous answer in the pane, use the viz skill.
````

The block is the same rule set that the Claude Code session context carries, without the terminology paragraph.

### Optional: terminology rule for Korean

The Claude Code context also tells the agent how to word Korean answers. Add this paragraph to the block if you write in Korean:

```text
용어는 한국 엔지니어가 실무에서 쓰는 말로 쓴다. 영어 원어로 통하는 기술 용어(offset, checkpoint, backpressure, replication slot, threshold 등)는 번역하지 않고, 한국어로 굳은 말(적재, 배포, 장애, 재처리, 모니터링, 알림, 백필)은 그대로 쓴다. 역압력·논리 디코딩·감시·경보 같은 직역과 번역투 문장은 쓰지 않는다.
```

## Check

Run a turn that ends with a Mermaid block inside a cmux terminal. The viewer opens to the right. If it does not, run:

```sh
node ~/.local/state/vizpane/bin/vizpane.mjs doctor
```

and read `~/.local/state/vizpane/vizpane.log`.
