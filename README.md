# pi-smart-plan

Plan mode with a mechanical write guard, plus a goal-scoped workflow that executes plans via parallel subagents — for the pi coding agent.

## What it is

`pi-smart-plan` gives pi a goal-scoped planning workflow:

- **Owner-only plan mode** couples a mechanical write guard to the plan lifecycle. It can be engaged exclusively by the user (`shift+tab`, `/plan`, `/plan-guard on`, or `pi --plan` at launch) — the model has no tool to activate it, and no unilateral way out: `plan_exit` always requires an affirmative user confirmation.
- **True read-only** while planning — **default-deny**: only reading (read/grep/find/ls), bash restricted to read-only commands, web research and the planning-store tools run while planning; everything else (write built-ins, subagents, chrome, unknown or future third-party tools) is blocked. The only writes go into the plans folder via the store tools (`plan_save`, `journal_append`, `plan_complete`).
- **Goal-scoped workflow** writes a DAG-as-data plan into an ephemeral extension-owned store under the system temp dir, derives execution waves, runs up to 4 parallel subagents per wave with disjoint `owns` and one writer per checkout, then a single delivery commit. One active goal per session, zero footprint in the repo.
- **Mechanical DAG validation**: `plan_save` rejects plans with duplicate task IDs, unknown deps, dependency cycles, overlapping `owns` within the same wave, or missing `done:` checks — and regenerates the derived waves section server-side. `plan_next` returns the ready frontier (tasks dispatchable now) computed from the graph, never eyeballed.
- **A six-phase plan state machine, inspired by Claude Code and Codex but stricter**: `discovery` (read-only co-design: goal elicitation, heavy recon, product/tech decisions logged) → `hld` (High-Level Design confirmed by the user BEFORE any task is written) → `decompose` (DAG tasks, mechanically validated) → `ablate` (self-review for simplicity: cut edge-case handling, keep the main case minimal) → `present` (final approval form) → `execute`. Two explicit user gates; small goals may fuse them into one, declared explicitly. Rejections route by reason (scope → discovery, structure → ablate, wrong HLD → hld). Only the approval click releases the guard.
- **Progressive disclosure**: instead of one giant workflow prompt, each turn injects only the current phase's instructions plus global constraints — the model always sees the contract of the moment.

## Install

```
pi install npm:@jnardiello/pi-smart-plan
# or from git:
pi install git:github.com/jnardiello/pi-smart-plan
```

Then run `/reload` to pick up the extension.

## Usage

- `/plan <goal>` — start the goal workflow (scoping, plan, approval, execution, delivery).
- `/plan-guard status|on|off` — control the read-only guard outside a plan.
- `plan_exit` tool — request to release the guard; always gated by a user confirmation dialog. There is **no** `plan_enter` tool: activation is owner-only.
- `plan_save` — write (overwrite) the plan for a goal in the external store.
- `journal_append` — append timestamped lines to the goal journal (append-only).
- `plan_recall` — search the store for this repo's plans. Explicit-only: run it when the user asks about prior work on a topic. Returns content (plan + journal tail), never paths.
- `plan_next` — mechanically computed ready frontier for a goal: pending tasks whose deps are all done. Use it during execution instead of eyeballing deps.
- `plan_complete` — move a goal to the `done/` portion of the store after its DoD passes.
- `plan_task_update` — set a task's status (`pending | in_progress | blocked | done`). Claiming snapshots dirty files; closing verifies the delta stayed inside the task's `owns` (git-backed) and that dependencies are closed. Checkbox flipped server-side.
- `plan_verify` — run every DoD command of a goal's plan and report pass/fail. The mechanical delivery gate: no delivery claim without a green `plan_verify`.
- `/plan-status` — zero-token dump of active goals, phases and ready frontier.
- `shift+tab` — toggle read-only plan mode. Activation only notifies you (no LLM turn): describe what you want to design and the discovery-phase instructions take over; the full `/plan <goal>` command remains available.
- `ask_smart_plan` tool — custom form, one tab per open decision (never structural categories like "Scope" or "DoD": the agent drafts that contract itself and presents it in the approval briefing). Right pane is a human briefing (`detail`) plus consequences of the highlighted option (`preview`). Long text scrolls with J/K or PgUp/PgDn. "None of these — I'll specify" opens an inline editor. Escape declines the form. Goals with no real fork skip the form entirely. No third-party extension required.

`/plan` injects the workflow into the session. This package is a pi extension, not a skill. Start with the guard already engaged via `pi --plan`.

### IMPORTANT: remap shift+tab

In pi the built-in `app.thinking.cycle` defaults to `shift+tab`. Remap it in `~/.pi/agent/keybindings.json` to free the key for the plan-mode toggle:

```json
{
  "app.thinking.cycle": "ctrl+shift+t"
}
```

Note: pi has no chord support (two-key sequences like `tab+t` cannot be bindings), so a modifier combo is required. If your terminal intercepts `ctrl+shift+t` itself, pick another combo or enable the Kitty keyboard protocol in your terminal.

## Artifacts layout

Plans and journals live in an EPHEMERAL extension-owned store under the system temp dir — per-user (`pi-smart-plan-<uid>`, dirs created `0700`) and wiped on reboot by design; the model never handles those paths, all I/O goes through the dedicated tools:

```
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/plan.md      # WHAT + HLD + Decisions + Tasks DAG; `phase:` line tracks the state machine
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/journal.md   # append-only WHY/HOW IT WENT (via journal_append)
<tmpdir>/pi-smart-plan-<uid>/<repo>/done/<goal>/        # completed goals, moved here by plan_complete
```

The optional `phase:` line (`discovery | hld | decompose | ablate | present`) marks the current state-machine phase explicitly; the extension infers it from structure when absent and injects only that phase's instructions each turn.```

`<tmpdir>` respects `TMPDIR` (`/tmp` on macOS/Linux); `<repo>` is derived from the working directory, `<goal>` is the kebab-case slug. Position is the single source of truth for goal state: `plan_recall` lists exactly the active + done goals. Re-opening a completed goal happens automatically on the next `plan_save`, which moves it back to active. Never read the store with `read`/`bash` — use `plan_recall`.

> **Ephemerality:** plans and journals do not survive a reboot (and macOS may clean untouched /tmp files after ~3 days). Cross-session history is intentionally out of scope.

> **Legacy note:** repos that already use an in-repo `backlog/` directory are not migrated; that directory and its history stay untouched.

## Plan mode behavior

While the guard is active:

- `edit`/`write`, subagent spawning and interactive chrome tools are removed from the active tool set (and re-blocked at call time as a backstop).
- bash runs only allowlisted read-only commands (`ls`, `rg`, `cat`, `git status/diff/log`, …). Anything unknown — interpreters, script runners, package managers, `npm test`/`npm run` (scripts can write) — is blocked; harmless noise redirects (`2>&1`, `>/dev/null`) are still accepted. The allowlist lives in `src/bash-guard.ts`.
- A TUI widget shows the phase pipeline (gray → orange heat bar), each goal's progress and ready frontier while planning/executing.
- Closing a task mechanically verifies changed files against its `owns` and enforces dependency order — violations reject the close and land in the journal.
- Approval is a single gate: on the approval form (`ask_smart_plan` with `releasePlanGuardOnAnswer`), approving releases the guard in the same click — no second dialog. Implementation may begin only after that approval click.
- Exiting outside the approval flow requires a user-confirmed `plan_exit` dialog — which shows the active plans (or warns when none was saved) so the decision is informed — or `/plan-guard off`, or toggling `shift+tab` again.

### Combining with pi-permission-system

If you use `@gotgenes/pi-permission-system`, this extension's enforcement is independent (tool removal + allowlist), so nothing breaks either way. For extra depth you can manually keep restrictive rules in its config during planning; automatic policy flipping is not possible without an upstream API.

## Commit policy (default)

Exactly one agent commit per goal — the final delivery commit (code + repo changes only, since plan/journal live outside the repo). There is **no approval commit**. Never push, never publish. Users who want different behavior should say so explicitly.

## Permissions

If you use `@gotgenes/pi-permission-system` (default `*` = ask), allow the extension tools or every call pauses on a y/n prompt:

```json
"ask_smart_plan": "allow",
"plan_exit": "allow",
"plan_next": "allow",
"plan_save": "allow",
"plan_task_update": "allow",
"plan_verify": "allow",
"journal_append": "allow",
"plan_recall": "allow",
"plan_complete": "allow"
```

The extension cannot flip that policy for you.

## Requirements

- pi 0.84.2+

## License

MIT
