---
name: viz
description: Show the last answer or a Markdown file in the vizpane side pane, open the pane, or turn automatic display off and on. Use when the user says things like "show that in the pane", "put it on vizpane", "open the diagram pane", "turn the diagram pane off", or invokes this skill directly.
---

# viz: control the vizpane side pane

vizpane shows an answer automatically only when it contains a Mermaid diagram. Use this skill to show an answer without a diagram, or to control the pane.

Run every command in this form:

```bash
node ~/.local/state/vizpane/bin/vizpane.mjs <command>
```

| To do | Command |
|---|---|
| Show the last answer | `push --last` |
| Show a Markdown file | `push --file <path.md> --title "Title"` |
| Show Markdown you pipe in | `push --stdin --title "Title"` |
| Open the pane | `open` |
| Turn automatic display off for this workspace | `off` |
| Turn it back on | `on` |
| Check the installation | `doctor` |

- If the user did not say what to do, run `push --last`.
- After running a command, report the result in one line.
- If `~/.local/state/vizpane/bin/vizpane.mjs` does not exist, vizpane has never run on this machine. Tell the user; do not work around it.
- If the user says a diagram answer did not appear in the pane, first check whether it was drawn inside the conversation instead (Codex with the vizpane relay turned on, Claude Code). If not, this session has no vizpane hook (it was started before vizpane was installed). Show the answer by piping the same Markdown to `push --stdin`, add `--agent codex` or `--agent claude`, and tell the user that restarting the session restores automatic display.
- These commands open the pane only inside cmux. Outside cmux the answer is stored and nothing opens.
