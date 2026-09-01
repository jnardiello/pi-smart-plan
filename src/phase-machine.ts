/**
 * pi-smart-plan phase machine — pure state-machine helpers.
 *
 * Zero I/O, zero pi dependencies. Everything the harness needs to decide the
 * current phase's tool surface and to verify/close its deliverable lives here:
 * per-phase tool allowlists, exit preconditions, structured-turn closing rules
 * and next-action hints. The phase enum and the plan validators are re-used
 * from plan-validate.ts (single source of truth) — never redefined.
 *
 * Six-phase flow, exactly two owner touchpoints (the review_* gate forms —
 * built and driven by index.ts, INSIDE plan_advance itself):
 *
 *   discovery → simplify → review_hld → decompose → review_final → execute
 *    (chat,      (auto      (Gate 1:     (auto DAG    (Gate 2:      (guard
 *     save HLD)   trim +     harness      owns/deps/   harness       released)
 *                 cut log)   opens form   done)        opens form
 *                            on advance)               on advance)
 *
 * All five planning phases exit through the SAME formless `plan_advance`
 * tool once phaseDeliverableReady says so — there is no separate
 * presentation tool. In review_hld/review_final, index.ts intercepts that
 * same plan_advance call and opens the owner-facing gate form
 * (ask_smart_plan with phaseGate: true) instead of silently advancing the
 * phase. This is harness-driven rather than tool-driven because a field test
 * proved pi's setActiveTools only applies on the model's NEXT turn, so a
 * mid-run tool GRANT (e.g. handing out a presentation tool) never reaches
 * the model that would need it this turn — only removals can be enforced
 * mid-run. The caller (index.ts) assembles a `PhaseSnapshot` from the plan
 * store + session state and asks this module to decide readiness, the
 * allowed tools, whether a turn closed structurally, and what to do next.
 */
import { parseTasks, validatePhaseShape, validateTaskGraph } from "./plan-validate.ts";
import type { Phase } from "./plan-validate.ts";

export { PHASES } from "./plan-validate.ts";

// ---------------------------------------------------------------------------
// PhaseSnapshot
// ---------------------------------------------------------------------------

/** Minimal store/session view the caller assembles for the predicates below.
 * Raw plan text is parsed here with the plan-validate helpers; everything
 * else is goal/journal/flag state the caller already has. Optional booleans
 * default to false when absent. Slimmed for the six-phase machine: the old
 * text-heuristic/session-flag fields (goalConfirmed, challengePathChosen,
 * gate1Approved, gate2Authorized) are gone — readiness is now fully derived
 * from plan content (validatePhaseShape) plus the one fact a phase can't
 * self-report from content alone: execute's DoD/completion state. review_hld/
 * review_final carry no session flag at all — their gate form is opened by
 * the harness (index.ts) when the model calls plan_advance, not gated on a
 * presentation tool having run first. */
export interface PhaseSnapshot {
	/** Confirmed kebab-case goal slug. Undefined until discovery names one. */
	goal?: string;
	/** Raw plan text (plan.md for the goal). Parsed with the plan-validate
	 * helpers inside the predicates below. */
	planContent?: string;
	/** Journal appends made during the CURRENT phase (drives simplify's cut
	 * log requirement). */
	journalEntriesForPhase?: number;
	/** Execute — plan_verify ran and every DoD command passed. */
	dodPassed?: boolean;
	/** Execute — plan_complete recorded the goal as done. */
	completed?: boolean;
	/** True when the CURRENT review-phase gate was last resolved as postponed
	 * (dismissed / "None of the above") rather than approved/rejected/
	 * authorized. Lets finalizeVerdict treat a prose owner-facing close (Q&A)
	 * as legal instead of steering it away — the model was correctly told "do
	 * not re-open until the owner signals." Only meaningful for review_hld/
	 * review_final; index.ts clears it on any real phase transition and
	 * whenever a gate form actually (re-)opens, and sets it only when a gate
	 * resolves as postponed. Session-local by design: a guard off/on cycle or
	 * process restart forgets it, so worst case the bounded finalize-retry
	 * steer returns — acceptable, not a correctness bug. */
	gatePostponed?: boolean;
	/** True once the owner has confirmed the goal's objective via plan_intent.
	 * Derived from the STORE (readIntent) by the caller (index.ts's
	 * buildPhaseSnapshot) — this module stays pure/zero-I/O and never reads
	 * intent.txt itself. Only the discovery branch of phaseDeliverableReady
	 * consults it; absent/false means "not confirmed yet". */
	intentConfirmed?: boolean;
	/** True once ANY tool has run (permitted call) during the current
	 * pre-intent investigation. Session-local: latched by the caller
	 * (index.ts's tool_call handler, parent runs only) on every allowed call,
	 * reset on guard off/on and on plan_intent's Confirm. A run that has
	 * already used a tool is working, not chatting — finalizeVerdict's
	 * discovery branch consults this to regenerate a prose-only close that
	 * skips plan_intent/ask_smart_plan instead of letting the model exit the
	 * machine entirely while still pre-intent (the field-failure this flag
	 * exists to floor). Absent/false means "no investigation yet this run". */
	investigationDone?: boolean;
}

/** Convenience: the snapshot's raw plan text ("" when absent). */
function snapshotPlan(snapshot: PhaseSnapshot): string {
	return snapshot.planContent ?? "";
}

// ---------------------------------------------------------------------------
// simplify auto-pass — proportional ablation
// ---------------------------------------------------------------------------

/** Plans at or below this many non-empty lines skip simplify's cut-log
 * requirement. An ablation pass on a plan this small produces invented cuts
 * rather than real ones (observed: a single-file doc goal). */
export const SIMPLIFY_AUTOPASS_LINES = 60;

/** Non-empty line count of the snapshot's plan — the auto-pass measure. */
export function planLineCount(snapshot: PhaseSnapshot): number {
	return snapshotPlan(snapshot)
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

/** Pure: does simplify's cut log get waived for this plan? Readiness stays
 * zero-I/O; the caller (index.ts) writes simplifyAutoPassNote to the journal
 * at the transition so the phase never vanishes from the record. */
export function simplifyAutoPasses(snapshot: PhaseSnapshot): boolean {
	const lines = planLineCount(snapshot);
	return lines > 0 && lines <= SIMPLIFY_AUTOPASS_LINES;
}

/** The journal line the harness writes for itself on an auto-passed simplify. */
export function simplifyAutoPassNote(lines: number): string {
	return `auto-pass: plan below threshold (${lines} lines) — simplify waived, no ablation required`;
}

// ---------------------------------------------------------------------------
// phaseDeliverableReady — exit preconditions per phase, deduced from the
// PHASE_PROMPTS contracts in src/prompts.ts. All five planning phases exit
// through the same formless plan_advance tool once ready — review_hld/
// review_final readiness is purely content-derived, exactly like the other
// three; index.ts opens their gate form when plan_advance is called, which
// this predicate never tracks. execute needs the DoD/completion flags a form
// can't derive from plan content alone.
// ---------------------------------------------------------------------------

export function phaseDeliverableReady(phase: Phase, snapshot: PhaseSnapshot): { ready: true } | { ready: false; missing: string[] } {
	const missing: string[] = [];
	switch (phase) {
		case "discovery": {
			// LOCAL MISSION: a goal named and a complete HLD saved via plan_save
			// (## HLD/Scope/Non-goals/Decisions/DoD, ≥1 executable DoD command).
			if (!snapshot.goal) {
				missing.push("no goal stated yet — ask the owner what to design (via plan_intent)");
				break;
			}
			if (snapshot.intentConfirmed !== true) {
				missing.push("objective not confirmed — restate the owner's objective and confirm it via plan_intent");
				break;
			}
			const content = snapshotPlan(snapshot);
			if (!content.trim()) {
				missing.push("no plan saved yet — write the HLD via plan_save");
				break;
			}
			for (const issue of validatePhaseShape("discovery", content)) missing.push(issue.message);
			break;
		}
		case "simplify":
		case "review_hld": {
			// LOCAL MISSION: simplify — the HLD trimmed and still shape-valid, plus
			// a journaled cut log for this phase (or one line: nothing to cut).
			// review_hld — the HLD still shape-valid; readiness is purely
			// content-derived (Gate 1 itself is a harness-owned form, index.ts,
			// opened when the model calls plan_advance — not tracked here). Same
			// shape check for both; only simplify additionally requires the log.
			const content = snapshotPlan(snapshot);
			for (const issue of validatePhaseShape(phase, content)) missing.push(issue.message);
			if (phase === "simplify" && (snapshot.journalEntriesForPhase ?? 0) === 0 && !simplifyAutoPasses(snapshot)) {
				missing.push("no simplification cut-log journaled this phase — journal each cut, or one line why nothing to cut");
			}
			break;
		}
		case "decompose":
		case "review_final": {
			// LOCAL MISSION: decompose — a mechanically valid ## Tasks DAG
			// (deps/owns/done). review_final — the full contract (HLD + validated
			// DAG) still shape-valid; readiness is purely content-derived (Gate 2
			// itself is a harness-owned form, index.ts, opened when the model calls
			// plan_advance — not tracked here). Identical check for both.
			const content = snapshotPlan(snapshot);
			for (const issue of validatePhaseShape(phase, content)) missing.push(issue.message);
			for (const issue of validateTaskGraph(parseTasks(content))) missing.push(issue.task ? `${issue.task}: ${issue.message}` : issue.message);
			break;
		}
		case "execute": {
			// LOCAL MISSION: every task [x] via its own checks, all DoD green
			// through plan_verify, goal completed via plan_complete.
			const tasks = parseTasks(snapshotPlan(snapshot));
			if (tasks.length === 0) {
				missing.push("no tasks in the approved plan — nothing to execute");
				break;
			}
			const remaining = tasks.filter((t) => !t.done);
			if (remaining.length > 0) missing.push(`${remaining.length} task(s) not done — run each done check and mark [x]`);
			if (snapshot.dodPassed !== true) missing.push("DoD not verified green — run plan_verify");
			if (snapshot.completed !== true) missing.push("goal not completed — call plan_complete after all DoD pass");
			break;
		}
	}
	if (missing.length === 0) return { ready: true };
	return { ready: false, missing };
}

// ---------------------------------------------------------------------------
// PHASE_ALLOWED_TOOLS — per-phase tool allowlist. Exploration + web research +
// subagent spawn + store/exit tools are present in every phase; plan_save is
// legal in every phase too (a plan is always writable, whatever the current
// phase). Planning/self-advance/execution tools layer on top per phase's
// role in the flow.
// ---------------------------------------------------------------------------

/** Exploration/read-only + web-research + subagent baseline, present in EVERY phase. */
const BASE_TOOLS: readonly string[] = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"subagent",
	"subagent_wait",
	"web_search",
	"source_check",
	"fetch_content",
	"get_search_content",
];

/** Store/exit tools available in every phase — plan_save included: nothing
 * ever needs to special-case re-adding it for a particular phase. */
const ALWAYS_TOOLS: readonly string[] = ["plan_exit", "plan_recall", "plan_complete", "plan_save"];

/** Form choice + journaling: every phase, including execute (see header note —
 * execute still journals events and stops-and-asks). */
const PLANNING_TOOLS: readonly string[] = ["ask_smart_plan", "journal_append"];

/** Objective-confirmation tool: the five planning phases only — NOT execute.
 * Kept separate from PLANNING_TOOLS (which execute also carries) so execute's
 * surface never grows a tool whose only job is confirming/re-confirming the
 * goal's objective during planning. */
const INTENT_TOOLS: readonly string[] = ["plan_intent"];

/** Formless self-advance: legal in every planning phase — discovery/
 * simplify/review_hld/decompose/review_final all move on their own once
 * phaseDeliverableReady says so. In review_hld/review_final this is the SAME
 * tool that opens the owner-facing gate form (index.ts intercepts the call
 * inside plan_advance) — there is no separate presentation tool to grant. */
const ADVANCE_TOOLS: readonly string[] = ["plan_advance"];

/** Execution workflow tools: execute only. Exported because the Gate-2
 * handoff re-grants exactly these on the turn it briefs (index.ts): the grant
 * issued mid-gate is invisible until a turn actually starts, so the surface
 * has to be re-asserted where the briefing lands. */
export const EXECUTE_TOOLS: readonly string[] = ["plan_verify", "plan_task_update", "plan_next"];

// INVARIANT: all five planning phases — discovery, simplify, review_hld,
// decompose, review_final — share exactly ONE tool surface (BASE + ALWAYS +
// PLANNING + INTENT + ADVANCE), a single Set instance (PLANNING_SURFACE)
// reused across all five keys below. review_hld/review_final need no tool
// beyond that: a field test proved pi's setActiveTools only takes effect on
// the model's NEXT turn, so a mid-run tool GRANT (e.g. handing out a
// presentation tool only inside review phases) never reaches the model that
// would need it in the same run. Only REMOVALS can be enforced mid-run,
// backstopped by the tool_call guard — so review gates are harness-driven
// (index.ts opens the gate form when plan_advance is called) instead of
// tool-driven. INTENT_TOOLS (plan_intent) is part of this shared planning
// surface but deliberately excluded from execute's surface below — objective
// confirmation/re-confirmation is a planning-only concern.
const PLANNING_SURFACE: ReadonlySet<string> = new Set<string>([...BASE_TOOLS, ...ALWAYS_TOOLS, ...PLANNING_TOOLS, ...INTENT_TOOLS, ...ADVANCE_TOOLS]);

export const PHASE_ALLOWED_TOOLS: Record<Phase, ReadonlySet<string>> = {
	discovery: PLANNING_SURFACE,
	simplify: PLANNING_SURFACE,
	review_hld: PLANNING_SURFACE,
	decompose: PLANNING_SURFACE,
	review_final: PLANNING_SURFACE,
	execute: new Set<string>([...BASE_TOOLS, ...ALWAYS_TOOLS, ...PLANNING_TOOLS, ...EXECUTE_TOOLS]),
};

// ---------------------------------------------------------------------------
// FINALIZE_RULES — which tools close an owner-facing turn per phase, and the
// steer text when a turn closes in prose instead. `execute` has no rule (its
// contract is plan_verify/plan_task_update/plan_next, not a structured
// owner-facing close). `discovery` HAS a rule below, but finalizeVerdict only
// enforces it once phaseDeliverableReady("discovery", …) is true — while
// still converging with the owner, a prose close stays legitimate.
// ---------------------------------------------------------------------------

export interface FinalizeRule {
	/** Tools that count as a structured, owner-facing close of the turn. */
	closingToolNames: ReadonlySet<string>;
	/** Firm regeneration text. `attempt` starts at 1 and escalates from 2 on;
	 * `missing` carries the still-open deliverable gaps when known. This is
	 * the stable contract with the caller (index.ts): finalizeVerdict always
	 * hands back attempt 1 via `rule.steer(1, missing)`; the caller owns its
	 * own retry counter and re-invokes `FINALIZE_RULES[phase].steer(attempt,
	 * missing)` directly for attempt ≥ 2, so the escalation text matches the
	 * real attempt number. */
	steer: (attempt: number, missing: string[]) => string;
}

/** Appends the escalation clause at attempt ≥ 2 ("Escalation (attempt N):
 * <hint> — further prose closes will be treated as drift."), else returns
 * `base` unchanged. `hint` is the escalation-specific action clause (e.g.
 * "call plan_advance", "keep closing with X"). Shared by the four steer
 * builders below — the escalation shape (wording, attempt number, drift
 * warning) is byte-identical across them; only `base` and `hint` differ. */
function withEscalation(base: string, attempt: number, hint: string): string {
	return attempt >= 2 ? `${base} Escalation (attempt ${attempt}): ${hint} — further prose closes will be treated as drift.` : base;
}

/** Firm owner-facing steer: cites the phase, the required tool, states the
 * answer was discarded and regenerated, and escalates on later attempts. */
function steerText(phase: string, toolHint: string, attempt: number, missing: string[]): string {
	const gaps = missing.length > 0 ? ` Missing before ${phase} is done: ${missing.join("; ")}.` : "";
	const base =
		`Your ${phase} turn closed in prose — this answer was discarded and regenerated by the harness. ` +
		`End owner-facing turns in ${phase} with ${toolHint}, never plain prose.${gaps}`;
	return withEscalation(base, attempt, `keep closing with ${toolHint}`);
}

/** discovery-only steer: fires exclusively once the deliverable is COMPLETE
 * (finalizeVerdict's readiness gate) — the model prose-closed a mature HLD
 * instead of calling plan_advance. Explicitly forbids the regression this
 * rule exists to kill: asking the owner "how do you want to proceed" after
 * the HLD is already saved. */
function discoveryReadySteer(attempt: number, missing: string[]): string {
	const gaps = missing.length > 0 ? ` Missing before discovery is done: ${missing.join("; ")}.` : "";
	const base =
		"Discovery's deliverable is COMPLETE (goal named, HLD with Scope/Non-goals/Decisions/DoD saved) — the previous close violated the " +
		`closing contract. Continue by calling plan_advance now; never end this turn by asking the owner "how do you want to proceed".${gaps}`;
	return withEscalation(base, attempt, "call plan_advance");
}

/** discovery-only steer for the PRE-intent gap: a run that has already used
 * a tool this turn is investigating, not chatting — a prose-only close from
 * that point on (no plan_intent, no ask_smart_plan) is regenerated, exactly
 * like discoveryReadySteer's post-HLD case above but for the earlier gap
 * (still pre-intent). Distinct from discoveryReadySteer, which only fires
 * once the HLD is fully complete. Prose replies remain legal — they just
 * cannot be the tool-less close of the turn. */
export function discoveryPreIntentSteer(attempt: number): string {
	const base =
		"You already investigated this turn (a tool ran) — that means you are working, not chatting, so this turn must close with " +
		"plan_intent or ask_smart_plan, never a plain-prose plan and never an offer to implement. If any decision with alternatives is " +
		"still open, put it to the owner as an ask_smart_plan form NOW, before plan_intent — never enumerate options in prose. Call " +
		"plan_intent only once nothing is open: propose a kebab-case goal slug and confirm the objective — or call plan_intent " +
		"declaring any open decisions in openQuestions: the harness forms them first, then closes that same call on the objective confirmation.";
	return withEscalation(base, attempt, "close with ask_smart_plan (open decisions) or plan_intent (nothing open)");
}

/** Distinct verdict key for the pre-intent discovery branch (see
 * finalizeVerdict) — lets the caller (index.ts) route to
 * discoveryPreIntentSteer instead of re-deriving FINALIZE_RULES.discovery's
 * generic (and here WRONG) steer for attempt≥2 escalation. */
export const DISCOVERY_PRE_INTENT_KEY = "discovery:pre-intent-prose-close";

/** Tools that legally close a pre-intent discovery turn once investigation
 * has started: plan_save (pre-intent) and journal_append are deliberately
 * excluded — the former is mechanically rejected before plan_intent, the
 * latter would create a spurious goal, and a rejected plan_advance is not a
 * structured close either. */
const PRE_INTENT_CLOSING: ReadonlySet<string> = new Set(["plan_intent", "ask_smart_plan"]);

/** discovery-only steer for the POST-intent gap: once the owner has confirmed
 * the objective, the phase's mandate is structured by definition — there is
 * no "still converging" state left to protect, so this fires UNCONDITIONALLY
 * (unlike discoveryPreIntentSteer, which only arms once investigationDone is
 * true). Distinct from discoveryReadySteer, which only fires once the HLD
 * itself is fully complete; this floors the wider gap in between —
 * post-confirmation grilling turns (STEP 3) that would otherwise close in
 * unpoliced prose. */
export function discoveryPostIntentSteer(attempt: number): string {
	const base =
		"The objective is confirmed — put any open question to the owner as an ask_smart_plan form (its JSON questions vector) now, " +
		"or advance the work: plan_save the HLD, journal_append clarifications, re-run plan_intent if the objective materially changed, " +
		"or plan_advance once the deliverable is complete. NEVER close this turn with bare prose.";
	return withEscalation(base, attempt, "close with ask_smart_plan, plan_save, journal_append or plan_advance");
}

/** Distinct verdict key for the post-intent discovery branch (see
 * finalizeVerdict) — lets the caller (index.ts) route to
 * discoveryPostIntentSteer instead of re-deriving FINALIZE_RULES.discovery's
 * generic (and here WRONG, it names plan_advance as if the HLD were already
 * complete) steer for attempt≥2 escalation. Mirrors DISCOVERY_PRE_INTENT_KEY's
 * role for the earlier gap. */
export const DISCOVERY_POST_INTENT_KEY = "discovery:post-intent-prose-close";

// ---------------------------------------------------------------------------
// Content floor behind the "choices are ALWAYS ask_smart_plan forms" prompt
// rule — the only check in this module that reads what a turn SAID rather
// than how it closed.
// ---------------------------------------------------------------------------

const OPTION_LABEL_LINE = /^\s*(?:[-*•]\s*)?(?:\*\*)?\s*(?:opzione|option)\s+[0-9A-Za-z]\b/i;
const LIST_ITEM_LINE = /^\s*(?:[-*•]\s+|\d+[.)]\s+)/;
const EITHER_OR_MARKERS: readonly RegExp[] = [/\boppure\b/i, /\bin alternativa\b/i, /\balternativamente\b/i, /\balternatively\b/i, /\beither\b[\s\S]{0,120}?\bor\b/i];
/** Courtesy sign-offs that read as choice words but offer nothing: "fatto come
 * preferisci" closes a turn, it does not open one. Stripped before the markers
 * run, so "se preferisci" and "quale preferisci" still count. This also drops
 * the rare genuine "Come preferisci?", which the false-negative bias accepts.
 * English courtesy forms ("as you prefer") match no marker to begin with. */
const COURTESY_PHRASES = /\bcome\s+preferisci\b/gi;
/** Deliberately narrow: every marker is second-person and asks the reader to
 * PICK. Third-person reports ("l'owner preferisce"), diagnostic questions
 * ("quale sia la causa?", "which of them fires first?"), narrative imperatives
 * ("scegli Confirm") and hedges ("your call if that matters") are all choice
 * words in shapes that offer nothing, and each one cost a false positive. */
const CHOICE_REQUEST_MARKERS: readonly RegExp[] = [
	/\bpreferisci\b/i,
	/\bdimmi quale\b/i,
	/\bfammi sapere quale\b/i,
	/\bscegli (?:tu|una|uno|quale)\b/i,
	/\bdecidi tu\b/i,
	/\bwhich\b[^?\n]{0,60}\b(?:would|do)\s+you\b/i,
	/\bdo you prefer\b/i,
];

/** True when the turn offered the owner a pick instead of a form. Biased to
 * false negatives on purpose: regenerating a legitimate answer costs the owner
 * more than a missed catch, in a conversation that is prose-first by design.
 * A hit therefore ALWAYS needs both halves of an actual offer — an
 * enumeration or either-or shape AND a direct second-person request to choose.
 * Labelled options alone are not enough: "- Opzione A: … / - Opzione B: …"
 * reads identically whether it offers a fork or recaps a settled one, so the
 * enumeration only ever counts as the first half. */
export function proposesAlternatives(text: string): boolean {
	if (!text) return false;
	const lines = text.split("\n");
	const enumerated =
		lines.filter((line) => LIST_ITEM_LINE.test(line)).length >= 2 ||
		lines.filter((line) => OPTION_LABEL_LINE.test(line)).length >= 2;
	if (!enumerated && !EITHER_OR_MARKERS.some((re) => re.test(text))) return false;
	const asking = text.replace(COURTESY_PHRASES, " ");
	return CHOICE_REQUEST_MARKERS.some((re) => re.test(asking));
}

/** Tools whose presence means the turn already put the choice to the owner as
 * a form — the compliant close, never steered by the content floor. */
const CHOICE_FLOOR_CLOSING: ReadonlySet<string> = new Set(["ask_smart_plan", "plan_intent"]);

export function isChoiceFloorClosing(toolNamesCalledInLastAssistantTurn: string[]): boolean {
	return toolNamesCalledInLastAssistantTurn.some((name) => CHOICE_FLOOR_CLOSING.has(name));
}

/** Distinct verdict key for the content floor, so the caller routes attempt≥2
 * escalation to choiceFloorSteer instead of the phase's structural steer
 * (which would name plan_advance for a violation that is about the form). */
export function choiceFloorKey(phase: Phase): string {
	return `${phase}:prose-choices`;
}

export function choiceFloorSteer(attempt: number): string {
	const base =
		"Your turn put alternatives to the owner in prose — this answer was discarded and regenerated by the harness. " +
		"Every decision with alternatives goes to the owner as an ask_smart_plan form (its JSON questions vector, one tab per " +
		"open decision), never enumerated in prose. Re-ask that same decision as a form now.";
	return withEscalation(base, attempt, "put every choice to the owner via ask_smart_plan");
}

export const FINALIZE_RULES: Record<Phase, FinalizeRule | null> = {
	discovery: {
		// F4: plan_intent (objective confirmation) and, post-Gate-1-Reject,
		// rework turns closed via plan_save/journal_append also close the turn
		// legally — mirrors the review_* F3 rationale below: a structured tool
		// call that genuinely advanced the deliverable must never be discarded
		// and steered into "call plan_advance now".
		closingToolNames: new Set(["plan_advance", "ask_smart_plan", "plan_intent", "plan_save", "journal_append"]),
		steer: discoveryReadySteer,
	},
	simplify: {
		closingToolNames: new Set(["plan_advance", "plan_save", "journal_append"]),
		steer: (attempt, missing) => steerText("simplify", "plan_advance (after plan_save + journal_append)", attempt, missing),
	},
	decompose: {
		closingToolNames: new Set(["plan_advance", "plan_save"]),
		steer: (attempt, missing) => steerText("decompose", "plan_advance (after plan_save)", attempt, missing),
	},
	review_hld: {
		// F3: plan_save/journal_append also close the turn legally — a gate
		// rejection (or a postponed gate) sends the model back to rework the
		// HLD, and that rework close must not be discarded/steered away.
		closingToolNames: new Set(["plan_advance", "ask_smart_plan", "plan_save", "journal_append"]),
		steer: (attempt, missing) => steerText("review_hld", "plan_advance (opens the Gate 1 form) or ask_smart_plan", attempt, missing),
	},
	review_final: {
		closingToolNames: new Set(["plan_advance", "ask_smart_plan", "plan_save", "journal_append"]),
		steer: (attempt, missing) => steerText("review_final", "plan_advance (opens the Gate 2 form) or ask_smart_plan", attempt, missing),
	},
	execute: null,
};

// ---------------------------------------------------------------------------
// finalizeVerdict — decide whether the last assistant turn closed
// structurally. `key` (phase + cause) drives the caller's retry counter;
// `missing` carries the still-open deliverable gaps for the escalated steer
// (see FinalizeRule.steer's doc for the split of responsibilities with
// index.ts).
// ---------------------------------------------------------------------------

export function finalizeVerdict(
	phase: Phase,
	toolNamesCalledInLastAssistantTurn: string[],
	endedWithText: boolean,
	snapshot: PhaseSnapshot,
): { ok: true } | { ok: false; steer: string; key: string; missing: string[] } {
	// execute is never re-steered.
	if (phase === "execute") return { ok: true };
	const readiness = phaseDeliverableReady(phase, snapshot);
	// discovery only demands a structured close once the deliverable is
	// complete; while still converging, prose is a legitimate close — this is
	// the fix for the "dimmi come vuoi procedere" bug without banning owner
	// conversation during ideation. EXCEPT: once investigation has started
	// (any tool ran) and the objective is still unconfirmed, a run that never
	// enters the machine at all (no plan_intent, no form) is the field-failure
	// this flag floors — regenerate a tool-less prose close with a distinct key.
	if (phase === "discovery" && !readiness.ready) {
		if (snapshot.intentConfirmed !== true && snapshot.investigationDone === true) {
			if (toolNamesCalledInLastAssistantTurn.some((name) => PRE_INTENT_CLOSING.has(name))) return { ok: true };
			if (!endedWithText) return { ok: true };
			return { ok: false, steer: discoveryPreIntentSteer(1), key: DISCOVERY_PRE_INTENT_KEY, missing: readiness.missing };
		}
		// POST-intent: once the owner has confirmed the objective, the phase's
		// mandate is structured by definition — armed UNCONDITIONALLY, no
		// investigationDone precondition (unlike the pre-intent branch above:
		// there is no "just chatting" state left to protect once the objective
		// is locked in). Reuses this phase's own closingToolNames — the same
		// tools that legally close a READY discovery turn also legally close a
		// not-yet-ready post-intent one.
		if (snapshot.intentConfirmed === true) {
			const closingToolNames = FINALIZE_RULES.discovery?.closingToolNames ?? new Set<string>();
			if (toolNamesCalledInLastAssistantTurn.some((name) => closingToolNames.has(name))) return { ok: true };
			if (!endedWithText) return { ok: true };
			return { ok: false, steer: discoveryPostIntentSteer(1), key: DISCOVERY_POST_INTENT_KEY, missing: readiness.missing };
		}
		return { ok: true };
	}
	const rule = FINALIZE_RULES[phase];
	if (!rule) return { ok: true };
	// The turn used a structured closing tool for this phase → legit close.
	if (toolNamesCalledInLastAssistantTurn.some((name) => rule.closingToolNames.has(name))) return { ok: true };
	// The turn ended on a tool result (not prose) — mid-work, not an
	// owner-facing close that needed a form/tool.
	if (!endedWithText) return { ok: true };
	// F3: the owner postponed this review-phase gate — "do not re-open until
	// the owner signals" already told the model to wait, so a prose close
	// (owner Q&A) here is a legitimate close too, not drift.
	if ((phase === "review_hld" || phase === "review_final") && snapshot.gatePostponed) return { ok: true };
	// Prose-only owner-facing close → regenerate with steer, carrying the
	// still-open deliverable gaps.
	const missing = readiness.ready ? [] : readiness.missing;
	return { ok: false, steer: rule.steer(1, missing), key: `${phase}:prose-close`, missing };
}

// ---------------------------------------------------------------------------
// nextActionHint — one-line "Next action: …" guidance after every tool
// result. A READY deliverable must never invite more prose: it names the
// exact next tool call. A NOT-READY deliverable states what's still missing
// (discovery gets a dedicated hint naming the canonical sections, never
// "open a form" — discovery only exits via plan_advance once ready).
// ---------------------------------------------------------------------------

const ADVANCE_READY_HINT = "Next action: the deliverable is complete — call plan_advance.";
// F2: the imperative variant is withheld until the model has actually sat on a
// ready deliverable for a second consecutive turn (see noteReadyHintTurn) — a
// nudge that fires on every save is background noise, not a guardrail.
const ADVANCE_READY_HINT_URGED = "Next action: the deliverable is complete — call plan_advance NOW, do not keep chatting.";
const REVIEW_READY_HINT = "Next action: call plan_advance — the owner's gate form opens.";
const EXECUTE_READY_HINT = "Next action: goal complete — lead with outcome, changed files, verification, residual doubts.";
const DISCOVERY_INTENT_HINT =
	"Next action: restate the owner's objective and confirm it via plan_intent — carrying any still-open decisions in its openQuestions, which the harness resolves first before closing the same call on the confirmation.";
const DISCOVERY_NOT_READY_HINT =
	"Next action: converge on the HLD with the owner, then write ## HLD, ## Scope, ## Non-goals, ## Decisions and ## DoD " +
	"(with at least one executable command) into the plan and save it via plan_save.";

/** F2: per goal+phase tally of consecutive turns closing on a READY deliverable
 * the model did not advance out of. `turn` is the caller's monotonic turn
 * counter; several hints inside one turn collapse into a single tally step. */
export type ReadyHintState = { key: string; count: number; turn: number };

/** Fold one ready-hint emission into the tally and report whether the
 * imperative nudge is now warranted. Pure: the caller (index.ts) owns the
 * mutable state and resets it on phase transition and guard off/on, so a
 * different goal+phase always restarts calm. */
export function noteReadyHintTurn(
	state: ReadyHintState | undefined,
	key: string,
	turn: number,
	ready: boolean,
): { state: ReadyHintState | undefined; urge: boolean } {
	// A not-ready turn is drafting, not sitting on a finished deliverable: it
	// breaks the streak outright instead of freezing it, so legitimate rework can
	// never bank credit toward the imperative nudge and hand it to the first
	// genuinely ready turn.
	if (!ready) return { state: undefined, urge: false };
	const next: ReadyHintState =
		state?.key !== key
			? { key, count: 1, turn }
			: state.turn === turn
				? state
				: { key, count: state.count + 1, turn };
	return { state: next, urge: next.count >= 2 };
}

/** Phases that self-advance via the formless plan_advance tool once ready. */
const ADVANCE_PHASES: ReadonlySet<Phase> = new Set<Phase>(["discovery", "simplify", "decompose"]);
/** Phases that exit only through their owner-facing gate form once ready. */
const REVIEW_PHASES: ReadonlySet<Phase> = new Set<Phase>(["review_hld", "review_final"]);

export function nextActionHint(phase: Phase, snapshot: PhaseSnapshot, urge = false): string {
	const verdict = phaseDeliverableReady(phase, snapshot);
	if (verdict.ready) {
		if (ADVANCE_PHASES.has(phase)) return urge ? ADVANCE_READY_HINT_URGED : ADVANCE_READY_HINT;
		if (REVIEW_PHASES.has(phase)) return REVIEW_READY_HINT;
		return EXECUTE_READY_HINT; // execute
	}
	if (phase === "discovery") {
		if (!snapshot.goal || snapshot.intentConfirmed !== true) return DISCOVERY_INTENT_HINT;
		return DISCOVERY_NOT_READY_HINT;
	}
	return `Next action: ${verdict.missing[0]}.`;
}
