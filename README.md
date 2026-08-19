# pi-smart-plan

Plan mode with a mechanical write guard, plus a goal-scoped workflow that executes plans via parallel subagents — for the pi coding agent.

## What it is

`pi-smart-plan` gives pi a goal-scoped planning workflow:

- **Plan mode** couples a mechanical write guard to the plan lifecycle. While active, `edit`/`write` are blocked **unconditionally** — no path exceptions. The guard is engaged by the `plan_enter` tool and released only after the user confirms through the `plan_exit` dialog.
- **Goal-scoped workflow** writes a DAG-as-data plan into an extension-owned store **outside the repo**, derives execution waves, runs up to 4 parallel subagents per wave with disjoint `owns` and one writer per checkout, then a single delivery commit. One active goal per session, zero footprint in the repo.

## Install

```
pi install npm:@jnardiello/pi-smart-plan
# or from git:
pi install git:github.com/jnardiello/pi-smart-plan
```

Then run `/reload` to pick up the extension.

## Usage

- `/plan <goal>` — start the goal workflow (scoping, plan, approval, execution, delivery).
- `/plan-guard status|on|off` — control the mechanical write guard outside a plan.
- `plan_enter` / `plan_exit` tools — engage / release the write guard programmatically.
- `plan_save` — write (overwrite) the plan for a goal in the external store.
- `journal_append` — append timestamped lines to the goal journal (append-only).
- `plan_recall` — search the store for this repo's plans. Explicit-only: run it when the user asks about prior work on a topic. Returns content (plan + journal tail), never paths.
- `plan_complete` — move a goal to the `done/` portion of the store after its DoD passes.
- `ctrl+p` — toggle plan mode.
- `ask_smart_plan` tool — custom form, one tab per open decision (never structural categories like "Scope" or "DoD": the agent drafts that contract itself and presents it in the approval briefing). Right pane is a human briefing (`detail`) plus consequences of the highlighted option (`preview`). Long text scrolls with J/K or PgUp/PgDn. "None of these — I'll specify" opens an inline editor. Escape declines the form. Goals with no real fork skip the form entirely. No third-party extension required.

`/plan` injects the workflow into the session. This package is a pi extension, not a skill.

### IMPORTANT: remap ctrl+p

In pi 0.84.2 three built-in actions default to `ctrl+p` (`app.model.cycleForward`, `app.session.togglePath`, `app.models.toggleProvider`). Remap all of them in `~/.pi/agent/keybindings.json` to silence the startup conflict warning and free the key:

```json
{
  "app.model.cycleForward": "ctrl+alt+p",
  "app.session.togglePath": "alt+p",
  "app.models.toggleProvider": "alt+p"
}
```

`togglePath` and `toggleProvider` are scoped to the session/model selector overlays, so they can share `alt+p`.

## Artifacts layout

Plans and journals live in an extension-owned store outside the repo — the model never handles those paths; all I/O goes through the dedicated tools:

```
<agent-dir>/smart-plan/<repo>/<goal>/plan.md      # the single source of truth for WHAT (rewritable via plan_save)
<agent-dir>/smart-plan/<repo>/<goal>/journal.md   # append-only WHY/HOW IT WENT (via journal_append)
<agent-dir>/smart-plan/<repo>/done/<goal>/        # completed goals, moved here by plan_complete
```

`<agent-dir>` is pi's config directory (`~/.pi/agent` by default); `<repo>` is derived from the working directory, `<goal>` is the kebab-case slug. Position is the single source of truth for goal state: `plan_recall` lists exactly the active + done goals. Re-opening a completed goal happens automatically on the next `plan_save`, which moves it back to active. Never read the store with `read`/`bash` — use `plan_recall`.

> **Legacy note:** repos that already use an in-repo `backlog/` directory are not migrated; that directory and its history stay untouched.

## Commit policy (default)

Exactly one agent commit per goal — the final delivery commit (code + repo changes only, since plan/journal live outside the repo). There is **no approval commit**. Never push, never publish. Users who want different behavior should say so explicitly.

## Permissions

If you use `@gotgenes/pi-permission-system` (default `*` = ask), allow the extension tools or every call pauses on a y/n prompt:

```json
"ask_smart_plan": "allow",
"plan_enter": "allow",
"plan_exit": "allow",
"plan_save": "allow",
"journal_append": "allow",
"plan_recall": "allow",
"plan_complete": "allow"
```

The extension cannot flip that policy for you.

## Requirements

- pi 0.84.2+

## License

MIT
