# Security

## Threat model

An agent answer is untrusted input. It can contain text the agent fetched from the web, such as a page that includes HTML, scripts or image links. vizpane displays that answer in a browser pane, so the viewer must not let the content run code or make requests.

vizpane runs on your machine, as your user. It has no server and listens on no port. It does not defend against another process of the same user, which can read the state root directly.

## What the viewer does

- Converts Markdown with marked, then sanitises the HTML with DOMPurify before it is inserted into the page. Diagram source is read from the sanitised result.
- Removes tags that can load or run content: `style`, `link`, `base`, `meta`, `iframe`, `frame`, `object`, `embed`, `video`, `audio`, `source`, `track`, `picture`, `form`, `input`, `button`, `textarea`, `select`, `svg`, `math`. Removes the attributes `style`, `srcset`, `poster`, `background`, `ping`, `action`, `formaction`.
- Keeps images only as inline `data:image/png`, `jpeg`, `gif` or `webp` base64 URLs. Every other image is removed and shown as a text placeholder. `viz.blocked()` in the page counts what was removed.
- Renders Mermaid with `securityLevel: 'strict'`. A diagram's own `init` or front matter cannot change `securityLevel`, `theme`, `themeCSS`, `themeVariables` or the fonts.
- Parses the generated SVG in an inert document and removes external `image`, `img`, `use` and `feImage` references, `@import` rules and remote `url()` values before the SVG is inserted.
- Does not follow links. A click on a link in an answer is cancelled.
- Loads only local scripts: the bundled marked, DOMPurify and Mermaid, and turn files under `data/<workspace>/`. The workspace id is reduced to `A-Za-z0-9_-`, and a turn path must match `turns/turn-NNNN.js`.
- Writes turn files as JSON with `<` and the JavaScript line separators escaped, so answer text cannot close the script.

Content-Security-Policy: a `<meta>` Content-Security-Policy is not enforced for `file://` pages in the cmux browser (a remote image still loaded when one was set). The viewer therefore does not rely on one. It removes remote resources itself, as listed above.

## What the inline renderer does

In Claude Code, a small native helper (`viz-render`, built from `inline/render.swift`) renders Mermaid blocks of the answer to PNG files. Diagram source is untrusted, so the helper:

- Runs Mermaid in an offscreen WebKit view, in a separate helper process, with no Dock icon and no focus.
- Compiles a content rule list that blocks `http`, `https`, `ws` and `wss` loads before it opens the page. The page reads only local files under the state root.
- Uses Mermaid's strict security level, and a `secure` list so that a diagram's own `init` or front matter cannot change the security level, theme, `themeCSS`, `themeVariables` or fonts.
- Stops after 15 seconds.
- Passes the source as a file argument. No shell parses it.

The helper is built on your machine with `swiftc` from `inline/render.swift`; no binary is downloaded. With `--cell` it opens a terminal read-only, only to read its size: the controlling terminal of a parent process, or the tty path it is given (the Codex hook passes the pane's terminal).

Pictures and their size files are cached in `<state root>/inline/cache/` for 7 days (the Claude Code mod prunes at session start, and the Codex hook prunes after each answer it draws). They contain what the diagrams show. Set `VIZPANE_INLINE=off` to turn the inline path off, for Claude Code and for the Codex relay.

## What the Codex relay does

The optional Codex relay (`inline/relay.c`, started through `CMUX_CUSTOM_CODEX_PATH`, experimental) carries Codex's output for the whole session, so it sees every byte Codex prints. It does not see your keys: they go from the terminal straight to Codex. The relay never reads from the terminal; it writes through its own write-only descriptor and leaves the shell's descriptors (0 to 2, still open read-write) unread. That is a property of the code, not of the descriptor's type, so a change that read one of them would break this promise without anything stopping it. What it does:

- **Copies Codex's output unchanged.** Codex's stdout (and its stderr, when that was the terminal) is a pseudo-terminal that only the relay reads, and the relay writes the bytes to the terminal in order. Nothing is removed or reordered.
- **Never reads input, never touches terminal modes.** Codex keeps the terminal as its stdin, its raw mode, its window size and its job control. The relay never reads the terminal, never changes its termios and never moves a process between process groups.
- **Inserts two kinds of command, no more.** A kitty graphics transmit that loads a PNG from the session directory, and a delete for an image it loaded. Both are built from validated integers (an image id between 0x100000 and 0x7FFFFF, the box size) and the relay's own paths. Nothing from Codex's output or from an answer is copied into them.
- **Never asks the terminal anything.** Both commands use `q=2`, so the terminal sends no reply. There are no queries, and nothing arrives that could be mistaken for input.
- **Reads only the session directory.** Before a transmit it checks that the PNG is a regular file in that directory, not a symlink, within size and dimension limits, and keeps the memory it asks the terminal to hold under a budget.
- **Closes its descriptors on exec.** Its files and pipes are `CLOEXEC`, so Codex and its tools do not inherit them. The only things Codex inherits are the session directory path and the pane's terminal name, in `VIZPANE_INLINE_DIR` and `VIZPANE_TTY` (the hook reads the window size there), and the relay's pseudo-terminal as its stdout, and as its stderr when that was the terminal.
- **Keeps the session directory private.** `<state root>/inline/sessions/s1-<pid>-<random>/` is created with mode 0700 and deleted when the session ends. Directories left behind by a relay that was killed are removed by the next relay.
- **Makes no network requests and starts no process other than Codex.**

The relay cannot protect against a process of the same user, and a relay is code on the path of everything Codex prints (about 2,900 lines of C, including the output filter). That is why it is opt-in. Caveats:

- A tool run by Codex is a process of the same user, inherits `VIZPANE_INLINE_DIR`, and can read the pictures in the session directory or put files there. A picture it adds is drawn only where an answer prints the matching placeholder.
- A same-user tool could replace a file in the session directory with a FIFO. The terminal side opens the file after the relay's checks, so a FIFO can stall the pane until it is closed. This is a denial of service by a process that already runs as you, not an escalation.
- Whatever still holds the relay's pseudo-terminal when the relay's child has exited loses it when the relay exits: its writes fail with EIO, where in stock Codex they would still reach your terminal. That is a process Codex leaves behind, and also the program itself when it runs behind a launcher that forks (the stock npm or pnpm `codex` script is a `/bin/sh` script that starts node) and the launcher dies first, for example when the whole foreground job gets SIGTERM and the program restores its terminal on that signal. Codex 0.169.0 installs no SIGTERM or SIGHUP handler in its TUI, so this is not reachable through `kill` today; a custom `VIZPANE_REAL_CODEX` or a later Codex could reach it.
- A signal sent to the whole process group (the terminal's SIGINT and SIGQUIT, the shell's kill of a job) reaches the child twice, once from the kernel and once forwarded by the relay. Codex is unaffected; a program that counts signals ("second Ctrl+C forces quit") and is the relay's direct child would count two.
- If the relay is killed (SIGKILL, or a fault signal such as SIGABRT or SIGSEGV sent to it; it catches the other terminating signals), the shell gets the terminal back at once. Nothing restores the terminal then: type `reset`, as after `kill -9` of stock Codex. Codex's output has no reader any more, so Codex should end the next time it writes to it or reads the terminal; both fail with an I/O error. That is inferred from Codex's source and from stand-in programs, not measured with a real Codex. With a real zsh, a stand-in that reads ended within about 25 ms and one that writes every second ended at its next write, but one that only waits for events and never writes was still running, idle, after 8 seconds. A Codex that is idle between turns may behave like that last one: end a leftover one with `kill`. `codex resume` continues the session.
- A program that writes to the terminal directly (Codex's OSC 52 clipboard fallback, an editor that opens `/dev/tty`) is not behind the relay. The relay writes in chunks of normally at most 512 bytes (768 to reach a safe cut point), and only when at most 256 bytes of the terminal's 1,024-byte queue are in use, which normally leaves room for 256 more. That is measured, not guaranteed by construction: in the tests a write of up to 256 bytes was never cut, and 300 bytes was not either in the OSC 52 measurement. A larger one can be cut by a chunk, and stock Codex never cuts its own, because it writes its frame and the copy from one thread.
- **A clipboard copy can be cut, and then fails.** Codex copies through the macOS clipboard and uses OSC 52 only when that fails; over SSH, in tmux and under Herdr it writes OSC 52 on every copy, and the relay does not engage there. When the fallback is used, the copy goes to the terminal directly while Codex's frame goes through the relay, so a relayed chunk can land inside it. Measured with Codex's write pattern against the real relay (200 copies per setting, `test/relay-osc52.test.mjs` prints the rates): copies of 1 KiB were cut in about 1 of 9 to 3 of 4 tries, depending on how fast the terminal reads (11% to 77%), and copies of 4 KiB in 60% to 98%. Those are cut rates, not clipboard outcomes. cmux's terminal accepts a clipboard copy only if what it collected is well-formed base64, and a cut copy hardly ever is, so the clipboard keeps what it held before and Codex says "Copy unconfirmed". In one measured run of 603 cut copies, 582 would have been dropped that way, 21 would have left a truncated copy (a prefix that happened to end on a multiple of 4 characters) and none had screen text decoded into it. In principle a cut copy whose bytes happen to form valid base64 could carry screen bytes; that was not seen. The practical risk is therefore a stale clipboard: **when Codex says "Copy unconfirmed", check the clipboard before you paste it into a shell** (paste into an editor first), because it may still hold an older command. Leave the relay off if the native clipboard is unreliable on your machine and you copy long text often. The relay cannot prevent this; only Codex writing the copy another way would. In the live run (Codex 0.169.0, cmux 0.64.22) every `/copy` used the native clipboard, so the fallback did not occur.
- In rare cases a picture stays in cmux's memory after Codex exits, until the pane closes. It is bounded: at most 96 MiB per screen for each session, and cmux's image-storage-limit (320 MB by default) caps the pane.
- The relay mimics how the terminal's parser reads output. If cmux changes that, an insertion can land in the wrong place: a picture can break, but text is not lost. Re-check after updating cmux.

## What is stored

| Where | What | Mode |
|---|---|---|
| `~/.local/state/vizpane/data/<workspace>/turns/` | The 30 newest diagram answers of the workspace, in full | 0600 (directories 0700) |
| `~/.local/state/vizpane/data/<workspace>/last/` | The latest answer of each session, with or without a diagram. Written even when auto push is off. Not pruned | 0600 |
| `~/.local/state/vizpane/inline/cache/` | Diagram sources, rendered PNG pictures and size files, deleted after 7 days (pruned by the Claude Code mod at session start and by the Codex hook after each drawn answer) | Default file mode, inside the 0700 state root |
| `~/.local/state/vizpane/inline/sessions/` | One directory per Codex session in the relay: the pictures of its answers (hard-linked or copied from the cache) and a few marker files. Deleted when the relay exits, or by the next relay if it was killed | 0700 directory (the pictures are hard links of cache files and keep their mode) |
| `~/.local/state/vizpane/relay/codex` | The relay binary and its `.stamp` file, built on your machine from `inline/relay.c` | 0700 directory |
| `~/.local/state/vizpane/jobs/` | The hook payload until the worker reads it, then deleted | 0600 |
| `~/.local/state/vizpane/vizpane.log` | Workspace id, turn id, action and error messages. No answer text | 0600 |

`VIZPANE_HOME` moves the state root. To remove stored answers, delete the `data` directory.

## What the hook can and cannot do

The hook reads the agent's Stop payload from stdin. It writes files under the state root and runs the `cmux` command with `execFile`, so no shell parses the arguments. It always exits 0 and does not change what the agent does next: Claude Code gets no output, Codex gets `{"continue":true}`, or inside the relay the same with a `systemMessage` that carries the picture.

The hook and viewer code make no network requests. The hook does not edit your agent configuration, does not read files other than its own payload and the state root, and sends nothing to a remote service. `vizpane push --file` reads the one file you name.

The only process the hook starts, other than `cmux`, is its own detached worker. In Codex inside the relay the hook instead renders synchronously, with the renderer described above, and returns the picture as a `systemMessage`; it starts only the renderer then, and the detached worker too when it gives up after rendering and the answer goes to the side pane.

## Dependencies

There are no runtime dependencies. The viewer bundles Mermaid, marked and DOMPurify; the pinned versions are in `plugins/vizpane/viewer/vendor/VERSIONS.json` and are installed by `node scripts/vendor.mjs`. A vulnerability in one of them is handled by updating the pin.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Do not open a public issue for a vulnerability.

Include the vizpane version (`cat ~/.local/state/vizpane/VERSION`), the steps to reproduce, and the answer or diagram source that triggers it. Reports are handled on a best-effort basis.
