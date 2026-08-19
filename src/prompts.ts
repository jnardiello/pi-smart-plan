/** Planning workflow injected by /plan. Not a skill — extension-owned prompt. */

export const PLAN_WORKFLOW = `Follow this planning workflow end-to-end. You are running inside the pi-smart-plan extension (/plan). Plan mode is ALREADY engaged — do not call plan_enter. Use ask_smart_plan for structured questions.

Plan a goal end-to-end: grill scope to a precise contract, write a DAG-as-data plan, get explicit approval, execute via parallel subagents, and journal the whole run. One active goal per session.

## GOAL & FILES

- Derive a kebab-case goal slug from the request; confirm it with the user up front.
- Artifacts live in an **extension-owned store outside the repo** — you never see or handle those paths. All I/O goes through dedicated tools: \`plan_save(goal, content)\` (overwrite plan), \`journal_append(goal, lines)\`, \`plan_recall(query?)\` (returns contents), \`plan_complete(goal)\`.
- \`plan\` is the single source of truth for WHAT, rewritable by design via \`plan_save\`; \`journal\` is append-only for WHY/HOW IT WENT via \`journal_append\`. One writer per artifact, always.
- Never write the plan with \`edit\`/\`write\`; never read the store with \`read\`/\`bash\`. Those dedicated tools are the only I/O.

## PHASE 0 — REHYDRATION (explicit only)

No automatic scan and no Phase-0 rehydration by default. Use \`plan_recall\` ONLY when the user asks about previous work or explicitly reopens a goal: report state from the returned contents and resume at the execution frontier — never re-plan a non-trivial goal from scratch. Ask the user if the goal is truly superseded before starting over.

## PHASE 1 — SCOPING (read-only)

- The mechanical write guard is already ON (engaged by /plan or ctrl+p before this message). Call \`plan_enter\` only if you find plan mode inactive — e.g. after a plan_exit when returning to re-scoping.
- Delegate codebase recon to scout subagents per the harness contract; do not explore inline when it exceeds the delegation gate.
- After recon, draft the contract YOURSELF — exact scope (the outcome, in one sentence), explicit non-goals, DoD as executable commands that must pass ("\`npm test && npm run typecheck\`", not "tests pass"). Do NOT ask the user to fill these in as form questions; the contract is presented for confirmation at Phase 3 approval.
- From recon + the draft contract, identify the OPEN DECISIONS: forks where materially different outcomes are possible and the choice belongs to the user — trade-offs, product direction, risk appetite, API/UX surface. Not every goal has one.
  - Zero open decisions → skip \`ask_smart_plan\` and proceed straight to Phase 2. Never invent a decision to have something to ask.
  - Otherwise: one \`ask_smart_plan\` call, ONE question per decision. Every tab IS a decision — never structural categories like "Scope", "Non-goals", "DoD", "Context".
  - Every question MUST include \`detail\`: a plain-language briefing a human can act on without the chat (what is already true, what is at stake, why this fork is real). No jargon without a gloss. No "as we discussed". Options are concrete alternatives: \`label\`, \`description\`, and \`preview\` = the consequences of picking it. "None of these — I'll specify" opens a note; Escape=declined.
- \`ask_smart_plan\` supports 1–4 questions per call (further decisions go in a follow-up call), single or multiSelect, \`detail\` briefing + per-option \`preview\`, a multiline custom note when no option fits, and Escape = \`declined\` (does not abort the turn).
- If \`ask_smart_plan\` returns \`details.ui === false\`, fall back to plain-text questions, one at a time. If it returns \`details.declined\`, stop and wait for the user.
- ESCALATE to deep, one-question-at-a-time grilling (recommended answers included) only on a trigger: detected ambiguity, risk surface (security/data/irreversible), or the user asks.

## PHASE 2 — PLAN AUTHORING

Write the plan via \`plan_save(<goal>, <content>)\`:

\`\`\`
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
\`\`\`

Task rules (DAG-as-data, machine-greppable):
- \`deps\`, \`owns\`, \`done\` required on every task; \`deps: []\` for roots.
- \`owns\` must be disjoint between tasks in the same wave, so workers never collide.
- Checkbox \`[ ]\`/\`[x]\` = pending/done; optional \`status: in_progress | blocked\` line (task state only) while a task is claimed.
- **\`## Review — waves (derived)\` is GENERATED from deps (topological layers), human-review only.** Regenerate on every re-plan; never hand-edit. \`deps\` arrays are the source of truth, always.

## PHASE 3 — APPROVAL

Present the plan via \`ask_smart_plan\` (options: **Approve** / **Edit** / **Re-grill**, each with label+description+preview). The \`detail\` briefing MUST open with the full contract — Scope, Non-goals, DoD commands — then the task list and derived waves: approval is where the contract gets confirmed, so it must be readable there without the chat. Edit → revise the plan (via \`plan_save\`) and re-present; Re-grill → return to Phase 1.

On **Approve** (no commit here — the only commit is the final delivery, see PHASE 5):
1. Call \`plan_exit\` — the user confirms release of the guard through the dialog.
   Commit policy (package default): exactly ONE agent commit per goal — the single final delivery commit. There is no approval commit because plans are not in the repo. Never push, never publish. Users who want different behavior should say so explicitly.

## PHASE 4 — EXECUTION

- Root orchestrates. Frontier = tasks whose deps are all \`[x]\`.
- Dispatch up to 4 parallel workers per wave, **disjoint \`owns\` and one writer per checkout**. Queue the rest.
- Verify each task in the root by running its \`done\` check; only then mark \`[x]\` in the plan (rewrite via \`plan_save\`). Do not trust a worker's green claim — re-run it.
- JOURNAL (root-only writer): append 1–3 timestamped lines per EVENT via \`journal_append\`: task closed (+evidence), deviation from plan, decision taken, surprise discovered. Worker raw reports stay in session artifacts — never paste them into the journal.
- WORKER BRIEFS REFER ONLY TO REPO-INTERNAL PATHS. A store/external path in a brief can hang a headless worker on a permission ask — never reference one. Materialize any support artifact a worker needs inside the repo, and remove it before the final delivery commit.

## RE-ENTRY THRESHOLDS

Stop execution and ask the user via \`ask_smart_plan\` when:
- scope or DoD must change;
- a new or changed task needs paths outside the approved union of \`owns\`;
- a product or architecture decision is missing.

Minor re-plans (split a task within its \`owns\`, reorder within deps, tighten a \`done\` check) → update the plan via \`plan_save\`, note in the journal via \`journal_append\`, proceed without asking.

## PHASE 5 — DELIVERY

1. All DoD commands re-run green **in the root**. Do not hand the goal back otherwise.
2. Mark all tasks \`[x]\` in the plan (via \`plan_save\`), then call \`plan_complete(<goal>)\` — the extension moves the goal to its \`done/\` in the store.
3. ONE final commit (code + repo changes only — plan/journal live outside the repo) per the commit policy above. Never push.
4. Lead the final answer with: outcome, changed files, verification results, residual doubts.

## CONSTRAINTS

- One active goal per session; concurrent goals need separate sessions/worktrees (one writer per checkout).
- Exactly ONE commit per goal — the final delivery commit. Never commit anything else; never push/publish/deploy.
- Never touch the store with generic tools: \`plan_save\`, \`journal_append\`, \`plan_recall\`, \`plan_complete\` are the only I/O.
- Worker briefs reference repo-internal paths only; support artifacts live in the repo and are removed before the delivery commit.
- \`plan\` = WHAT (rewritable on re-plan by design via \`plan_save\`). \`journal\` = WHY/HOW IT WENT (append-only, never rewritten via \`journal_append\`).
`;

export function planUserMessage(goal: string): string {
	const trimmed = goal.trim();
	const goalLine = trimmed
		? `Goal: ${trimmed}`
		: `The user started /plan without a goal. Elicit the goal during scoping.`;
	return `${PLAN_WORKFLOW}\n\n${goalLine}`;
}
