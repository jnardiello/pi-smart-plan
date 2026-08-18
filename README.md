# pi-smart-plan

Plan mode with a mechanical write guard, plus a goal-scoped workflow that executes plans via parallel subagents — for the pi coding agent.

## What it is

`pi-smart-plan` gives pi a goal-scoped planning workflow:

- **Plan mode** couples a mechanical write guard to the plan lifecycle. The guard is engaged by the `plan_enter` tool and released only after the user confirms through the `plan_exit` dialog.
- **Goal-scoped workflow** writes a DAG-as-data plan, derives execution waves, runs up to 4 parallel subagents per wave with disjoint `owns` and one writer per checkout, then a single delivery commit. One active goal per session.

## Install

```
pi install git:github.com/jnardiello/pi-smart-plan
```

Then run `/reload` to pick up the extension.

## Usage

- `/plan <goal>` — start the goal workflow (rehydration, scoping, plan, approval, execution, delivery).
- `/plan-guard status|on|off` — control the mechanical write guard outside a plan.
- `plan_enter` / `plan_exit` tools — engage / release the write guard programmatically.
- `ctrl+p` — toggle plan mode.
- `ask_smart_plan` tool — custom form, tabs for multiple questions. Right pane is a human briefing (`detail`) plus consequences of the highlighted option (`preview`). Long text scrolls with J/K or PgUp/PgDn. "None of these — I'll specify" opens an inline editor. Escape declines the form. No third-party extension required.

`/plan` injects the workflow into the session. This package is a pi extension, not a skill.

### IMPORTANT: remap ctrl+p

`ctrl+p` is a reserved built-in binding in pi 0.84.2 (`app.model.cycleForward`), so you must remap it in `~/.pi/agent/keybindings.json` for the toggle to take effect:

```json
{"app.model.cycleForward": "ctrl+alt+p"}
```

## Artifacts layout

```
backlog/<goal>/plan.md      # single source of truth for WHAT
backlog/<goal>/journal.md   # append-only WHY/HOW IT WENT
backlog/done/<goal>/        # completed goals are MOVED here on delivery
```

Position is the single source of truth for goal state: `ls backlog/` lists exactly the open goals. Completed goals are moved with `git mv` (git-tracked) or plain `mv`, as part of the final delivery commit.

Backlog discovery adapts, never clobbers (once per goal, at Phase 0/1):

1. no `backlog/` → create `backlog/<goal>/`;
2. status subdirectories (`todo/`, `doing/`, `done/`, `wip/`, `in-progress/` or similar) → adopt that vocabulary;
3. Backlog.md CLI layout (`backlog/tasks/` and/or `backlog/config.yml`) → do not touch it; place goals under `backlog/plans/<goal>/` and say so once;
4. `backlog/` is a nested checkout of a DIFFERENT git repo (`git -C backlog rev-parse --show-toplevel` differs) → stop and ask;
5. anything unrecognized → ask the user where to write.

## Commit policy (default)

Exactly two agent commits per goal:

1. the approval commit touching only `backlog/`;
2. the single final delivery commit (code + journal + final plan state + the goal move into `backlog/done/`).

Never push, never publish. Users who want different behavior should say so explicitly.

## Permissions

If you use `@gotgenes/pi-permission-system` (default `*` = ask), allow the extension tools or every form will pause on a y/n prompt:

```json
"ask_smart_plan": "allow",
"plan_enter": "allow",
"plan_exit": "allow"
```

The extension cannot flip that policy for you.

## Requirements

- pi 0.84.2+

## License

MIT
