# Plan: external-plan-store

## Scope

Plan/journal artifacts move out of the repo into an extension-owned store at
`~/.pi/agent/smart-plan/<repo-slug>/<goal>/` (repo-slug = cwd with `/` → `-`, like pi's
sessions dir). The model never touches those paths: all I/O goes through new dedicated
tools. The write guard simplifies to "plan mode blocks edit/write, period". Rehydration
becomes explicit (user asks → extension searches its store). Zero repo footprint for new
plans.

## Non-goals

- No changes to third-party packages (permission system stays untouched).
- No migration of existing `backlog/` dirs in repos (history stays where it is; this repo's
  `backlog/done/` remains as-is).
- No automatic rehydration/Phase-0 scan; recall is explicit-only.
- No multi-repo/global plan search beyond the current repo's slug dir.

## Design decisions (pinned)

- Storage layout: `~/.pi/agent/smart-plan/<repo-slug>/<goal>/{plan.md,journal.md}`;
  completed goals move to `~/.pi/agent/smart-plan/<repo-slug>/done/<goal>/` (position = state,
  same convention as today, just out of repo).
- New tools (extension-owned I/O, invisible to permission layers):
  - `plan_save(goal, content)` — overwrite plan.md (plan is rewritable by design).
  - `journal_append(goal, lines)` — append-only journal.md with timestamp.
  - `plan_recall(query?)` — list goals (active + done) for this repo; with query, grep
    topic across plan/journal. Returns CONTENT (plan.md + journal tail), never bare
    paths — the model must never re-read store paths via generic tools. Explicit-use only.
  - `plan_complete(goal)` — move goal dir to `done/`.
- Guard: in plan mode block `edit`/`write` unconditionally. `absolutize`/`insideBacklog`
  and the backlog exception are deleted.
- Commit policy becomes ONE commit per goal (delivery only, code + repo changes). The
  approval commit disappears — plan artifacts are no longer in the repo.
- Workflow rules added: worker briefs reference repo-internal paths only; support
  artifacts needed by workers are materialized inside the repo and removed before the
  delivery commit.

## DoD

bun build --no-bundle index.ts src/prompts.ts src/plan-store.ts
npm pack --dry-run
Manual: /reload in pi — /plan writes plan via plan_save into ~/.pi/agent/smart-plan/…; edit/write blocked in plan mode with no backlog/ exception; plan_recall finds the goal.

## Tasks

- [x] T1: Plan store module + tool implementations
  deps: []
  owns: [src/plan-store.ts]
  done: bun build --no-bundle src/plan-store.ts passes; exports store paths + save/append/recall/complete functions
- [x] T2: Workflow prompt rewrite (external store, explicit recall, one-commit policy, worker path rule)
  deps: []
  owns: [src/prompts.ts]
  done: bun build --no-bundle src/prompts.ts passes; no mention of backlog/ as artifact location; tool names match T1 signatures pinned above
- [x] T3: Wire tools + simplify guard in index.ts
  deps: [T1]
  owns: [index.ts]
  done: bun build --no-bundle index.ts passes; plan_save/journal_append/plan_recall/plan_complete registered; tool_call handler blocks edit/write unconditionally in plan mode; absolutize/insideBacklog removed
- [x] T4: README update (usage, storage location, recall, commit policy)
  deps: [T2, T3]
  owns: [README.md]
  done: README describes external store + new tools; no stale backlog/ artifact docs

## Review — waves (derived)

- Wave 1: T1, T2
- Wave 2: T3
- Wave 3: T4
