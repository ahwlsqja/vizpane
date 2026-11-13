# Third-party notices

vizpane itself is released under the MIT License (see `LICENSE`).

The viewer ships unmodified distribution builds of the following libraries in `plugins/vizpane/viewer/vendor/`. The exact versions are recorded in `plugins/vizpane/viewer/vendor/VERSIONS.json`, and each library's licence text is in `plugins/vizpane/viewer/vendor/licenses/`. `scripts/vendor.mjs` downloads them from npm.

| Library | File | Licence | Source |
|---|---|---|---|
| Mermaid | `mermaid.min.js` | MIT | https://github.com/mermaid-js/mermaid |
| marked | `marked.umd.js` | MIT | https://github.com/markedjs/marked |
| DOMPurify | `purify.min.js` | Apache-2.0 or MPL-2.0 | https://github.com/cure53/DOMPurify |

## Libraries inside the Mermaid bundle

`mermaid.min.js` is the bundle published by the Mermaid project. It embeds other open-source libraries under their own licences. One of them is not under a permissive licence:

| Library | Licence | Source |
|---|---|---|
| elkjs (Eclipse Layout Kernel for JavaScript) | EPL-2.0 OR GPL-3.0-or-later | https://github.com/kieler/elkjs |

The source code of elkjs is available at the address above. vizpane does not modify it.

The other embedded libraries are listed, with their licences, in the `dependencies` of Mermaid's `package.json` for the version above.

## Inline pictures in Claude Code

The approach of drawing a picture under a reply with a Claude Code mod, and the arithmetic that turns a picture size into a box of terminal cells (`fitCells` in `plugins/vizpane/claude/inline-core.mjs`), follow [claude-code-figures-plugin](https://github.com/natsukium/claude-code-figures-plugin) by natsukium, licensed under Apache-2.0. vizpane contains no copy of its source files.
