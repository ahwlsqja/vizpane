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

## Inline pictures in Codex

The Codex relay, `plugins/vizpane/inline/relay-filter.h`, tracks the terminal's output the way the Ghostty terminal does, and the code is a port of parts of [Ghostty](https://github.com/ghostty-org/ghostty), licensed under the MIT License, Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors:

- the escape-sequence parser and its transition table (`src/terminal/parse_table.zig`, `src/terminal/Parser.zig`);
- the handling of UTF-8 in the ground state of the stream parser (`src/terminal/stream.zig`) and its decoder (`src/terminal/UTF8Decoder.zig`);
- the parsing of kitty graphics commands (`src/terminal/kitty/graphics_command.zig`) and the checks that decide whether a transmit loads an image;
- the SGR foreground-colour logic and the mode table, reduced to what the filter needs.

`plugins/vizpane/lib/diacritics.mjs` carries the list of row and column diacritics for Unicode placeholders (from `src/terminal/kitty/graphics_unicode.zig`, the list published in the kitty graphics protocol documentation); it has its own notice.

The UTF-8 decoder is Bjoern Hoehrmann's DFA ("Flexible and Economical UTF-8 Decoding", MIT License, Copyright (c) 2008-2010 Bjoern Hoehrmann), as used by Ghostty in `UTF8Decoder.zig`.

The licence texts, verbatim. They are also shipped in `plugins/vizpane/inline/LICENSES/`, next to the code.

Ghostty:

```text
MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Bjoern Hoehrmann's UTF-8 decoder:

```text
Bjoern Hoehrmann, "Flexible and Economical UTF-8 Decoding"
http://bjoern.hoehrmann.de/utf-8/decoder/dfa/

Copyright (c) 2008-2010 Bjoern Hoehrmann <bjoern@hoehrmann.de>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

An earlier design of the relay (a pseudo-terminal proxy with a separate session leader) was shaped by reading the source of [abduco](https://github.com/martanne/abduco) and [dtach](https://github.com/crigler/dtach). The relay no longer has that structure; it carries only Codex's output. They were structural references only; vizpane contains no code from either.

## Inline pictures in Claude Code

The approach of drawing a picture under a reply with a Claude Code mod, and the arithmetic that turns a picture size into a box of terminal cells (`fitCells` in `plugins/vizpane/claude/inline-core.mjs`), follow [claude-code-figures-plugin](https://github.com/natsukium/claude-code-figures-plugin) by natsukium, licensed under Apache-2.0. vizpane contains no copy of its source files. The Codex path uses the same cell arithmetic (it calls `fitCells`).
