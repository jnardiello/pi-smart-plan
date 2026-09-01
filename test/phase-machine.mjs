// Unit tests for the pure phase machine — src/phase-machine.ts + the parts of
// src/plan-validate.ts it re-uses (phase enum, save-time deliverable-shape
// validation) + src/plan-store.ts's isPlanningPhase + src/abandon.ts's pure
// in-process abandon-grace timer. Run: node test/phase-machine.mjs
import {
	PHASES,
	PHASE_ALLOWED_TOOLS,
	FINALIZE_RULES,
	phaseDeliverableReady,
	finalizeVerdict,
	nextActionHint,
	noteReadyHintTurn,
	DISCOVERY_PRE_INTENT_KEY,
	discoveryPreIntentSteer,
	DISCOVERY_POST_INTENT_KEY,
	discoveryPostIntentSteer,
	proposesAlternatives,
	isChoiceFloorClosing,
	choiceFloorKey,
	choiceFloorSteer,
	SIMPLIFY_AUTOPASS_LINES,
	planLineCount,
	simplifyAutoPasses,
	simplifyAutoPassNote,
} from "../src/phase-machine.ts";
import { validatePhaseShape, shapeErrorMessage } from "../src/plan-validate.ts";
import { isPlanningPhase } from "../src/plan-store.ts";
import {
	DEFAULT_ABANDON_GRACE_MS,
	setAbandonGraceMs,
	getAbandonGraceMs,
	scheduleAbandon,
	cancelAbandon,
	hasPendingAbandon,
} from "../src/abandon.ts";

let failures = 0;
function check(name, cond) {
	if (cond) console.log(`  ok  ${name}`);
	else { failures++; console.log(`FAIL  ${name}`); }
}

// ---------------------------------------------------------------------------
// Plan-content fixtures — every heading below is canonical English per
// validatePhaseShape's REQUIRED_SECTIONS unless a fixture explicitly tests
// the Italian-headings rejection path.
// ---------------------------------------------------------------------------

// Complete discovery/simplify/review_hld deliverable: all five required
// sections, non-empty, ## DoD carries one executable command, no ## Tasks.
const COMPLETE_HLD = `# Plan: demo

## HLD
Dated design covering the whole shape end to end.

## Scope
Design and document the demo feature end to end.

## Non-goals
No implementation happens in this phase.

## Decisions
- queue: none needed for this scope

## DoD
- echo ok
`;

// Same shape, above SIMPLIFY_AUTOPASS_LINES — a plan big enough that simplify
// still demands a real cut log (F5's auto-pass must NOT fire here).
const BIG_HLD = COMPLETE_HLD.replace("## Decisions", `## Decisions\n${Array.from({ length: 70 }, (_, i) => `- decision ${i}: weighed and recorded`).join("\n")}`);

// Same shape, plus a valid 2-task DAG (T2 deps on T1, disjoint owns, both
// carry a done: check) — satisfies decompose/review_final's task requirement.
const COMPLETE_WITH_TASKS = `${COMPLETE_HLD.trimEnd()}

## Tasks

- [ ] T1: first
  deps: []
  owns: [src/a]
  done: echo t1
- [ ] T2: second
  deps: [T1]
  owns: [src/b]
  done: echo t2
`;

// No canonical headings at all — Italian section names throughout. Drives the
// missing-sections diagnostic (found headings + canonical-names note).
const ITALIAN_HEADINGS = `# Piano: demo

## Alto livello
Progettazione dettagliata e già completa.

## Decisioni chiuse
- coda: non necessaria

## Fase 1
- primo passo
`;

// Canonical headings, but ## DoD holds only a comment line — no executable
// command for parseDoD to pick up. This shape rule has no other coverage
// anywhere in the suite (the task-level "done:" check is a different field).
const MISSING_DOD_EXEC = `# Plan: demo

## HLD
Dated design covering the whole shape end to end.

## Scope
Design and document the demo feature end to end.

## Non-goals
No implementation happens in this phase.

## Decisions
- queue: none needed for this scope

## DoD
# no concrete command listed yet
`;

// Canonical English headings, Italian body text — must PASS (only headings
// are language-constrained). Used as the ONE positive validatePhaseShape
// case below: richer than a plain-English pass, since it also proves the
// language-agnostic-body rule.
const ITALIAN_BODY_CANONICAL_HEADINGS = `# Piano: demo

## HLD
Progettazione dettagliata e già completa, pronta per la revisione.

## Scope
Ambito: progettare e documentare la funzionalità demo end-to-end.

## Non-goals
Nessuna implementazione avviene in questa fase.

## Decisions
- coda: non necessaria per questo ambito

## DoD
- echo ok
`;

// execute doesn't run validatePhaseShape (only parseTasks) — minimal content.
const EXECUTE_DONE = `# Plan: demo

## Tasks

- [x] T1: first
  deps: []
  owns: [src/a]
  done: echo t1
`;

console.log("\n[PHASES — six-phase order]");
check("PHASES is the six canonical phase names, in order",
	JSON.stringify([...PHASES]) === JSON.stringify(["discovery", "simplify", "review_hld", "decompose", "review_final", "execute"]));
check("isPlanningPhase is true for the five planning phases, false for execute", PHASES.every((p) => isPlanningPhase(p) === (p !== "execute")));

console.log("\n[PHASE_ALLOWED_TOOLS]");
check("allowlist covers all six phases", PHASES.every((p) => PHASE_ALLOWED_TOOLS[p] instanceof Set));
check("ALWAYS_TOOLS class present in every phase (plan_save/plan_exit/plan_recall/plan_complete/ask_smart_plan/journal_append)",
	["plan_save", "plan_exit", "plan_recall", "plan_complete", "ask_smart_plan", "journal_append"].every((t) => PHASES.every((p) => PHASE_ALLOWED_TOOLS[p].has(t))));
{
	const planningPhases = ["discovery", "simplify", "review_hld", "decompose", "review_final"];
	const [first, ...rest] = planningPhases.map((p) => PHASE_ALLOWED_TOOLS[p]);
	check("the five planning phases share exactly ONE tool surface (set-equal)",
		rest.every((s) => s.size === first.size && [...first].every((t) => s.has(t))));
}
check("plan_advance/plan_intent present in every planning phase, absent from execute; plan_present/plan_approve absent from ALL phases (deleted tools)",
	PHASES.every((p) => PHASE_ALLOWED_TOOLS[p].has("plan_advance") === (p !== "execute") && PHASE_ALLOWED_TOOLS[p].has("plan_intent") === (p !== "execute")) &&
	PHASES.every((p) => !PHASE_ALLOWED_TOOLS[p].has("plan_present") && !PHASE_ALLOWED_TOOLS[p].has("plan_approve")));
check("execute-only tools (plan_verify/plan_task_update/plan_next) only in execute",
	["plan_verify", "plan_task_update", "plan_next"].every((t) => PHASE_ALLOWED_TOOLS.execute.has(t) && PHASES.every((p) => p === "execute" || !PHASE_ALLOWED_TOOLS[p].has(t))));
check("base exploration/web/subagent tools everywhere",
	["read", "bash", "grep", "find", "ls", "subagent", "subagent_wait", "web_search", "source_check", "fetch_content", "get_search_content"].every((t) => PHASES.every((p) => PHASE_ALLOWED_TOOLS[p].has(t))));

console.log("\n[validatePhaseShape — one pass + fail-with-diagnostic cases]");
check("Italian body under canonical English headings PASSES (only headings are language-constrained)", validatePhaseShape("discovery", ITALIAN_BODY_CANONICAL_HEADINGS).length === 0);
{
	const issues = validatePhaseShape("discovery", ITALIAN_HEADINGS);
	check("Italian headings → exactly one diagnostic issue, listing the headings actually found + the canonical-English-names note",
		issues.length === 1 && issues[0]?.message.includes("## Decisioni chiuse") && issues[0]?.message.includes("## Fase 1") && issues[0]?.message.includes("## Alto livello") &&
		issues[0]?.message.includes("CANONICAL ENGLISH names") && issues[0]?.message.includes("body text may be in any language"));
}
check("missing-DoD-executable detected (comment-only ## DoD) — no other coverage of this shape rule",
	validatePhaseShape("discovery", MISSING_DOD_EXEC).some((i) => i.message.includes("## DoD has no executable command line")));

console.log("\n[shapeErrorMessage]");
check("message starts with 'plan_save rejected' and names the phase",
	shapeErrorMessage("discovery", validatePhaseShape("discovery", ITALIAN_HEADINGS)).startsWith("plan_save rejected") &&
	shapeErrorMessage("decompose", validatePhaseShape("decompose", COMPLETE_HLD)).includes('"decompose"'));

console.log("\n[phaseDeliverableReady — one ready + one not-ready per phase, compact]");
check("discovery not-ready: no goal stated (names plan_intent)", phaseDeliverableReady("discovery", {}).missing.some((m) => m.includes("no goal stated yet") && m.includes("plan_intent")));
check("discovery ready: goal + intent confirmed + complete HLD", phaseDeliverableReady("discovery", { goal: "demo", intentConfirmed: true, planContent: COMPLETE_HLD }).ready === true);
check("simplify ready: valid HLD + journaled cut", phaseDeliverableReady("simplify", { planContent: COMPLETE_HLD, journalEntriesForPhase: 1 }).ready === true);
check(
	"simplify not-ready: no journal entry this phase (plan ABOVE the auto-pass threshold)",
	phaseDeliverableReady("simplify", { planContent: BIG_HLD }).missing.some((m) => m.includes("cut-log journaled")),
);

// F5 — simplify auto-pass: an ablation pass on a tiny plan produces invented
// cuts, so the cut log is waived below the threshold (the harness journals it).
console.log("\n[F5 — simplify auto-pass below the size threshold]");
check(`SIMPLIFY_AUTOPASS_LINES is ${SIMPLIFY_AUTOPASS_LINES}; COMPLETE_HLD sits under it, BIG_HLD over it`, planLineCount({ planContent: COMPLETE_HLD }) <= SIMPLIFY_AUTOPASS_LINES && planLineCount({ planContent: BIG_HLD }) > SIMPLIFY_AUTOPASS_LINES);
check("planLineCount ignores blank lines", planLineCount({ planContent: "a\n\n\n  \nb" }) === 2);
check("small plan auto-passes, big plan does not", simplifyAutoPasses({ planContent: COMPLETE_HLD }) === true && simplifyAutoPasses({ planContent: BIG_HLD }) === false);
check("an EMPTY plan never auto-passes (it fails the shape check instead)", simplifyAutoPasses({ planContent: "" }) === false && simplifyAutoPasses({}) === false);
check(
	"small plan + zero journal entries → simplify READY (cut log waived)",
	phaseDeliverableReady("simplify", { planContent: COMPLETE_HLD }).ready === true,
);
check(
	"auto-pass waives ONLY the cut log — a shape-invalid small plan is still not ready",
	phaseDeliverableReady("simplify", { planContent: "# Plan: x\n\n## HLD\nonly this\n" }).ready === false,
);
check("simplifyAutoPassNote carries the auto-pass marker and the measured size", simplifyAutoPassNote(12).includes("auto-pass") && simplifyAutoPassNote(12).includes("12 lines"));
check("review_hld is unaffected by the auto-pass (it never required a cut log)", phaseDeliverableReady("review_hld", { planContent: BIG_HLD }).ready === true);
// review_hld/review_final: readiness is content shape only — Gate 1/2 are
// harness-owned forms opened by plan_advance (index.ts), not tracked here.
check("review_hld ready: valid HLD content alone", phaseDeliverableReady("review_hld", { planContent: COMPLETE_HLD }).ready === true);
check("review_hld not-ready: shape-invalid content", phaseDeliverableReady("review_hld", { planContent: ITALIAN_HEADINGS }).missing.some((m) => m.includes("missing required section")));
check("decompose ready: valid task DAG", phaseDeliverableReady("decompose", { planContent: COMPLETE_WITH_TASKS }).ready === true);
check("decompose not-ready: no tasks at all", phaseDeliverableReady("decompose", { planContent: COMPLETE_HLD }).missing.some((m) => m.includes("no tasks in ## Tasks")));
check("review_final ready: valid DAG alone", phaseDeliverableReady("review_final", { planContent: COMPLETE_WITH_TASKS }).ready === true);
check("review_final not-ready: no tasks at all", phaseDeliverableReady("review_final", { planContent: COMPLETE_HLD }).missing.some((m) => m.includes("no tasks in ## Tasks")));
check("execute ready: all tasks done + DoD green + completed", phaseDeliverableReady("execute", { planContent: EXECUTE_DONE, dodPassed: true, completed: true }).ready === true);
{
	const execMissing = phaseDeliverableReady("execute", { planContent: COMPLETE_WITH_TASKS }).missing;
	check("execute not-ready: pending tasks + DoD + completion all listed",
		execMissing.some((m) => m.includes("task(s) not done")) && execMissing.some((m) => m.includes("plan_verify")) && execMissing.some((m) => m.includes("plan_complete")));
}

console.log("\n[finalizeVerdict — snapshot-aware]");
check("FINALIZE_RULES covers all six phases; only execute has no rule",
	Object.keys(FINALIZE_RULES).length === 6 && FINALIZE_RULES.execute === null && ["discovery", "simplify", "decompose", "review_hld", "review_final"].every((p) => FINALIZE_RULES[p] !== null));
{
	// Closing sets — ONE data-driven loop over every planning phase × a
	// representative tool set, checked through the real finalizeVerdict
	// behavior (not just the raw closingToolNames data).
	const CLOSING_SETS = {
		discovery: ["plan_advance", "ask_smart_plan", "plan_intent", "plan_save", "journal_append"],
		simplify: ["plan_advance", "plan_save", "journal_append"],
		decompose: ["plan_advance", "plan_save"],
		review_hld: ["plan_advance", "ask_smart_plan", "plan_save", "journal_append"],
		review_final: ["plan_advance", "ask_smart_plan", "plan_save", "journal_append"],
	};
	const ALL_CLOSE_TOOLS = ["plan_advance", "ask_smart_plan", "plan_save", "journal_append", "plan_intent"];
	check("closing-tool legality matches FINALIZE_RULES.closingToolNames for every planning phase × tool (one data-driven loop)",
		Object.entries(CLOSING_SETS).every(([phase, names]) =>
			ALL_CLOSE_TOOLS.every((tool) => finalizeVerdict(phase, [tool], true, {}).ok === names.includes(tool))));
}
check("prose-only close (no tools) → NOT ok; turn ending on a tool result (not text) → ok regardless",
	finalizeVerdict("simplify", [], true, {}).ok === false && finalizeVerdict("simplify", [], false, {}).ok === true);
check("execute always ok (prose or with tools, mid-work — no finalize rule at all)",
	finalizeVerdict("execute", [], true, {}).ok === true && finalizeVerdict("execute", ["plan_verify"], false, {}).ok === true);
// F3(ii): a prose close (no closing tool) in a review phase is legal ONLY
// while the gate is flagged postponed; otherwise it still steers. Backs the
// smoke-suite's integration-level "postponed gate prose close" case.
check("review_hld/review_final: prose close steers unless gatePostponed:true (which makes it legal); no effect on a non-review phase",
	finalizeVerdict("review_hld", [], true, {}).ok === false && finalizeVerdict("review_hld", [], true, { gatePostponed: true }).ok === true &&
	finalizeVerdict("review_final", [], true, { gatePostponed: true }).ok === true &&
	finalizeVerdict("simplify", [], true, { gatePostponed: true }).ok === false);

console.log("\n[finalizeVerdict — the conditional discovery case]");
check("prose close in discovery with an INCOMPLETE deliverable → ok (still converging)", finalizeVerdict("discovery", [], true, {}).ok === true);
{
	const readySnapshot = { goal: "demo", intentConfirmed: true, planContent: COMPLETE_HLD };
	const fv = finalizeVerdict("discovery", [], true, readySnapshot);
	check("prose close in discovery with a READY deliverable → NOT ok, steer names plan_advance, key is phase+cause, missing is an empty array",
		fv.ok === false && fv.steer.includes("plan_advance") && fv.key === "discovery:prose-close" && Array.isArray(fv.missing) && fv.missing.length === 0);
	// F4: discovery's closing set also includes plan_intent/plan_save/
	// journal_append — a post-Gate-1-Reject rework turn (re-elicit + re-save)
	// closes legally too, never discarded and steered into "call plan_advance".
	check("discovery ready: plan_intent/plan_save/journal_append each close the turn legally (rework closes)",
		["plan_intent", "plan_save", "journal_append"].every((tool) => finalizeVerdict("discovery", [tool], true, readySnapshot).ok === true));
}

console.log("\n[finalizeVerdict — discovery PRE-intent investigation gap (mechanical floor under 'never enters the machine')]");
{
	// Field-failure shape: empty store (no goal at all), a tool already ran
	// this run, objective still unconfirmed, turn closes in prose.
	const preIntentInvestigated = { investigationDone: true };
	const fv1 = finalizeVerdict("discovery", [], true, preIntentInvestigated);
	check("pre-intent + investigated + prose close → NOT ok, distinct key, steer names plan_intent and ask_smart_plan",
		fv1.ok === false && fv1.key === DISCOVERY_PRE_INTENT_KEY && fv1.key !== "discovery:prose-close" &&
		fv1.steer.includes("plan_intent") && fv1.steer.includes("ask_smart_plan"));
	check("investigationDone false/absent, still pre-intent → still ok (pre-intent gate doesn't apply without investigation)",
		finalizeVerdict("discovery", [], true, { investigationDone: false }).ok === true &&
		finalizeVerdict("discovery", [], true, {}).ok === true);
	// Once intent IS confirmed, the pre-intent gate never fires (its own
	// precondition requires intentConfirmed !== true) — the POST-intent floor
	// takes over instead (see the dedicated POST-intent section below), it does
	// NOT fall through to "still ok" the way it used to before that floor existed.
	check("intent already confirmed → the PRE-intent key never fires (its key is reserved for the unconfirmed case)",
		finalizeVerdict("discovery", [], true, { goal: "demo", intentConfirmed: true, investigationDone: true, planContent: "" }).key !== DISCOVERY_PRE_INTENT_KEY);
	check("closing set: plan_intent/ask_smart_plan close the pre-intent-investigated turn legally; plan_save/journal_append/plan_advance do not",
		["plan_intent", "ask_smart_plan"].every((tool) => finalizeVerdict("discovery", [tool], true, preIntentInvestigated).ok === true) &&
		["plan_save", "journal_append", "plan_advance"].every((tool) => finalizeVerdict("discovery", [tool], true, preIntentInvestigated).ok === false));
	check("pre-intent investigated turn ending on a tool result (not text) → ok regardless",
		finalizeVerdict("discovery", [], false, preIntentInvestigated).ok === true);
	const p1 = discoveryPreIntentSteer(1);
	const p2 = discoveryPreIntentSteer(2);
	check("discoveryPreIntentSteer names both closing tools at attempt 1, escalates and differs at attempt 2",
		p1.includes("plan_intent") && p1.includes("ask_smart_plan") && !p1.includes("Escalation") &&
		p2.includes("Escalation") && p2.includes("attempt 2") && p1 !== p2);
	// Reordered contract: an open decision goes to a form BEFORE plan_intent —
	// plan_intent only once nothing is open — and options are never enumerated
	// in prose. The "before plan_intent" ordering is asserted textually (the
	// form clause names plan_intent as what it precedes) rather than by
	// substring index, which would be a fragile proxy for the same claim.
	check("discoveryPreIntentSteer: open decisions go to an ask_smart_plan form NOW, BEFORE plan_intent; plan_intent only once nothing is open; never options in prose; openQuestions cited as the plan_intent-side channel",
		p1.includes("ask_smart_plan form NOW, before plan_intent") &&
		p1.includes("plan_intent only once nothing is open") &&
		p1.includes("never enumerate options in prose") &&
		p1.includes("declaring any open decisions in openQuestions") &&
		p1.includes("the harness forms them"));
}

console.log("\n[finalizeVerdict — discovery POST-intent gap (mechanical floor, armed UNCONDITIONALLY once confirmed)]");
{
	// Not-ready deliverable, objective already confirmed (mid post-confirmation
	// grilling, STEP 3) — no investigationDone field at all, proving the floor
	// arms unconditionally (unlike the pre-intent gap above).
	const postIntentSnapshot = { goal: "demo", intentConfirmed: true };
	const fv2 = finalizeVerdict("discovery", [], true, postIntentSnapshot);
	check("post-intent + not-ready + prose close → NOT ok, distinct key (≠ pre-intent key), steer matches discoveryPostIntentSteer(1), names ask_smart_plan and plan_save, never a 'before plan_intent' ordering",
		fv2.ok === false && fv2.key === DISCOVERY_POST_INTENT_KEY && fv2.key !== DISCOVERY_PRE_INTENT_KEY &&
		fv2.steer === discoveryPostIntentSteer(1) &&
		fv2.steer.includes("ask_smart_plan") && fv2.steer.includes("plan_save") && !fv2.steer.includes("before plan_intent"));
	check("post-intent not-ready turn closing via journal_append or plan_save → ok (structured close, not a prose-only turn)",
		finalizeVerdict("discovery", ["journal_append"], true, postIntentSnapshot).ok === true &&
		finalizeVerdict("discovery", ["plan_save"], true, postIntentSnapshot).ok === true);
	check("pre-intent branch unchanged by the new post-intent floor: still returns its own distinct key",
		finalizeVerdict("discovery", [], true, { investigationDone: true }).key === DISCOVERY_PRE_INTENT_KEY &&
		DISCOVERY_PRE_INTENT_KEY !== DISCOVERY_POST_INTENT_KEY);
}

console.log("\n[finalizeVerdict — escalation mechanism (FinalizeRule.steer, attempt 1 vs 2)]");
{
	const s1 = FINALIZE_RULES.simplify.steer(1, []);
	const s2 = FINALIZE_RULES.simplify.steer(2, []);
	check("attempt 1 has no escalation marker, attempt 2 escalates and differs from attempt 1", !s1.includes("Escalation") && s2.includes("Escalation") && s2.includes("attempt 2") && s1 !== s2);
	check("steer surfaces missing gaps", FINALIZE_RULES.simplify.steer(1, ["## HLD missing"]).includes("## HLD missing"));
}
{
	const d1 = FINALIZE_RULES.discovery.steer(1, []);
	const d2 = FINALIZE_RULES.discovery.steer(2, []);
	check("discovery steer names plan_advance + COMPLETE at attempt 1, escalates and differs at attempt 2",
		d1.includes("plan_advance") && d1.includes("COMPLETE") && d2.includes("Escalation") && d2.includes("attempt 2") && d1 !== d2);
	// discoveryReadySteer fires on a FOLLOWUP message — the flagged turn's own
	// answer is never discarded/regenerated (unlike a true re-generation), so
	// the steer text must not claim otherwise.
	check("discovery steer never claims the answer was 'discarded' (it's a followUp, the answer stays) — names the real violation instead",
		!d1.includes("discarded") && d1.includes("previous close violated the closing contract"));
}

console.log("\n[nextActionHint — one loop over phases]");
check("hint always a 'Next action:' line, across every phase (ready or not)", PHASES.every((p) => nextActionHint(p, {}).startsWith("Next action:")));
check("every planning-ready phase's hint mentions plan_advance; execute-ready mentions verification instead (no tool name)",
	["discovery", "simplify", "decompose", "review_hld", "review_final"].every((p) => {
		const snapshot = p === "decompose" || p === "review_final" ? { goal: "demo", intentConfirmed: true, planContent: COMPLETE_WITH_TASKS } : { goal: "demo", intentConfirmed: true, planContent: COMPLETE_HLD, journalEntriesForPhase: 1 };
		return nextActionHint(p, snapshot).includes("plan_advance");
	}) && nextActionHint("execute", { planContent: EXECUTE_DONE, dodPassed: true, completed: true }).includes("verification"));
check("discovery no-goal / no-intent (absent or intentConfirmed:false) → identical hint naming plan_intent, never plan_save/plan_advance",
	[{}, { goal: "demo" }, { goal: "demo", intentConfirmed: false }].every((snap) => {
		const h = nextActionHint("discovery", snap);
		return h.includes("plan_intent") && !h.includes("plan_save") && !h.includes("plan_advance");
	}) && nextActionHint("discovery", { goal: "demo", intentConfirmed: false }) === nextActionHint("discovery", {}));
check("discovery intent confirmed but incomplete → canonical-sections hint, not the intent hint",
	(() => { const h = nextActionHint("discovery", { goal: "demo", intentConfirmed: true }); return ["## HLD", "## Scope", "## Non-goals", "## Decisions", "## DoD"].every((s) => h.includes(s)) && !h.includes("plan_intent"); })());

console.log("\n[F2 — conditional nudge: the imperative NOW-hint is earned, not automatic]");
{
	const READY_HLD = { goal: "demo", intentConfirmed: true, planContent: COMPLETE_HLD, journalEntriesForPhase: 1 };
	const URGE = "NOW, do not keep chatting";
	check("ready + first eligible turn → calm hint: names plan_advance, NO imperative",
		["discovery", "simplify", "decompose"].every((p) => {
			const snapshot = p === "decompose" ? { goal: "demo", intentConfirmed: true, planContent: COMPLETE_WITH_TASKS } : READY_HLD;
			const h = nextActionHint(p, snapshot, false);
			return h.includes("plan_advance") && !h.includes(URGE);
		}));
	check("ready + urge → the imperative variant, still a 'Next action:' line",
		(() => { const h = nextActionHint("simplify", READY_HLD, true); return h.startsWith("Next action:") && h.includes(URGE); })());
	check("a NOT-ready deliverable never urges — guidance is unconditional, only the imperative is gated",
		nextActionHint("decompose", READY_HLD, true) === nextActionHint("decompose", READY_HLD, false));

	// (1) first eligible turn stays calm, (2) the second consecutive one urges.
	const t1 = noteReadyHintTurn(undefined, "demo:simplify", 1, true);
	check("(1) first eligible turn on a goal+phase → count 1, no urge", t1.urge === false && t1.state.count === 1);
	const t1b = noteReadyHintTurn(t1.state, "demo:simplify", 1, true);
	check("several hints inside the SAME turn collapse into one tally step (no urge from a chatty turn)",
		t1b.urge === false && t1b.state.count === 1 && t1b.state === t1.state);
	const t2 = noteReadyHintTurn(t1b.state, "demo:simplify", 2, true);
	check("(2) second consecutive eligible turn → urge", t2.urge === true && t2.state.count === 2);
	check("and it keeps urging while the model sits on it", noteReadyHintTurn(t2.state, "demo:simplify", 3, true).urge === true);

	// (3) the expected call ran → the phase moved → the tally restarts calm.
	// index.ts also drops the state outright in transitionPhase; keying by
	// goal+phase makes that belt-and-braces, not the only line of defence.
	const advanced = noteReadyHintTurn(t2.state, "demo:decompose", 3, true);
	check("(3) advancing the phase resets the tally — the new phase opens calm", advanced.urge === false && advanced.state.count === 1);
	check("a different goal in the same phase is tallied separately",
		noteReadyHintTurn(t2.state, "other:simplify", 4, true).urge === false);
	// (6) guard off/on: index.ts clears the state, which restarts the tally.
	check("(6) a cleared state (guard off/on, restoreTools) restarts calm",
		noteReadyHintTurn(undefined, "demo:simplify", 9, true).urge === false);

	// (7) NOT-READY turns are drafting, not sitting: they must never bank credit.
	// Pre-fix, the tally ran on every planning-tool result regardless of readiness,
	// so two legitimate drafting turns handed the imperative nudge to the very
	// first turn the deliverable was actually done.
	const d1 = noteReadyHintTurn(undefined, "demo:discovery", 1, false);
	const d2 = noteReadyHintTurn(d1.state, "demo:discovery", 2, false);
	check("(7) a not-ready turn neither urges nor banks credit (tally cleared)",
		d1.urge === false && d1.state === undefined && d2.urge === false && d2.state === undefined);
	const d3 = noteReadyHintTurn(d2.state, "demo:discovery", 3, true);
	check("(7) two not-ready turns then the FIRST genuinely ready one → still calm, count restarts at 1",
		d3.urge === false && d3.state.count === 1);
	const d4 = noteReadyHintTurn(d3.state, "demo:discovery", 4, true);
	check("(7) mutation check: the gate narrows the tally, it does NOT disable it — a second consecutive READY turn still urges",
		d4.urge === true && d4.state.count === 2);

	// (8) a not-ready turn mid-streak breaks it: readiness must be consecutive.
	const broken = noteReadyHintTurn(t2.state, "demo:simplify", 5, false);
	const resumed = noteReadyHintTurn(broken.state, "demo:simplify", 6, true);
	check("(8) a not-ready turn mid-streak resets an already-urging tally — the next ready turn opens calm again",
		broken.urge === false && broken.state === undefined && resumed.urge === false && resumed.state.count === 1);
}

console.log("\n[F6 — per-turn investigation latch: the pre-intent floor reads the CURRENT turn only]");
{
	// index.ts clears investigationDone at every owner turn start, so the flag
	// finalizeVerdict sees means "a tool ran in THIS turn". Both readings are
	// pinned here; the reset wiring itself is integration-level (see report).
	const preIntent = { goal: "demo", intentConfirmed: false, planContent: "" };
	check("(4) tool ran in the current turn + prose close → steered (pre-intent floor armed)",
		finalizeVerdict("discovery", [], true, { ...preIntent, investigationDone: true }).ok === false);
	check("(5) tool ran only in an EARLIER turn (latch cleared) + pure prose close → no steer",
		finalizeVerdict("discovery", [], true, { ...preIntent, investigationDone: false }).ok === true);
}

console.log("\n[proposesAlternatives — content floor: fires on offered choices, silent on everything else]");
{
	// POSITIVES — the shapes the rule exists to catch.
	check("either-or in prose + a direct request to pick → detected (the field failure this floor was built for)",
		proposesAlternatives(
			"Lo mitigherei mostrando il pannello completo solo sulle chiusure, non su in_progress — oppure, se preferisci, " +
				"collassando a una riga per wave. Dimmi quale delle due mitigazioni preferisci e apriamo un piano.",
		) === true);
	check("labelled options + a second-person request → detected (the labels are only ever half the evidence)",
		proposesAlternatives("Ecco come procedere:\n- Opzione A: riusare il renderer esistente\n- Opzione B: scriverne uno nuovo\nQuale preferisci?") === true);
	check("two numbered proposals + 'quale preferisci' → detected",
		proposesAlternatives("1. Mostrare il pannello solo su done\n2. Collassare le chiusure ravvicinate\nQuale preferisci?") === true);
	check("English either/or + 'which one' → detected",
		proposesAlternatives("We can either reuse the existing renderer or write a fresh one. Which one would you rather ship?") === true);

	// NEGATIVES — the heart of the task: the detector must stay silent.
	check("plain discursive prose → silent",
		proposesAlternatives("Ho letto il floor esistente: giudica solo la struttura del turno e non ispeziona mai il contenuto.") === false);
	check("bulleted SUMMARY of work done (no choice offered) → silent",
		proposesAlternatives("Fatto:\n- aggiunto il rilevatore puro\n- cablato agent_settled\n- coperto con test") === false);
	check("list of changed files closing with a generic 'fammi sapere' → silent (generic confirmation is not a choice)",
		proposesAlternatives("File cambiati:\n- src/phase-machine.ts\n- index.ts\n- test/smoke.mjs\nFammi sapere se va bene.") === false);
	check("'or'/'oppure' used non-alternatively, no request to pick → silent",
		proposesAlternatives("Il file o la cartella esistono già, quindi la scrittura è idempotente.") === false);
	check("short acknowledgement → silent", proposesAlternatives("Ok, fatto.") === false);
	check("empty text → silent", proposesAlternatives("") === false);
	check("a single labelled option (not a fork) → silent",
		proposesAlternatives("Ho seguito l'Opzione A concordata nel form.") === false);
	check("enumeration WITHOUT any request to choose → silent (enumeration alone never fires)",
		proposesAlternatives("Il piano ha tre task:\n- T1 renderer\n- T2 floor\n- T3 README") === false);

	// FIELD COUNTEREXAMPLES — every one of these fired before the detector was
	// tightened. They are the regression floor: a false positive regenerates a
	// legitimate answer, which is strictly worse than a missed catch.
	check("CE1 recap of options ALREADY DECIDED → silent (labels alone no longer fire)",
		proposesAlternatives("Decisioni:\n- Opzione A: riusare il renderer (confermata)\n- Opzione B: scartata\nProcedo con A.") === false);
	check("CE2 third-person 'preferisce' + a file list → silent (a report about the owner is not a request to the owner)",
		proposesAlternatives("L'owner preferisce l'approccio incrementale.\n\nFile:\n- src/phase-machine.ts\n- index.ts") === false);
	check("CE3 diagnostic 'quale sia la causa?' after a list → silent",
		proposesAlternatives("Due file:\n- a.ts\n- b.ts\nNon so quale sia la causa?") === false);
	check("CE4 diagnostic 'Which of them fires first?' after a list → silent (no second person, no offer)",
		proposesAlternatives("Two hooks:\n- turn_end\n- agent_settled\nWhich of them fires first?") === false);
	check("CE5 investigative either-or about reality → silent",
		proposesAlternatives("Il path è un file oppure una directory. Quale dei due stiamo vedendo?") === false);
	check("CE6 'scegli Confirm' as a narrative instruction step → silent",
		proposesAlternatives("Passi:\n- apri il piano\n- scegli Confirm") === false);
	check("CE7 'alternatively' + hedged 'your call' while proceeding → silent",
		proposesAlternatives("Alternatively, if the store is empty, discovery is the default. Your call if that matters; I'm proceeding.") === false);
	check("CE8 courtesy 'come preferisci' sign-off + a file list → silent",
		proposesAlternatives("Fatto come preferisci.\n\nFile toccati:\n- src/render.ts\n- index.ts") === false);
	check("CE8b English courtesy sign-off + a file list → silent (matches no marker to begin with)",
		proposesAlternatives("Done as you prefer.\n\nFiles:\n- src/render.ts\n- index.ts") === false);
	check("CE8 does not blunt the real offer: 'oppure, se preferisci' still fires",
		proposesAlternatives("Lo mitigherei mostrando il pannello solo alle chiusure — oppure, se preferisci, collassando a una riga per wave. Come procediamo?") === true);
	check("CE8 strips only the courtesy occurrence: a second, real 'se preferisci' still fires",
		proposesAlternatives("Fatto come preferisci.\n- a.ts\n- b.ts\nPosso invertirlo, se preferisci.") === true);
}
{
	// Wiring contract consumed by index.ts.
	check("isChoiceFloorClosing: a turn that opened a form is never steered",
		isChoiceFloorClosing(["ask_smart_plan"]) === true && isChoiceFloorClosing(["plan_intent"]) === true);
	check("isChoiceFloorClosing: plan_save/journal_append are NOT form closes",
		isChoiceFloorClosing(["plan_save", "journal_append"]) === false && isChoiceFloorClosing([]) === false);
	check("choiceFloorKey is per-phase and distinct from the structural prose-close key",
		choiceFloorKey("discovery") === "discovery:prose-choices" && choiceFloorKey("discovery") !== "discovery:prose-close");
	check("choiceFloorSteer names ask_smart_plan at attempt 1 and escalates at attempt 2",
		choiceFloorSteer(1).includes("ask_smart_plan") && !choiceFloorSteer(1).includes("Escalation") &&
		choiceFloorSteer(2).includes("Escalation (attempt 2)") && choiceFloorSteer(2) !== choiceFloorSteer(1));
}

console.log("\n[src/abandon.ts — pure in-process abandon-grace timer, cwd-keyed, compact battery]");
const CWD_A = "/tmp/abandon-unit-repo-a";
const CWD_B = "/tmp/abandon-unit-repo-b";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

check("DEFAULT_ABANDON_GRACE_MS is 10s; getAbandonGraceMs() reports it as the initial effective grace", DEFAULT_ABANDON_GRACE_MS === 10_000 && getAbandonGraceMs() === DEFAULT_ABANDON_GRACE_MS);
setAbandonGraceMs(20); // small override for the rest of this battery — real awaits stay fast
check("getAbandonGraceMs() reflects the override", getAbandonGraceMs() === 20);
{
	// schedule + fire.
	let fired = false;
	check("hasPendingAbandon(cwd) false before any schedule", hasPendingAbandon(CWD_A) === false);
	scheduleAbandon(CWD_A, () => { fired = true; });
	check("hasPendingAbandon(cwd) true right after scheduling", hasPendingAbandon(CWD_A) === true);
	await sleep(100);
	check("scheduled callback fires within the overridden grace; hasPendingAbandon clears itself after firing", fired === true && hasPendingAbandon(CWD_A) === false);
}
{
	// replace: scheduling twice for the SAME cwd clears the first handle — only the second fire runs.
	const calls = [];
	scheduleAbandon(CWD_A, () => calls.push("first"));
	scheduleAbandon(CWD_A, () => calls.push("second"));
	await sleep(100);
	check("scheduling twice for the same cwd replaces the pending handle — only the second fire runs, exactly once", calls.length === 1 && calls[0] === "second");
}
{
	// cancel: true while pending (callback never fires), false when idle.
	let fired = false;
	scheduleAbandon(CWD_A, () => { fired = true; });
	const canceledWhilePending = cancelAbandon(CWD_A);
	await sleep(100);
	check("cancelAbandon(cwd): true while pending, the callback then never fires, false when idle afterward",
		canceledWhilePending === true && fired === false && cancelAbandon(CWD_A) === false);
}
{
	// F1: two distinct cwds get fully independent timers.
	let firedA = false;
	let firedB = false;
	scheduleAbandon(CWD_A, () => { firedA = true; });
	scheduleAbandon(CWD_B, () => { firedB = true; });
	const canceledA = cancelAbandon(CWD_A);
	await sleep(100);
	check("scheduling/canceling for A never touches B's independently pending/firing timer",
		canceledA === true && firedA === false && firedB === true && hasPendingAbandon(CWD_A) === false && hasPendingAbandon(CWD_B) === false);
}

setAbandonGraceMs(DEFAULT_ABANDON_GRACE_MS); // restore the real default — other suites/processes must not inherit a tiny test-only grace
check("getAbandonGraceMs() restored to the default at teardown", getAbandonGraceMs() === DEFAULT_ABANDON_GRACE_MS);

console.log(failures === 0 ? "\nALL PHASE-MACHINE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
