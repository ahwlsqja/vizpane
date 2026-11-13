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

The helper is built on your machine with `swiftc` from `inline/render.swift`; no binary is downloaded. With `--cell` it opens the controlling terminal of a parent process read-only, only to read its size.

Pictures and their size files are cached in `<state root>/inline/cache/` for 7 days. They contain what the diagrams show. Set `VIZPANE_INLINE=off` to turn the inline path off.

## What is stored

| Where | What | Mode |
|---|---|---|
| `~/.local/state/vizpane/data/<workspace>/turns/` | The 30 newest diagram answers of the workspace, in full | 0600 (directories 0700) |
| `~/.local/state/vizpane/data/<workspace>/last/` | The latest answer of each session, with or without a diagram. Written even when auto push is off. Not pruned | 0600 |
| `~/.local/state/vizpane/inline/cache/` | Diagram sources, rendered PNG pictures and size files, deleted after 7 days | Default file mode, inside the 0700 state root |
| `~/.local/state/vizpane/jobs/` | The hook payload until the worker reads it, then deleted | 0600 |
| `~/.local/state/vizpane/vizpane.log` | Workspace id, turn id, action and error messages. No answer text | 0600 |

`VIZPANE_HOME` moves the state root. To remove stored answers, delete the `data` directory.

## What the hook can and cannot do

The hook reads the agent's Stop payload from stdin. It writes files under the state root and runs the `cmux` command with `execFile`, so no shell parses the arguments. It always exits 0 and does not change what the agent does next: Claude Code gets no output, Codex gets `{"continue":true}`.

The hook and viewer code make no network requests. The hook does not edit your agent configuration, does not read files other than its own payload and the state root, and sends nothing to a remote service. `vizpane push --file` reads the one file you name.

The only process the hook starts, other than `cmux`, is its own detached worker.

## Dependencies

There are no runtime dependencies. The viewer bundles Mermaid, marked and DOMPurify; the pinned versions are in `plugins/vizpane/viewer/vendor/VERSIONS.json` and are installed by `node scripts/vendor.mjs`. A vulnerability in one of them is handled by updating the pin.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab and choose "Report a vulnerability". Do not open a public issue for a vulnerability.

Include the vizpane version (`cat ~/.local/state/vizpane/VERSION`), the steps to reproduce, and the answer or diagram source that triggers it. Reports are handled on a best-effort basis.
