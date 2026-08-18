---
name: plan
description: Goal-scoped planning + parallel agentic execution workflow. Ships in the pi-smart-plan package; on pi it is started by the /plan command (the extension pre-activates the write guard); direct /skill:plan invocation remains valid elsewhere. Use when the user asks to plan a goal or to "fare un piano" for non-trivial work, or invokes plan/backlog/journal terminology on a concrete objective.
---

Plan a goal end-to-end: grill scope to a precise contract, write a DAG-as-data plan, get explicit approval, execute via parallel subagents, and journal the whole run. One active goal per session.

## GOAL & FILES

- Derive a kebab-case goal slug from the request; confirm it with the user up front.
- Artifacts live **in-repo, versioned**: `backlog/<goal>/plan.md` and `backlog/<goal>/journal.md`.
- `plan.md` is the single source of truth for WHAT; `journal.md` is append-only for WHY/HOW IT WENT. One writer per file, always.
- **Position is the single source of truth for goal state — there is no goal status field.** Active goals live at `backlog/<goal>/`; completed goals are moved to `backlog/done/<goal>/` as part of PHASE 5 delivery. `ls backlog/` therefore lists exactly the open goals. Re-opening a goal = moving it back to `backlog/<goal>/`.

## BACKLOG DISCOVERY

Detect-and-adapt, never clobber. Runs once per goal, at Phase 0/1; the chosen layout is recorded in the journal's first entry. Algorithm, in order:

1. **No `backlog/`** → create `backlog/<goal>/` (default layout).
2. **`backlog/` with status subdirectories** (`todo/`, `doing/`, `done/`, `wip/`, `in-progress/` or similar) → adopt that vocabulary: active goals go in the repo's active-status dir, completed ones in its done dir, instead of the default layout.
3. **`backlog/` looks like the Backlog.md CLI tool** (a `backlog/tasks/` dir and/or `backlog/config.yml`) → do NOT touch its files or formats; place goals alongside under `backlog/plans/<goal>/` and say so to the user once.
4. **`backlog/` belongs to a DIFFERENT git repository** than the current working repo (nested checkout — detect via `git -C backlog rev-parse --show-toplevel` differing from the outer toplevel) → STOP and ask the user before writing anything.
5. **Anything else unrecognized** → ask the user where to write.

## PHASE 0 — REHYDRATION

Scan `backlog/` for the active goal. If `backlog/<goal>/` exists: read `plan.md` + `journal.md`, report state to the user, and resume at the execution frontier — never re-plan a non-trivial goal from scratch. If the active goal is not found in `backlog/`, check `backlog/done/` before concluding it is new — a moved goal is a re-opening, not a fresh plan. Ask the user if the goal is truly superseded before starting over.

## PHASE 1 — SCOPING (read-only)

- If a `plan_enter` tool exists (pi): call it at the start of scoping to engage the mechanical guard. Elsewhere (Codex/Claude Code) treat read-only as strict discipline: no writes, exploration only.
- Delegate codebase recon to scout subagents per the harness contract; do not explore inline when it exceeds the delegation gate.
- Ask the CORE questions in ONE `ask_user_question` form (single-select each, with a freeform escape):
  1. exact scope — the outcome, in one sentence
  2. explicit non-goals — what this plan will deliberately NOT do
  3. DoD — executable commands that must pass, not prose ("`npm test && npm run typecheck`", not "tests pass")
- ESCALATE to deep, one-question-at-a-time grilling (recommended answers included) only on a trigger: detected ambiguity, risk surface (security/data/irreversible), or the user asks.
- If no `ask_user_question` tool is available, ask structured questions in plain text, one at a time.

## PHASE 2 — PLAN AUTHORING

Write `backlog/<goal>/plan.md`:

```
# Plan: <goal>

## Scope

## Non-goals

## DoD
<command 1 — must pass>
<command 2 — must pass>

## Tasks

- [ ] T1: <title>
  deps: []
  owns: [<paths/dirs this task may touch>]
  done: <verifiable check>
- [ ] T2: <title>
  deps: [T1]
  owns: [<paths/disjoint from other tasks>]

## Review — waves (derived)
```

Task rules (DAG-as-data, machine-greppable):
- `deps`, `owns`, `done` required on every task; `deps: []` for roots.
- `owns` must be disjoint between tasks in the same wave, so workers never collide.
- Checkbox `[ ]`/`[x]` = pending/done; optional `status: in_progress | blocked` line (task state only) while a task is claimed.
- **`## Review — waves (derived)` is GENERATED from deps (topological layers), human-review only.** Regenerate on every re-plan; never hand-edit. `deps` arrays are the source of truth, always.

## PHASE 3 — APPROVAL

Present the full plan + derived waves via `ask_user_question` (options: **Approve** / **Edit** / **Re-grill**). Edit → revise plan and re-present; Re-grill → return to Phase 1.

On **Approve**:
1. Commit scoped to `backlog/<goal>/` only, message `plan(<goal>): approved`.
   Commit policy (package default): exactly two agent commits per goal — the approval commit touching only `backlog/`, and the single final delivery commit. Never push, never publish. Users who want different behavior should say so explicitly.
2. Call `plan_exit` (pi) when present — the user confirms release of the guard through the dialog.

## PHASE 4 — EXECUTION

- Root orchestrates. Frontier = tasks whose deps are all `[x]`.
- Dispatch up to 4 parallel workers per wave, **disjoint `owns` and one writer per checkout**. Queue the rest.
- Verify each task in the root by running its `done` check; only then mark `[x]` in plan.md. Do not trust a worker's green claim — re-run it.
- JOURNAL (root-only writer): append 1–3 timestamped lines per EVENT: task closed (+evidence), deviation from plan, decision taken, surprise discovered. Worker raw reports stay in session artifacts — never paste them into the journal.

## RE-ENTRY THRESHOLDS

Stop execution and ask the user (`ask_user_question`) when:
- scope or DoD must change;
- a new or changed task needs paths outside the approved union of `owns`;
- a product or architecture decision is missing.

Minor re-plans (split a task within its `owns`, reorder within deps, tighten a `done` check) → update plan.md, note in journal, proceed without asking.

## PHASE 5 — DELIVERY

1. All DoD commands re-run green **in the root**. Do not hand the goal back otherwise.
2. Mark all tasks `[x]` in plan.md, then move `backlog/<goal>/` → `backlog/done/<goal>/` with `git mv` when the repo is git-tracked (so history follows) and plain `mv` otherwise. The move is part of the final delivery commit; re-opening a goal moves it back to `backlog/<goal>/`.
3. ONE final commit (code + journal + final plan state + the goal move into `backlog/done/`) — per the commit policy above. Never push.
4. Lead the final answer with: outcome, changed files, verification results, residual doubts.

## CONSTRAINTS

- One active goal per session; concurrent goals need separate sessions/worktrees (one writer per checkout).
- Never commit anything outside the two commit points of the commit policy; never push/publish/deploy.
- `plan.md` = WHAT (rewritable on re-plan by design). `journal.md` = WHY/HOW IT WENT (append-only, never rewritten).
