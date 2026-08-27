# Changelog

## 0.8.0

- **Implementation-plan panel**: at presentation time the agent calls plan_present, which appends a dedicated panel to the transcript — waves, dependencies and a LIVE checklist (✓ done / ● ready / ○ pending) that re-reads the plan on every redraw. Distinct visual style (colored rule) so the final plan stands out from the rest of the chat.
- **present phase reordered**: ablation recap → human abstraction in chat → structured panel → approval form.

## 0.7.1

- **"None of the above" on every form, always last, with OPTIONAL note**: submitting an empty note now accepts the answer as-is (previously it bounced back to the list); a typed note is appended to the answer. In multi-select it is EXCLUSIVE — selecting it clears the other picks, and picking a real option clears it.
- The model is told every form automatically ends with this built-in option and must never add its own equivalent.

## 0.7.0

- **Two-level missions**: global — in plan mode the only deliverable is THE PLAN, never code/setup/implementation promises; local — every phase declares the deliverables the NEXT phase consumes, which is also its exit criterion.
- **Every question is a form**: any question to the owner — decisions, clarifications, even the opening "what do we design?" — arrives as an ask_smart_plan form with candidate directions and a custom-note escape. No prose questions, ever.
- **Challenge deep-dive inside discovery (opt-in)**: when scope + DoD are settled, a form asks whether the owner wants to CHALLENGE their implementation ideas before the HLD. If accepted: ONE challenge per turn, ALWAYS delivered as an ask_smart_plan form (never open prose) — rotating across assumptions, alternatives, failure modes, contrarian positions; check-ins every ~5 challenges, stop always available, insights journaled; the wrap-up synthesis feeds the HLD. The word "grill" is banned from all output (rounds are labeled "Challenge #N").
- **Charter fence in discovery**: proposals/charters pasted from other contexts are input to understand and challenge — never a work order; the agent builds documents, not software.

## 0.6.1

- **Lifecycle documentation**: the README now documents all six phases in detail — entry conditions, what happens, what you'll see, what's expected from you, exit conditions and written artifacts — plus the always-true rules (default-deny tools, owner-only activation, approval-gated guard release).
- **Product questions arrive as forms**: during discovery, product/decision questions go through ask_smart_plan forms (briefing + options + consequences) instead of prose; plain text is reserved for simple factual clarifications.

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
