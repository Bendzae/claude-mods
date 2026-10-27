# claude-mods

Ben's reusable Claude Code mods, as one plugin marketplace. Each mod is a
folder under `mods/` and an entry in `.claude-plugin/marketplace.json`.

## Mods

- **idea-queue**: a side panel for ideas you want done later, while a session
  is busy with something else. Type an idea and press Enter. Send one to the
  session on its own (`send ↗`), or let the session work through them all
  (`Work through all`), choosing the order itself and ticking each off. A
  session can also add ideas when asked to keep something for later. Kept
  per project across sessions; `/ideas` reopens the panel.

- **activity**: a side panel of what the session is doing. The main session
  and each subagent (nested under whoever started it) with its status, tool
  count, running time and current tool call; its task list with times; its
  background shells with the command and their last output lines. Overall
  progress across tasks, shells and subagents, the turn's time and context
  fill on top. Click an agent or a shell to fold it; `clear finished` tidies
  up; `/activity` reopens the panel.

## Installing

On this machine the marketplace is this folder, so sessions read the mods from
here directly. After editing one, run `/reload-plugins` in a session.

```
claude plugin marketplace add ~/code/claude-mods
claude plugin install idea-queue@claude-mods --scope user
claude plugin install activity@claude-mods --scope user
```

On another machine, from GitHub (the repository is private, so `gh` or git
needs access to it):

```
/plugin install idea-queue --marketplace Bendzae/claude-mods
/plugin install activity --marketplace Bendzae/claude-mods
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
