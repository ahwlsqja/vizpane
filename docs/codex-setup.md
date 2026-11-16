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

In a cmux workspace with vizpane, a ```mermaid code block in an answer is rendered as a picture, in the pane next to the terminal or, when the vizpane Codex relay is enabled, inside the conversation.

Add a Mermaid diagram when an explanation involves three or more relations, branches, boundaries or time-ordered steps. Draw only what has been verified. Rules and examples are in the viz-style skill.

Write the diagram body in the plain subset. For flowchart use the TB direction: id["label"], id{"decision"}, id(["end"]), -->, -.->, -->|"label"|. For sequenceDiagram use: participant/actor ID as Label, ->>, -->>, --x, Note over, alt/else/loop/opt. Do not use subgraph, class, style, ==>, autonumber, box or rect.

Write shape, colour and grouping as comment lines above the node declarations. flowchart: %% viz: stream|store|table|proc|decide|fail|ok|ext <id...> and %% viz: bronze|silver|gold|group <id...> as Title. sequenceDiagram: %% viz: queue|database|control <id...>, %% viz: box <id...> as Title, and %% viz: phase ... %% viz: end around a phase. In <id...> write the declared identifier, not the label (for participant K as Kafka, write K).

An answer without a diagram is not shown automatically. If the user asks to show the previous answer in the pane, use the viz skill.

If the user says a diagram did not appear in the pane, this session has no vizpane hook (it was started before vizpane was installed). Until the session is restarted, show each diagram answer yourself by piping the same Markdown to: node ~/.local/state/vizpane/bin/vizpane.mjs push --stdin --agent codex --title "<short title>"
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

## Inline pictures (experimental)

By default a Codex answer with a diagram opens in the side pane. With the experimental relay the picture is drawn inside the Codex conversation, under Codex's hook line. It is opt-in. Without the export line below, the only change is the Stop hook's new status line ("Rendering diagram", shown briefly at the end of every turn while the hook runs, also when nothing is drawn), which needs re-approval in `/hooks` unless cmux starts Codex with hook trust bypassed (it does, unless you installed cmux's hooks permanently with `cmux hooks codex install` or set `CMUX_CODEX_HOOKS_DISABLED=1`).

### Requirements

- macOS and cmux. The current build was run live with cmux 0.64.22 and Codex 0.169.0 for job control (Ctrl+Z, `bg`, `fg` and `kill %1`, with and without `stty tostop`) and one diagram turn. Pictures (one, six, a tall one), PageUp and PageDown, Ctrl+G with vi, resizing while Codex streams, `/quit`, `codex resume` and `VIZPANE_INLINE=off` were run live on an earlier build whose output path is the same. The facts it relies on about how Codex handles the terminal (which descriptors it writes to, who reads input, its suspend and exit order, how it copies) were checked in the Codex 0.169.0 source, and earlier in 0.167.2; none of them changed between the two. Codex and cmux can change any of this in a later release, so check again after updating either one: run `npm run check:codex-inline` in a spare pane first. The relay uses the `CMUX_CUSTOM_CODEX_PATH` setting of cmux's Codex wrapper, so it only works for Codex started in a cmux pane.
- The Xcode Command Line Tools (`xcode-select --install`). `swiftc` builds the renderer and `cc` builds the relay.
- The plugin installed and the Stop hook approved, as above.

### Set up

```sh
node ~/.local/state/vizpane/bin/vizpane.mjs codex-inline
```

The command copies the app files, builds the renderer and the relay, checks which Codex the relay would run, and prints one line:

```sh
export CMUX_CUSTOM_CODEX_PATH="$HOME/.local/state/vizpane/relay/codex"
```

Add that line to your shell profile (for example `~/.zshrc`) yourself. vizpane never edits dotfiles. Open a new cmux pane and start `codex` or `codex resume` as usual. After a vizpane update, run the command again: it rebuilds the relay (running sessions keep the old one) and the renderer, and until you do, Codex answers go back to the side pane without a message.

If `CMUX_CUSTOM_CODEX_PATH` is already set (a company build of Codex, a launcher script), the export line replaces it, and the relay would run the first `codex` on your `PATH` instead. `codex-inline` and `doctor` warn when that is the case. To keep running your own, export the old value as well, after the line above: `export VIZPANE_REAL_CODEX="<the old value>"`.

### Check it

```sh
node ~/.local/state/vizpane/bin/vizpane.mjs doctor
```

The last lines say whether the relay is built, whether `CMUX_CUSTOM_CODEX_PATH` points to it, and which Codex it would run. These lines never make `doctor` fail.

To see a picture drawn without a model call, run this from a clone of the repository, in a spare cmux pane:

```sh
npm run check:codex-inline
```

It takes over the pane for about 15 seconds, runs a test program through a temporary relay and draws four coloured quadrants. Afterwards it shows two blocks on the alternate screen: the placeholder cells of the relay's picture, which must be blank, and a control picture that the script loads itself, which must show four quadrants. Whether they do is for you to look at; the script cannot read what the terminal drew, and a blank first block only means something when the control showed. It refuses to run outside cmux. Do not run it in a pane that holds a live agent session.

### What changes

- The relay is the pane's foreground process. Codex's output passes through it unchanged, apart from each picture's data, which is added once at a safe point. Your keys go to Codex directly: the terminal, its modes and its size stay with Codex and your shell. Job control is meant to behave as without the relay, except for the known difference below: Ctrl+Z stops Codex and the relay together, `fg` and `bg` continue them, and `kill %1` ends the job and leaves no process behind. The relay follows what Codex does here; it does not decide it. A signal sent to the whole job (Ctrl+C, `kill %1`) also reaches the program a second time, forwarded by the relay; Codex behind its launcher script is not affected, but a program that counts signals and is run directly as the relay's child would count two.
- A tall diagram stays within one screen in Codex (the terminal height less 6 rows), so its text can get small. Claude Code lets such a picture grow to two screens instead. To see it large, run `vizpane push --last`: the side pane shows the answer, and clicking a diagram enlarges it.
- Known difference, `bg` and `fg` with `stty tostop`: after Ctrl+Z, `bg` and `fg` in a shell with `stty tostop` set (not the macOS default), the relayed Codex comes back without raw mode. Its input is collected by line, so the first Enter after `/quit` becomes a newline, and the terminal's answer to Codex's exit query is printed in the shell. Why: on resume Codex writes its screen modes to stdout and then calls `tcsetattr` to enter raw mode, and does not retry when that call is interrupted (Codex 0.169.0, read in its source). Stock Codex is stopped by `tostop` at the write, so its `tcsetattr` runs in the foreground and succeeds; behind the relay the write goes to the relay's pseudo-terminal, which is not Codex's controlling terminal, so Codex is stopped only at the `tcsetattr`. That is what stock Codex does without `tostop` (the macOS default). The relay cannot fix this without racing Codex. What to do: type `/quit`, press Enter twice, and run `codex resume`. Ctrl+Z and `fg` without `bg` should not be affected, because `fg` puts Codex back in the foreground before it sets raw mode (read in the source, not tested). `test/relay-pty.test.mjs` (P5g) pins this behaviour with a stand-in that follows Codex's order; if Codex is fixed, turn that test around.
- If the relay dies (SIGKILL, a fault signal such as SIGABRT or SIGSEGV sent to it, or a bug), your shell prompt comes back at once and nothing restores the terminal: type `reset` if it looks wrong. Codex's output then has no reader, so Codex should end the next time it writes to its output or reads the terminal; both fail with an I/O error. That part is inferred from Codex's source and from stand-in programs, not measured with a real Codex. With a real zsh, a stand-in that reads ended within about 25 ms, one that writes every second ended at its next write (within about 0.5 s), and one that only waits for events and never writes was still alive, idle, after 8 s. A real Codex that is idle between turns may behave like the last one. If `ps` shows a Codex left over after a relay died, end it with `kill`. `codex resume <session id>` continues the conversation.
- Output written after the launcher has ended is dropped. The stock `codex` is a `/bin/sh` script that starts node, which runs the native Codex. The relay ends when that launcher has ended and its output is drained, and then closes the pseudo-terminal. A program behind the launcher that is still writing then gets an I/O error, where in stock its writes would still reach the terminal. With Codex 0.169.0 this is not reachable through `kill` (its TUI installs no SIGTERM or SIGHUP handler); a custom `VIZPANE_REAL_CODEX` or a later Codex that restores its terminal on SIGTERM could reach it.
- Known limits: after a resize the relay sends up to three more redraw signals (40, 160 and 520 ms after the last size change), so Codex redraws a few extra times and a program that reads the size from stdout (vim) may draw once at the old size before it catches up; and the clipboard limit in the next section. See [how it works](how-it-works.md#failure-handling).
- Codex shows the answer as it streams. When the turn ends, the hook renders the diagram and the picture appears under the answer: the end of the turn is about a second later for a new diagram (the Stop hook's status line reads "Rendering diagram"), at most about 7 seconds when rendering is slow, and almost nothing for one that was drawn before. If no diagram can be drawn in time, or the pane is too small, the answer goes to the side pane as before. A diagram of several that cannot be drawn is left out and counted in the caption ("and N more").
- At most six diagrams per answer are drawn; the caption says how many were left out. `vizpane push --last` shows them all in the side pane. When the hook returns pictures for an answer, that answer is not also pushed to the pane.
- Pictures are not restored after `codex resume`, and they are freed when Codex exits (best effort; in rare cases a picture stays in cmux until the pane closes). With `--no-alt-screen` or `tui.alternate_screen = never` the pictures are in the shell's scrollback, where they turn into blank boxes when Codex exits, and very old pictures are evicted: the relay keeps at most 256 images and 96 MiB per screen and deletes the least recently seen one. The text of the answer is unaffected.
- If two diagram turns in a row are not drawn (for example because you scrolled past them), the session switches to the side pane for the rest of its life.
- Codex asks you to approve the vizpane hook again in `/hooks` after an update. Codex 0.169.0 checks this in its source: it fingerprints every file of the plugin directory and the hook's declaration (which the "Rendering diagram" status line of 0.4.0 changed), and before each run it refuses a hook whose plugin changed since you approved it. So any update needs the approval, not only this one. cmux starts Codex with hook trust bypassed, which skips the check (not when `cmux hooks codex install` installed all of cmux's handlers, or `CMUX_CODEX_HOOKS_DISABLED=1` is set). The `/hooks` screen was not opened in this check; the statement comes from the source.
- Pictures are dark unless `VIZPANE_THEME=light` is set; they do not follow the terminal's theme.

### Clipboard copies can be cut, and then fail (only when Codex's native clipboard fails)

On macOS, Codex's `/copy` and Ctrl+O write to the system clipboard directly. Only when that fails does Codex fall back to sending the text to the terminal as an OSC 52 sequence (under tmux, Herdr and SSH it sends one every time, which is why the relay does not engage there). That sequence goes to the terminal on its own path, while the text of Codex's screen goes through the relay, so the relay's output can land in the middle of it. Stock Codex writes both from one thread and never mixes them.

Measured with Codex's write pattern (a 40-row frame, then one OSC 52, from one thread, 200 rounds per setting) against the real relay, with a terminal that reads fast and ones that read slowly (`test/relay-osc52.test.mjs` prints these numbers):

| Copy size | Cut by the relay (cut rate, not clipboard outcome) |
|---|---|
| 256 and 300 bytes | rarely (none in our local runs; one 256-byte copy in a CI run on a slower machine) |
| 1 KiB | about 1 in 9 to 3 in 4 tries (11% to 77% in our runs, depending on how fast the terminal reads) |
| 4 KiB | about 60% to 98% |

When a copy is cut, cmux's terminal accepts a clipboard copy only if what it collected is well-formed base64, and a cut copy hardly ever is, so the clipboard keeps what it held before and Codex says "Copy unconfirmed". In one measured run of 603 cut copies, 582 would have been dropped that way, 21 would have left a truncated copy (a prefix that happened to end on a multiple of 4 characters) and none had screen text decoded into it. In principle a cut copy whose bytes happen to form valid base64 could carry screen bytes; that was not seen.

What to do: when Codex says "Copy unconfirmed" after a `/copy` or Ctrl+O, check the clipboard before you paste it into a shell: paste into an editor or into the Codex composer first, because it may still hold an older copy, for example a command. `/export` saves the chat. If the native clipboard is unreliable on your machine and you copy long text often, leave the relay off. In the live run on Codex 0.169.0 every `/copy` took the native path, so this did not show; it is a known limit, accepted because it needs the native copy to fail first, and it is why the number is here. Run the measurement test again after any change to how the relay writes, to refresh these numbers.

### Cost

Measured on the development Mac. Where a number was not measured it says so.

- Code: about 2,900 lines of C on Codex's output path (`inline/relay.c` about 1,300 lines and `inline/relay-filter.h` about 1,640), about 650 lines of new JavaScript (`codex-inline.mjs`, `diacritics.mjs`, the check script), and tests that are larger than both.
- Processes and memory: one extra process per Codex session (the relay, an 88 KB binary) and about 1.5 MB of resident memory (1,488 KB, measured with a stand-in for Codex, not with a real session).
- CPU: while paging through a long answer with PageUp and PageDown for 60 seconds, the relay used about 0.9 s of CPU (about 1.5%) and Codex itself about 1.2 s. There is no measurement of stock Codex doing the same.
- Output speed: 5 MiB of output took 82 to 135 ms through the relay (40 to 63 MB/s) against 36 to 42 ms without it (about 125 MB/s), so bulk output is two to three times slower. Codex prints far less than that. Keys do not go through the relay, so typing is not slowed by it.
- End of a turn: for a diagram that was not drawn before, the turn ends 0.6 to 1.3 s later (measured live); the budget is 7 s and the hook's own timeout is 10 s.
- Codex's output can be up to about 2.5 KB ahead of what the pane shows.

The relay engages only when none of its checks says no. It runs Codex directly, without a relay, when Codex is not in a cmux pane (`TERM_PROGRAM` is not `ghostty`, or `CMUX_SURFACE_ID` is missing), when stdin and stdout are not the same terminal, when the job is not in the foreground, when it is already inside a relay (`VIZPANE_INLINE_DIR` is set), for `-V` and `--version`, in tmux (`TMUX`, `TMUX_PANE`), zellij or GNU screen (`STY`, or a `TERM` that starts with `screen` or `tmux`), over SSH (`SSH_CONNECTION`, `SSH_TTY`), under Herdr (`HERDR_ENV=1`), in a Vim, Neovim, Emacs or JetBrains terminal (`VIM_TERMINAL`, `NVIM`, `INSIDE_EMACS`, `TERMINAL_EMULATOR`), with `NO_COLOR` set, for subcommands such as `exec`, `review` or `login`, for `--help`, and when it was started by a Codex tool. That is a list of cases it knows: another terminal emulator or byte-pipe multiplexer inside a cmux pane that is not on it still inherits the cmux variables and may engage the relay and show stray characters. Use `VIZPANE_INLINE=off` there.

### Turn it off

- For one launch: `VIZPANE_INLINE=off codex` starts that one Codex without the relay. Exported in your profile, the same variable also turns off inline pictures in Claude Code.
- For good: delete the `export CMUX_CUSTOM_CODEX_PATH=...` line from your shell profile and open a new pane. You can also delete `~/.local/state/vizpane/relay/codex`, and the next pane starts stock Codex.
- `vizpane off` stops pictures (inline and in the side pane) for the workspace; Codex still runs through the relay. To take the relay out, use `VIZPANE_INLINE=off` or delete the export line.

### Uninstall

Delete the export line (and the `VIZPANE_REAL_CODEX` line, if you added one), then remove `~/.local/state/vizpane/relay/` and `~/.local/state/vizpane/inline/sessions/`. Nothing else was changed outside the state root.

## Sessions that were already running

Codex loads plugin hooks when a session starts. A session that was running before you installed vizpane has no Stop hook, so its answers never reach the pane and nothing is written to the log.

Restart the session to fix it. `codex resume <session id>` continues the same conversation with the hook loaded.

If you cannot restart yet, the agent can show an answer itself. The AGENTS.md block above tells it how:

```sh
node ~/.local/state/vizpane/bin/vizpane.mjs push --stdin --agent codex --title "Checkout flow" <<'MD'
...the answer, including its mermaid block...
MD
```
