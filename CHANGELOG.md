# Changelog

## 0.6.0

- **Plan mode is default-deny**: only reading (read/grep/find/ls), bash restricted to read-only commands, web research and the planning-store tools run while planning — everything else, including unknown or future third-party tools, is blocked. Writes happen exclusively in the plans folder via the store tools.
- **Human-readable plan presentations**: every presentation opens with the human abstraction (what changes, why, priorities) before the full technical DAG; the complete task list with dependencies is always posted in chat BEFORE any approval form — including fused small-goal gates.
- **Ablation recap at presentation**: the silent review phase reports one line of what it cut when the plan is shown.
- **HLD revisions journaled**: re-confirming a revised HLD records what changed versus the previous version.
- `/plan-status` zero-token state dump; `currentPhase` picks the most recently modified goal.

## 0.5.0

- **Mechanical owns verification**: claiming a task (`plan_task_update` → `in_progress`) snapshots dirty files; closing it (`done`) verifies the delta stayed inside the task's `owns` (git-backed) and that all dependencies are done. Violations reject the close and are journaled.
- **`plan_task_update` tool**: server-side checkbox flip — no more full-plan rewrites to tick a box. Dependency discipline enforced at the tool level.
- **`plan_verify` tool**: runs every DoD command of a goal's plan and reports pass/fail — mechanical delivery gate.
- **Phase-transition validation**: an explicit `phase:` line must be backed by structure (`decompose` requires HLD, `ablate`/`present` require HLD + tasks); illegal jumps reject the save.
- **Silent ablate**: the internal simplification review no longer narrates in chat; work happens through store I/O only.
- **Mandatory plan presentation**: `present` posts the complete plan in chat BEFORE any approval UI — assemble → validate → show → approve.
- **`/plan-status` command**: zero-token dump of goals, phases and frontier.
- **Smoke test ships with the repo** (`npm test`).
- `currentPhase` picks the most recently modified goal.

## 0.4.0

- Six-phase state machine: discovery · hld · decompose · ablate · present · execute, with per-turn progressive disclosure (only the current phase's instructions are injected).
- Two user gates (HLD + final plan), fusible for small goals; rejection routing by reason.
- Ephemeral store under `<tmpdir>/pi-smart-plan-<uid>/` (0700).
- Themed heat-bar widget (gray → orange transparency ramp) + `/plan-status`.
- shift+tab toggles plan mode owner-only, zero LLM turns; thinking cycle remapped to ctrl+shift+t by config.
- Silent-ablate and mandatory chat presentation refined in 0.4.x patches.

## 0.3.0 / 0.2.0

- True read-only enforcement: edit/write removed from active tools, bash allowlist, subagent/chrome backstop.
- Owner-only activation (no `plan_enter`); `plan_exit` always user-confirmed.
- ctrl+p toggle (superseded by shift+tab in 0.4.0).

## 0.1.0

- Initial release: write guard, external store, DAG-as-data plans, ask_smart_plan form.
