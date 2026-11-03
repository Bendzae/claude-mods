# claude-mods

Ben's reusable Claude Code mods, as one plugin marketplace. Each mod is a
folder under `mods/` and an entry in `.claude-plugin/marketplace.json`.

## Mods

- **idea-queue**: a side panel for ideas you want done later, while a session
  is busy with something else. Type an idea and press Enter. Send one to the
  session on its own (`send ↗`), or let the session work through them all
  (`Work through all`), choosing the order itself and ticking each off. Edit
  an idea with `✎` (Enter saves). A
  session can also add ideas when asked to keep something for later. Kept
  per project across sessions; `/ideas` reopens the panel.

- **activity**: a side panel of what the session is doing. The main session
  and each of its subagents as a section of its own beside it (a subagent's
  own nested under it), each with its status, tool
  count, running time and current tool call; its task list with times; its
  shell commands, foreground and background, with the command and their last output lines (past ones folded, the oldest left out when the pane is full). Overall
  progress across tasks, shells and subagents, the turn's time and context
  fill on top. Click an agent or a shell to fold it; `clear finished` tidies
  up; `/activity` reopens the panel.

- **command-runner**: a Commands tab for shell commands you want to watch
  beside the chat. `/run-command <what to run>` asks the session to work out
  the command and start it there; its output streams into the tab, `[stop]`
  ends it (and whatever it started), `[kill]` if it won't. Click an earlier
  run to see its output again; scroll the output back, `[latest]` follows the
  newest again. The command passes your Bash permission rules
  first, asking when they would. It runs under a pseudo-terminal, so programs
  keep their colours, which the tab draws in your terminal's palette. Not a
  real terminal though: nothing interactive (input ends at once, pagers off).
  The session can read a run's status and last output lines when you ask.

## Installing

On this machine the marketplace is this folder, so sessions read the mods from
here directly. After editing one, run `/reload-plugins` in a session.

```
claude plugin marketplace add ~/code/claude-mods
claude plugin install idea-queue@claude-mods --scope user
claude plugin install activity@claude-mods --scope user
claude plugin install command-runner@claude-mods --scope user
```

On another machine, from GitHub (the repository is private, so `gh` or git
needs access to it):

```
/plugin install idea-queue --marketplace Bendzae/claude-mods
/plugin install activity --marketplace Bendzae/claude-mods
/plugin install command-runner --marketplace Bendzae/claude-mods
```

## Developing a mod

- Run a session with the mod loaded from its folder, reloading as you save:
  `claude --plugin-dir ~/code/claude-mods/mods/<mod>`. The engine then writes
  the API types to `<mod>/.claude-plugin/types/` (ignored by git), which the
  mod's `tsconfig.json` reads.
- `claude plugin validate mods/<mod>` checks the manifest and hooks module;
  `claude plugin test mods/<mod>` runs its tests.
- A new mod: a folder under `mods/` with `.claude-plugin/plugin.json` and
  `hooks/hooks.json` naming its hooks module, plus an entry in
  `.claude-plugin/marketplace.json`.
