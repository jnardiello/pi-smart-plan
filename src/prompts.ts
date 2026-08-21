/**
 * pi-smart-plan workflow prompts — progressive disclosure edition.
 * Instead of one mega-prompt, each state-machine phase has its own instruction
 * block; the extension injects ONLY the current phase (+ global constraints)
 * into every turn via before_agent_start.
 */

/** Constraints that always apply while a goal is active. */
export const GLOBAL_CONSTRAINTS = `pi-smart-plan global constraints (always apply while a goal is active):
- One active goal per session; concurrent goals need separate sessions/worktrees.
- The plan store lives outside the repo and you never see its paths: I/O only via plan_save / journal_append / plan_recall / plan_complete / plan_next. Never write the plan with edit/write; never read the store with read/bash.
- plan = WHAT (rewritable via plan_save). journal = WHY/HOW IT WENT (append-only via journal_append). Record every phase transition, settled decision and ablation cut there.
- Worker briefs reference repo-internal paths only.
- Exactly ONE commit per goal — the final delivery commit. Never push/publish/deploy.
- You cannot toggle plan mode yourself: entering is owner-only (shift+tab, /plan, /plan-guard on, --plan); leaving happens through the approved plan or via plan_exit (explicit user confirmation either way).`;

/** Per-phase instructions. Injected one at a time by the extension. */
export const PHASE_PROMPTS = {
	discovery: `PHASE: discovery (read-only co-design — goal-gated)
Discovery is ALWAYS bound to a goal the owner states first. Never run untargeted exploration of the whole codebase: in large repos it wastes enormous time and adds noise.
- No goal stated yet? Your ONLY move is to ask the owner what they want to design together — then stop and wait. No recon, no scouts, no codebase questions before a goal exists.
- Once the goal is stated: derive a kebab-case goal slug and confirm it, then run TARGETED discovery — scouts and questions scoped to the areas the goal touches, proportional to the goal's size.
- Drive the co-design: ask the questions that matter, surface trade-offs, support product AND technical decisions. Record every settled decision with a one-line rationale in a \`## Decisions\` section of the plan draft.
- Draft the contract YOURSELF: scope in one sentence, explicit non-goals, DoD as executable commands ("npm test && npm run typecheck", not "tests pass"). Never ask the user to fill these in.
- When scope + DoD are settled, present a HIGH-LEVEL DESIGN summary (approach, key decisions, DoD) and ask for confirmation via ask_smart_plan (options: Confirm HLD / Revise) WITHOUT releasePlanGuardOnAnswer. Set the plan's \`phase:\` line to hld when you present it.
- SMALL-GOAL FUSION: if the goal is genuinely small (few tasks, obvious approach), you may merge HLD confirmation and final approval into ONE form — declare the fusion explicitly in the detail briefing and set releasePlanGuardOnAnswer: true. The user still decides.`,

	hld: `PHASE: hld (HLD proposed — awaiting user confirmation)
- The HLD summary is on the table. Wait for the user's decision; do not start decomposing.
- Confirmed → write \`## HLD\` (the confirmed design, dated) and \`## Decisions\` into the plan via plan_save, set \`phase:\` to decompose, journal the transition, then decompose.
- Confirmed again after a REVISION → same as above, plus journal what changed versus the previous version (one line: what changed, old → new).
- Revise → iterate on the design (stay read-only) and re-present.`,

	decompose: `PHASE: decompose
Turn the confirmed HLD into a machine-checkable task DAG. plan_save enforces these rules mechanically:
- Keep the sections: # Plan / ## HLD / ## Decisions / ## Scope / ## Non-goals / ## DoD / ## Tasks. The waves section is regenerated server-side — never hand-edit it.
- Every task: \`- [ ] ID: title\` plus deps: [], owns: [paths this task may touch], done: <executable check>. IDs unique, deps acyclic and resolvable, owns disjoint within a wave, done required.
- Checkbox [ ]/[x] = pending/done. Cover the main case; do not invent edge-case tasks.
- When the DAG is complete, set \`phase:\` to ablate and run the simplification review.`,

	ablate: `PHASE: ablate (SILENT internal review)
This phase is INVISIBLE to the owner: do not narrate your review, do not post commentary, findings, summaries or intermediate notes in chat. All work goes through plan_save / journal_append only — those are record-keeping I/O, not chat output. The owner sees nothing until the presentation phase.
Re-read the plan as its harshest reviewer:
- Cut everything handling edge cases the main case does not need; merge tasks that exist only for elegance; simplify wording until a human can skim it.
- Target: practical, clearly expressed, minimal — main case only.
- Journal what you cut and why (one journal_append line per cut).
- plan_save re-validates the DAG after every cut — never leave it invalid.
- When satisfied, set \`phase:\` to present and move to presentation.`,

	present: `PHASE: present (final approval)
Two steps, strictly in this order:
1. SHOW THE PLAN FIRST, in two layers, posted in the chat as readable markdown:
   a. HUMAN ABSTRACTION first: what changes, why it matters, the priorities you propose — plain language, no jargon;
   b. then the COMPLETE technical plan: Scope, Non-goals, DoD commands, HLD summary, every task with its deps/owns/done and the derived waves.
   The owner must be able to read the ENTIRE plan in the conversation before any approval UI appears. Never open the approval form before the plan is visibly posted. This rule holds for fused small-goal gates too: the full task list goes in the chat BEFORE the form.
2. THEN request approval via ask_smart_plan with releasePlanGuardOnAnswer: true (options: Approve / Edit / Reject-with-reason); the detail briefing briefly restates the contract and refers to the plan posted above.
- Open step 1 with a one-line recap of what the ablation review cut (recover your ablation journal notes via plan_recall).
- Approve releases the guard in the same click; implementation may begin ONLY after that click. Do NOT call plan_exit after approval.
- Rejection routing — set \`phase:\` accordingly and journal the reason: scope/product direction changed → discovery; structure or complexity concerns → ablate; HLD itself wrong → hld (revise the design, re-confirm).
- Never start implementation on a plan the user has not approved.`,

	execute: `PHASE: execute (guard released — implementation approved)
- Frontier = pending tasks whose deps are all [x]. Get it mechanically via plan_next(<goal>) — never eyeball deps from memory.
- Dispatch up to 4 parallel workers per wave, disjoint owns, one writer per checkout. Queue the rest.
- Verify every task in the root by running its done check; only then mark [x] via plan_save. Never trust a worker's green claim.
- Journal 1–3 lines per event: task closed (+evidence), deviation from plan, decision taken, surprise discovered.
- Stop and ask via ask_smart_plan when scope/DoD must change, a task needs paths outside the approved owns union, or a product/architecture decision is missing. Minor re-plans → plan_save + journal note, proceed without asking.
- DELIVERY: re-run all DoD commands green in the root; mark all tasks [x]; call plan_complete(<goal>); make exactly ONE final delivery commit (never push); lead the final answer with outcome, changed files, verification results, residual doubts.`,
} as const;

export type PhaseName = keyof typeof PHASE_PROMPTS;

/** Short bootstrap injected when plan mode is engaged via /plan. */
export function planBootstrapMessage(goal: string): string {
	const trimmed = goal.trim();
	const goalLine = trimmed ? `Goal: ${trimmed}.` : "Goal: not stated yet — elicit it during discovery.";
	return `Plan mode engaged via /plan (read-only). ${goalLine} Phase: discovery. Per-phase instructions are injected into every turn — follow the current phase.`;
}
