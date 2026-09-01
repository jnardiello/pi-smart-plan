/**
 * pi-smart-plan — read-only plan mode for pi.
 *
 * Plan mode is OWNER-ONLY: it can be engaged exclusively by the user
 * (shift+tab toggle, /plan, /plan-guard on, --plan flag). The model has no
 * tool to activate it and no unilateral way out — plan_exit always requires
 * an affirmative user confirmation through the native dialog.
 *
 * While active the session is truly read-only:
 * - edit/write are REMOVED from the active tool set (the model cannot see them);
 * - bash is restricted to a read-only allowlist (src/bash-guard.ts);
 * - subagents ARE allowed but inherit the same guard: the parent spawns
 *   them with PI_SMART_PLAN=1 in their env, and the children self-restrict
 *   to read-only exploration (no phase machine, no planning UI);
 * - other state-mutating tools (chrome interaction, unknown/extensions)
 *   are removed and additionally blocked as a backstop;
 * - the only write path is the extension-owned external store via
 *   plan_save / journal_append / plan_complete — the model never handles
 *   store paths.
 *
 * The plan is written into the external store via plan_save / journal_append.
 */
import { execFileSync } from "node:child_process";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runAskForm, runAskFormPages, type AskQuestionInput } from "./src/ask-form.ts";
import { GLOBAL_CONSTRAINTS, PHASE_CAPTIONS, PHASE_PROMPTS, SUBAGENT_CONSTRAINTS, planBootstrapMessage } from "./src/prompts.ts";
import { phaseMissionLine, renderIntentPanel, renderPlanPanel, toolRenderers } from "./src/render.ts";
import { PHASES, type Phase } from "./src/plan-validate.ts";
import { isReadOnlyCommand } from "./src/bash-guard.ts";
import {
	PHASE_ALLOWED_TOOLS,
	FINALIZE_RULES,
	finalizeVerdict,
	nextActionHint,
	phaseDeliverableReady,
	DISCOVERY_PRE_INTENT_KEY,
	discoveryPreIntentSteer,
	DISCOVERY_POST_INTENT_KEY,
	discoveryPostIntentSteer,
	type PhaseSnapshot,
} from "./src/phase-machine.ts";
import { savePlan, appendJournal, recall, approvedGoals, completeGoal, confirmIntent, currentPhase, getDoD, getPlanView, gitStagedFiles, goalExists, goalIsDone, goalSummaries, isPartiallyStaged, isPlanningPhase, journalEntriesSincePhaseStart, nextTasks, persistApproved, purgeTombstone, readIntent, readMachinePhase, readPlan, restoreTombstonedGoal, setMachinePhase, storeRoot, tombstoneActiveGoal, updateTaskStatus, validateGoalSlug, OBJECTIVE_MAX_LEN, PlanStoreValidationError, type PlanView } from "./src/plan-store.ts";
import { cancelAbandon, getAbandonGraceMs, scheduleAbandon } from "./src/abandon.ts";
import { startLiveWatch } from "./src/live-watch.ts";

const STORE_KEY = "plan-guard";
const STATUS_KEY = "plan-guard";
const MESSAGE_TYPE = "smart-plan";
const BASH_BLOCK_REASON =
	"Plan mode is active — bash is limited to read-only commands (ls, rg, cat, git status/diff/log, …). " +
	"Persist plans via plan_save / journal_append; repo changes wait until the user exits plan mode (plan_exit).";
/** plan_intent's explicit rejection — identical text whether the owner picks
 * "Keep chatting" or dismisses the form with Esc: nothing is created, the
 * objective is rejected, and the model returns to the conversation to
 * re-elicit before re-opening plan_intent. */
const INTENT_KEEP_CHATTING_TEXT = "the owner rejected this objective — keep chatting, re-elicit, and re-open plan_intent when it's right";

/** plan_intent's openQuestions — a trimmed ask_smart_plan question shape
 * (question, header?, options[] as a bare string or {label, description})
 * used as the confirmation-step safety net: if the model reaches plan_intent
 * with open decisions still in hand, declaring them here elicits the same
 * paged form ask_smart_plan renders (models fill fields they can see),
 * resolved BEFORE any OBJECTIVE card or Confirm/Keep-chatting form. */
const OPEN_QUESTION_SCHEMA = Type.Object({
	question: Type.String(),
	header: Type.Optional(Type.String()),
	options: Type.Array(
		Type.Union([Type.String(), Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) })]),
		{ minItems: 2, maxItems: 4 },
	),
});

/** Self-advance table for the formless plan_advance tool — discovery/simplify/
 * decompose only. review_hld/review_final/execute have no entry: plan_advance
 * intercepts those two phases itself (re-opening the owner gate rather than
 * looking up a target here), and their own targets (decompose / execute) are
 * decided by runReviewGate's routing, shared with ask_smart_plan's phaseGate
 * branch; execute exits via plan_complete, not a phase advance. The machine
 * never jumps phases. */
const PHASE_NEXT: Record<Phase, Phase | undefined> = {
	discovery: "simplify",
	simplify: "review_hld",
	review_hld: undefined,
	decompose: "review_final",
	review_final: undefined,
	execute: undefined,
};

/** Session flags the phase-deliverable snapshot can't derive from plan content
 * alone. Session-global (not per-goal) — reset in restoreTools (guard off);
 * never duplicated into the store. */
const sessionState = {
	dodPassed: false,
	completed: false,
};

/** Subagent children (guard inherited via PI_SMART_PLAN) are EXPLORATION-ONLY:
 * they must never touch the shared parent-owned plan store, the planning UI or
 * guard-control tools (ask_smart_plan / plan_exit would mutate or gate parent
 * state). Strict exploration: reading, read-only bash, web research and nested
 * subagent spawn only. */
const CHILD_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"web_search",
	"source_check",
	"fetch_content",
	"get_search_content",
	"subagent",
	"subagent_wait",
]);

/** Phase-aware tool surface for the CURRENT phase (parent only). When no goal
 * is set yet the phase is discovery. A pure lookup into PHASE_ALLOWED_TOOLS —
 * plan_save is already present in every phase there, so no re-add hack is
 * needed here (the phase-machine module stays the single source of truth). */
function phaseAllowedTools(ctx: { cwd: string }): ReadonlySet<string> {
	if (isSubagentChild) return CHILD_MODE_ALLOWED_TOOLS;
	const current = displayPhase(ctx.cwd);
	const phase = current?.phase ?? "discovery";
	return PHASE_ALLOWED_TOOLS[phase];
}

/** Error text for a failed store tool. Validation errors (safe, no paths) are
 * forwarded verbatim; anything else (fs errors with absolute store paths embedded)
 * maps to a generic message so store locations never leak to the model. */
function safeError(operation: string, error: unknown): string {
	const message = error instanceof PlanStoreValidationError ? error.message : "plan store I/O error";
	return `${operation} failed: ${message}`;
}

/** Standard single-text-block tool result, success shape — the common
 * `{content:[{type:"text",…}],details,isError:false}` literal every tool's
 * execute() returns on its non-error paths, collapsed to one call. isError
 * is explicit (not omitted) so it matches every existing call site, several
 * of which already asserted `isError === false` literally. */
function ok(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details, isError: false as const };
}

/** Standard single-text-block tool result, refusal shape — the same literal
 * as ok() with isError forced true. */
function refuse(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details, isError: true as const };
}

/** F2/F6: guard plan_intent's TARGET goal directly — reading readMachinePhase/
 * goalIsDone for `goal` itself, never the session pointer — so an unpointed
 * goal (past discovery, or already archived in done/) refuses just as
 * reliably as a pointed one. Returns the refusal text, or undefined when the
 * goal is confirmable. Called both before the form opens and (F6) again
 * right before confirmIntent writes, so a parallel tool call cannot slip a
 * goal switch/lock/completion past the pre-form checks while the owner was
 * answering. */
function intentGuardViolation(cwd: string, goal: string): string | undefined {
	const machinePhase = readMachinePhase(cwd, goal);
	if (machinePhase !== undefined && machinePhase !== "discovery") {
		return "the objective is locked after discovery — it can only be restated if Gate 1 sends the plan back";
	}
	if (goalIsDone(cwd, goal)) {
		return `"${goal}" is already completed — plan_intent cannot reopen it; re-opening a completed goal happens automatically on the next plan_save`;
	}
	return undefined;
}

/** Shared TOCTOU guard pair for plan_intent's target goal: the goal-switch
 * lock (another goal already mid-planning) and intentGuardViolation (locked
 * post-discovery / already done). Run identically before the form opens and
 * again (F6) right before confirmIntent writes — both call sites stay, only
 * the duplicated check logic is shared here. Returns the refuse()-shaped
 * result, or undefined when the goal is confirmable.
 *
 * The goal-switch lock is deliberately read off `sessionGoal` alone, never
 * the shared active.txt pointer: "one active goal per session" means the
 * session that already claimed a goal, so a SECOND pi session on the same
 * repo can still start its own plan while the first one is mid-planning. */
function intentRefusal(cwd: string, goal: string): ReturnType<typeof refuse> | undefined {
	const claimed = ownedGoal(cwd);
	const owned = claimed ? currentPhase(cwd, claimed) : null;
	if (owned && owned.goal !== goal && isPlanningPhase(owned.phase)) {
		return refuse(`one active goal per session — complete or abandon "${owned.goal}" first`);
	}
	const violation = intentGuardViolation(cwd, goal);
	if (violation) return refuse(violation);
	return undefined;
}

/** "Q: <question>\nA: <answer>" blocks for every collected answer — the
 * shared base formatting for both ask_smart_plan's ordinary form path and
 * plan_intent's openQuestions safety net. Each caller still appends its own
 * UNANSWERED/ANSWER RULE lines on top (their declined-branch handling
 * differs). */
function collectedBlocks(collected: { answers: Record<string, unknown> }): string[] {
	return Object.entries(collected.answers).map(([q, a]) => `Q: ${q}\nA: ${Array.isArray(a) ? a.join(", ") : a}`);
}

/** Single-select label from a form answer: the string itself, or the first
 * item of a multi-select array; undefined for anything else. Shared by
 * runReviewGate's fixed-label routing and plan_intent's Confirm/Keep-chatting
 * routing. */
function pickLabel(answer: unknown): string | undefined {
	return typeof answer === "string" ? answer : Array.isArray(answer) ? answer[0] : undefined;
}

let enabled = false;

/** The goal THIS session owns — set when this session confirms an objective
 * via plan_intent, cleared when it completes, abandons or purges that goal.
 * Module-level state is per-session by construction (one extension process
 * per session), exactly like `enabled`; it is persisted into the session
 * transcript alongside the guard flag so a reload/resume restores it.
 *
 * The store's active.txt pointer is repo-wide and shared by every session on
 * the same repo, so it cannot answer "which goal does THIS session act on".
 * This does: undefined means the session has not claimed a goal and falls
 * back to the shared pointer (single-session behavior, unchanged).
 *
 * The cwd is part of the binding because a goal slug only means anything
 * inside its own repo store — a goal claimed under one cwd must never
 * resolve against another's.
 *
 * `adopted` marks a claim the session took by acting on the pointer rather
 * than by the owner confirming an objective (see adoptPhase): it owns the goal
 * for every purpose here, but it is re-derived from the pointer on the next
 * user-initiated mutating call, so a single session that moves on to another
 * goal follows the pointer exactly as it did before claims existed. An
 * owner-confirmed claim is never re-derived. */
let sessionGoal: { cwd: string; goal: string; adopted?: boolean } | undefined;

/** The goal this session has claimed under `cwd`, or undefined. */
function ownedGoal(cwd: string): string | undefined {
	return sessionGoal?.cwd === cwd ? sessionGoal.goal : undefined;
}

/** OWNING resolution: only the goal this session has claimed, and only while
 * that claim still resolves. Never falls back to the repo-wide pointer, so no
 * path built on it can write, advance or destroy a goal this session does not
 * own. Every mutating and every automatic path resolves through here.
 *
 * A claim on a goal that no longer resolves (completed, abandoned or purged by
 * another session) yields null — the session owns nothing — but the claim
 * itself is deliberately NOT cleared: clearing it would make the session
 * indistinguishable from one that never claimed anything, and adoption would
 * then hand it another session's goal. */
function ownedPhase(cwd: string): { goal: string; phase: Phase } | null {
	const claimed = ownedGoal(cwd);
	return claimed ? currentPhase(cwd, claimed) : null;
}

/** DISPLAY resolution: the owned goal, otherwise the repo-wide pointer. The
 * fallback is legitimate here and only here — an unclaimed session is meant to
 * keep SEEING what other sessions on the same repo are planning. Read paths
 * only: tool surface, prompt injection, widget, status line, summaries and
 * message text. Anything that mutates or destroys state uses ownedPhase. */
function displayPhase(cwd: string): { goal: string; phase: Phase } | null {
	return ownedPhase(cwd) ?? currentPhase(cwd);
}

/** True when this extension instance runs inside a pi-subagents child that
 * inherited the parent's plan mode via PI_SMART_PLAN. Such children are
 * read-only explorers only: they get a dedicated constraint prompt instead
 * of the phase state machine and no planning UI/status. */
let isSubagentChild = false;

/** A steer message is pending regeneration: skip the next prose-close verdict
 * if the run is our own regeneration (prevents steering our own steers). */
let regenInFlight = false;

/** Prose-close retries against the CURRENT phase (finalize-retry battery).
 * Reset on a real owner turn, on guard off/on, and on every successful phase
 * advance — a stale counter would otherwise eat a fresh phase's retry budget
 * or, worse, skip its first steer (B2). */
let retryCount = 0;

/** True while a blocking extension UI form (ask_smart_plan) is open. The
 * finalize-retry steer must never fire while the owner is actually answering
 * a form — the model is legitimately waiting on the form result, not drifting
 * in prose (B3). */
let uiPromptOpen = false;

/** F2: reentrancy latch for runReviewGate. pi runs tools in parallel by
 * default — two gate calls landing in the same assistant message (e.g.
 * plan_advance called twice, or plan_advance + ask_smart_plan{phaseGate})
 * must never open two independent forms or route two answers. Set at entry,
 * cleared in a `finally` so it can never get stuck open. */
let gateFormOpen = false;

/** F3: true when the CURRENT review-phase gate was last resolved as postponed
 * rather than approved/rejected/authorized. Fed into buildPhaseSnapshot so
 * finalizeVerdict can treat a prose owner-facing close as legal instead of
 * steering it away while the owner is expected to signal separately. Cleared
 * on any real transitionPhase and whenever a gate form actually (re-)opens;
 * set only by an actual postpone outcome inside runReviewGate. Session-local
 * by design — see PhaseSnapshot.gatePostponed's doc for the accepted
 * restart/guard-cycle tradeoff. */
let gatePostponed = false;

/** True once ANY tool has run (a permitted tool_call) during the current
 * pre-intent investigation, parent runs only. Latched unconditionally by the
 * tool_call handler on every allowed call (bash-allowed and allowlist-pass
 * paths alike) — cross-run persistence is required: the field failure this
 * floors is scout-in-run-1, prose-close-in-run-2. Fed into buildPhaseSnapshot
 * so finalizeVerdict's discovery branch can regenerate a tool-less prose
 * close instead of letting a model that never enters the machine go
 * unpoliced. Session-local by design: reset on guard off/on (restoreTools)
 * and on plan_intent's Confirm (anti-leak across a later goal in the same
 * session) — see PhaseSnapshot.investigationDone's doc for the accepted
 * restart/guard-cycle tradeoff. */
let investigationDone = false;

/** Deliver a plan request as a custom message: content goes to the LLM, the
 * TUI shows only the single-line renderer. Idle → trigger a turn immediately;
 * busy → queue as a non-interrupting followUp. */
function sendPlan(pi: ExtensionAPI, ctx: ExtensionContext, content: string, goal: string): void {
	const payload = { customType: MESSAGE_TYPE, content, display: true, details: { goal } };
	if (ctx.isIdle()) {
		pi.sendMessage(payload, { triggerTurn: true });
	} else {
		pi.sendMessage(payload, { deliverAs: "followUp" });
	}
}

function syncStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, enabled ? "PLAN" : undefined);
}

const WIDGET_KEY = "smart-plan";
const PRESENT_ENTRY_KEY = "plan-present";
const INTENT_ENTRY_KEY = "plan-intent-proposal";
let lastCwd: string | undefined;
function noteCwd(ctx: ExtensionContext): void {
	lastCwd = ctx.cwd;
}

/** renderPlanPanel / renderIntentPanel now live in ./src/render.ts (pure,
 * testable — see that file's doc comment) and are imported above; the
 * entry-renderer wiring below is unchanged. */

/** Compact, store-derived contract summary (goal, scope, non-goals, DoD and
 * the wave/task list). Injected into the approval form's briefing so the owner
 * sees the real contract regardless of chat prose. Line-oriented by design:
 * the form wraps every line through wrapTextWithAnsi when rendering. */
function buildContractSummary(view: PlanView): string {
	const lines: string[] = [`CONTRACT — ${view.goal}`];
	if (view.intent) lines.push(`OBJECTIVE: ${view.intent}`);
	if (view.scope) lines.push(`SCOPE: ${view.scope}`);
	if (view.nonGoals) lines.push(`NON-GOALS: ${view.nonGoals}`);
	if (view.dod.length) lines.push(`DoD: ${view.dod.join(" && ")}`);
	const waves: string[] = [];
	let wave = -1;
	for (const task of view.tasks) {
		if (task.wave !== wave) {
			wave = task.wave;
			waves.push(`WAVE ${wave}: ${task.id} ${task.title}`);
		} else {
			waves[waves.length - 1] += ` · ${task.id} ${task.title}`;
		}
	}
	lines.push(...waves);
	return lines.join("\n");
}

/** "⚠ STAGED FILES PREFLIGHT" block appended to Gate 2's form detail when
 * pre-existing staged files are present — pi-subagents' worker acceptance
 * rejects every write-worker while ANY file is staged, so the owner needs to
 * see this before deciding how to proceed. */
function buildStagedPreflight(staged: { code: string; path: string }[]): string {
	const lines = ["⚠ STAGED FILES PREFLIGHT", "pi-subagents will reject every worker while these files are staged:"];
	for (const entry of staged) {
		lines.push(`${entry.code} ${entry.path}`);
		if (isPartiallyStaged(entry.code)) {
			lines.push("  index differs from worktree — unstaging keeps the worktree content but drops the staged split; consider committing instead");
		}
	}
	return lines.join("\n");
}

/** Live working-message text for a phase — the short owner-facing caption,
 * not the model's LOCAL MISSION text (far too long for a status line). Set at
 * every transitionPhase and on plan-mode activation; pi never resets
 * setWorkingMessage on its own, so every enable/disable path pairs a set with
 * an explicit reset. */
function phaseWorkingMessage(phase: Phase): string {
	return `◈ plan · ${phase} — ${PHASE_CAPTIONS[phase]}`;
}

/** Deliver the Gate-2 authorization + execute kickoff on a FRESH turn (same
 * idle/busy pattern as sendPlan): pi's setActiveTools only takes effect on
 * the model's NEXT turn, so the tool surface set(ctx, false, …) just
 * restored is invisible mid-run — queuing the briefing instead of returning
 * it inline lets the model actually see the full surface it needs. */
function queueImplementationBriefing(pi: ExtensionAPI, ctx: ExtensionContext, goal: string): void {
	const content =
		"(APPROVED by owner — plan mode released. The owner's answer IS the authorization: start implementing NOW. Do not ask for confirmation again.)\n\n" +
		phaseMissionLine("execute");
	sendPlan(pi, ctx, content, goal);
}

/** Heat ramp for the phase bar: starts neutral gray, warms up to vivid
 * orange as the plan approaches completion (fixed xterm-256 hues, deliberately
 * theme-independent). Transparency effect: upcoming cells show their future
 * hue at low density (░░), reached ones burn at full density (██). */
const PHASE_HEAT: Record<Phase, number> = {
	discovery: 243, // neutral gray
	simplify: 179, // tan-orange
	review_hld: 172, // dark orange
	decompose: 208, // orange
	review_final: 214, // bright orange
	execute: 202, // deep orange-red
};

const RESET = "\x1b[0m";
const heatFg = (code: number) => `\x1b[38;5;${code}m`;

/** Mini-pixel bar: one double-width cell per phase in its heat color.
 * Reached phases render as bright ██ (current = bold), upcoming as ░░ in the
 * same hue — the full gradient is always visible, position always readable. */
function buildHeatBar(current: Phase | null): string {
	const currentIdx = current === null ? PHASES.length : PHASES.indexOf(current);
	const cells = PHASES.map((phase, i) => {
		const color = heatFg(PHASE_HEAT[phase]);
		if (i < currentIdx) return `${color}██${RESET}`;
		if (i === currentIdx) return `\x1b[1m${color}██${RESET}`;
		return `${color}░░${RESET}`;
	}).join("");
	return `${heatFg(240)}▐${RESET}${cells}${heatFg(240)}▌${RESET}`;
}

/** Live state-machine view (Codex update_plan parity): themed phase pipeline
 * plus per-goal progress and ready frontier, rendered above the editor. */
function refreshWidget(ctx: ExtensionContext): void {
	if (!enabled) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
		const lines: string[] = [];
		const own = displayPhase(ctx.cwd);
		const current = own?.phase ?? "discovery";
		lines.push(theme.fg("accent", theme.bold("◈ PLAN MODE")) + theme.fg("muted", " · read-only"));
		const usage = ctx.getContextUsage();
		const usageText = usage?.percent != null ? theme.fg("muted", ` · ctx ${Math.round(usage.percent)}%`) : "";
		lines.push(`${buildHeatBar(current)}  ${theme.fg("accent", theme.bold(current))}${usageText}`);
		// Every active goal in the repo stays listed — including goals other
		// sessions are driving — with a ▸ cursor on the one this session acts on.
		const goals = goalSummaries(ctx.cwd, own?.goal);
		for (const goal of goals) lines.push(theme.fg("muted", `  ${goal}`));
		if (current === "discovery" && goals.length === 0) {
			lines.push(theme.fg("muted", "  → tell me what you want to design together"));
		}
		return { render: (width = 80) => lines.map((l) => truncateToWidth(l, width)), invalidate: () => {} };
	});
}

/** Progressive disclosure: inject ONLY the current phase's instructions (+
 * global constraints). While the guard is off, keep the execute block alive
 * while an approved goal is still in flight (execution/delivery). */
function planInjection(cwd: string): string | undefined {
	if (enabled) {
		// Subagent children under parent plan mode never run the plan workflow:
		// drive them with a dedicated read-only exploration contract instead.
		if (isSubagentChild) return `${GLOBAL_CONSTRAINTS}\n\n${SUBAGENT_CONSTRAINTS}`;
		const current = displayPhase(cwd);
		const phase = current?.phase ?? "discovery";
		return `${GLOBAL_CONSTRAINTS}\n\n${PHASE_PROMPTS[phase]}`;
	}
	const current = displayPhase(cwd);
	if (current?.phase === "execute") return `${GLOBAL_CONSTRAINTS}\n\n${PHASE_PROMPTS.execute}`;
	return undefined;
}

/** Fresh-activation cleanup, shared by set()'s ON branch (no pending grace
 * timer) and session_start's `--plan` flag branch — never by a plain session
 * resume. Purges any tombstone left behind by a killed process (age-agnostic:
 * a tombstone surviving to a fresh activation always means a dead process or
 * a lapsed grace, never a live in-process timer). Then the H1 sweep: if the
 * goal THIS session owns still names a goal stuck mid-planning with no
 * tombstone (kill-while-planning, no grace ever armed), tombstone-and-purge it
 * immediately so a fresh activation always starts clean. The sweep is
 * automatic and destructive, so it resolves through ownedPhase alone: a
 * session that has claimed nothing sweeps nothing, and can never discard a
 * plan another session on the same repo is driving. Returns
 * every goal actually discarded by this sweep (leftover-tombstone purge
 * and/or the H1 tombstone-and-purge — usually at most one, but both CAN fire
 * in the same call) so the caller can notify the owner, same as every other
 * discard path. */
function sweepStaleGoal(cwd: string): string[] {
	const purged: string[] = [];
	const leftover = purgeTombstone(cwd);
	if (leftover) purged.push(leftover);
	const owned = ownedPhase(cwd);
	if (!owned) return purged;
	const machinePhase = readMachinePhase(cwd, owned.goal) ?? "discovery";
	if (isPlanningPhase(machinePhase)) {
		tombstoneActiveGoal(cwd, owned.goal);
		const swept = purgeTombstone(cwd);
		if (swept) purged.push(swept);
	}
	// A discarded goal is no longer this session's to act on. Both callers
	// persist the guard state right after, so the transcript stays in sync.
	const claimed = ownedGoal(cwd);
	if (claimed && purged.includes(claimed)) sessionGoal = undefined;
	return purged;
}

export default function planGuard(pi: ExtensionAPI): void {
	/** Active-tool snapshot taken on first engagement, restored on exit. */
	let toolsBeforePlanMode: string[] | undefined;

	/** Stops the store poller that keeps the widget live against other
	 * sessions' writes; undefined while no poller is running. */
	let stopLiveWatch: (() => void) | undefined;

	/** Assemble the PhaseSnapshot the phase machine's deliverable checks need,
	 * from the store (plan content + journal-since-phase-start) and session
	 * flags. Slim by design (see PhaseSnapshot's doc): no text heuristics, no
	 * legacy gate flags — readiness comes entirely from validatePhaseShape plus
	 * the facts content can't self-report (execute's DoD/completion state). */
	function buildPhaseSnapshot(ctx: { cwd: string }, current: { goal: string; phase: Phase } | null): PhaseSnapshot {
		if (!current) return { planContent: "", investigationDone };
		const planContent = readPlan(ctx.cwd, current.goal);
		return {
			goal: current.goal,
			planContent,
			// F1: derived from the goal's own journal.md (journalEntriesSincePhaseStart
			// scans for the LAST `[→ <to>] ` marker transitionPhase journals) —
			// restart-proof and per-goal, no session-local baseline to lose or leak.
			journalEntriesForPhase: journalEntriesSincePhaseStart(ctx.cwd, current.goal),
			dodPassed: sessionState.dodPassed,
			completed: sessionState.completed,
			gatePostponed,
			intentConfirmed: readIntent(ctx.cwd, current.goal) !== null,
			investigationDone,
		};
	}

	/** Shared snapshot→readiness→refuse check for the three "current phase's
	 * deliverable isn't ready" call sites (ask_smart_plan's phaseGate branch,
	 * plan_advance re-opening a review phase, plan_advance's self-advance).
	 * `prefix` and `extraDetails` are the only per-site variance (message
	 * wording, details shape) — snapshot build, readiness check, hint and the
	 * `missing` detail field are identical across all three. Returns the
	 * refuse()-shaped result, or undefined when the deliverable is ready. */
	function deliverableBlocked(
		ctx: { cwd: string },
		current: { goal: string; phase: Phase },
		prefix: string,
		extraDetails: Record<string, unknown>,
	): ReturnType<typeof refuse> | undefined {
		const snapshot = buildPhaseSnapshot(ctx, current);
		const verdict = phaseDeliverableReady(current.phase, snapshot);
		if (verdict.ready) return undefined;
		const hint = nextActionHint(current.phase, snapshot);
		return refuse(`${prefix}. Missing: ${verdict.missing.join("; ")}. ${hint}`, { ...extraDetails, missing: verdict.missing });
	}

	pi.registerFlag("plan", {
		description: "Start with the read-only plan guard engaged",
		type: "boolean",
		default: false,
	});

	function restrictTools(ctx: { cwd: string }): void {
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		const allowed = phaseAllowedTools(ctx);
		pi.setActiveTools(toolsBeforePlanMode.filter((name) => allowed.has(name)));
		// Propagate the guard to pi-subagents children: they inherit process.env
		// from the spawner and self-activate the read-only guard on session_start.
		process.env.PI_SMART_PLAN = "1";
	}

	function restoreTools(): void {
		if (toolsBeforePlanMode !== undefined) pi.setActiveTools(toolsBeforePlanMode);
		toolsBeforePlanMode = undefined;
		delete process.env.PI_SMART_PLAN;
		// B2: a guard off/on cycle must not leak the prose-close retry budget or
		// a pending regeneration latch into the next planning session.
		retryCount = 0;
		regenInFlight = false;
		sessionState.dodPassed = false;
		sessionState.completed = false;
		investigationDone = false;
	}

	/** Shared phase-transition sequence — the ONLY way the machine advances:
	 * used by plan_advance's self-advance and by both review_* gates. Journals
	 * a UNIFORM `[→ <to>] ` marker line — journalEntriesSincePhaseStart
	 * (plan-store.ts) derives the simplify cut-log count straight from it, so
	 * there is no session-local baseline here to reset, lose on a guard
	 * off/on cycle, or leak across goals (F1). Also resets the prose-close
	 * retry budget, the pending regeneration latch and the postponed-gate flag
	 * before re-cutting the tool surface for the new phase. */
	function transitionPhase(ctx: ExtensionContext, goal: string, to: Phase, journalLine: string): void {
		setMachinePhase(ctx.cwd, goal, to);
		appendJournal(ctx.cwd, goal, `[→ ${to}] ${journalLine}`);
		retryCount = 0;
		regenInFlight = false;
		gatePostponed = false;
		refreshWidget(ctx);
		restrictTools(ctx);
		ctx.ui.setWorkingMessage(phaseWorkingMessage(to));
	}

	/** Persist guard flag + owned goal into the session transcript, the single
	 * mechanism session_start reads back on reload/resume/fork. `tools` is a
	 * parameter rather than a read of toolsBeforePlanMode because the
	 * `--plan` activation path deliberately persists no tool snapshot. */
	function persistGuardState(tools: string[] | undefined): void {
		pi.appendEntry(STORE_KEY, { enabled, tools, goal: sessionGoal?.goal });
	}

	/** Claim (or release) the goal this session acts on, persisting it so a
	 * reload/resume restores the same binding. */
	function setSessionGoal(cwd: string, goal: string | undefined, adopted = false): void {
		sessionGoal = goal ? { cwd, goal, adopted } : undefined;
		persistGuardState(toolsBeforePlanMode);
	}

	/** Owning resolution for USER-INITIATED mutating tool calls (plan_advance,
	 * the owner gate). An owner-confirmed claim resolves exactly like ownedPhase
	 * — including to null once it goes dead, so a session never silently takes
	 * over the goal another session moved the pointer to. With no claim, or with
	 * a previously adopted one, the pointer's goal is adopted here and now: a
	 * single session driving the store keeps working exactly as before, and the
	 * goal it acts on becomes explicit state instead of an implicit fallback.
	 *
	 * Only user-initiated tool calls reach this. Sweep, tombstone and every other
	 * automatic path resolve through ownedPhase and adopt nothing. */
	function adoptPhase(cwd: string): { goal: string; phase: Phase } | null {
		if (ownedGoal(cwd) && sessionGoal?.adopted !== true) return ownedPhase(cwd);
		const pointed = currentPhase(cwd);
		if (pointed && pointed.goal !== ownedGoal(cwd)) setSessionGoal(cwd, pointed.goal, true);
		return pointed ?? ownedPhase(cwd);
	}

	/** adoptPhase's rule for the four tools that name their goal as a PARAMETER
	 * (plan_save, plan_task_update, plan_verify, plan_complete): taken as given,
	 * the parameter let any session write to, tick or complete another session's
	 * plan just by naming it. An owner-confirmed claim on a live OTHER goal
	 * refuses; anything else adopts the named goal, so a single session (and a
	 * subagent child, which owns nothing and never persists a claim) keeps
	 * working exactly as before.
	 *
	 * Adoption is conditional on the goal actually resolving, so a typo or a
	 * first plan_save on a not-yet-created goal never leaves the session
	 * claiming a goal that does not exist — the tool's own error stands. */
	function notOwnedRefusal(cwd: string, tool: string, goal: string): ReturnType<typeof refuse> | undefined {
		if (isSubagentChild) return undefined;
		const owned = ownedPhase(cwd);
		if (owned?.goal === goal) return undefined;
		if (owned && sessionGoal?.adopted !== true) {
			return refuse(`${tool} blocked — this session owns "${owned.goal}", not "${goal}"; complete or abandon "${owned.goal}" first.`, {
				goal,
				owned: owned.goal,
			});
		}
		if (currentPhase(cwd, goal)) setSessionGoal(cwd, goal, true);
		return undefined;
	}

	function set(ctx: ExtensionContext, next: boolean, note: string, type: "info" | "warning"): void {
		if (!next) {
			// Abandon-on-exit: toggling off mid-planning tombstones the active
			// goal and arms a grace-window purge — re-enabling within the window
			// restores it. Gate 2's release is excluded automatically: it calls
			// transitionPhase(…, "execute") immediately before set(false), so
			// isPlanningPhase is already false by the time this check runs.
			// Tombstone THIS session's goal by name — never whatever active.txt
			// happens to point at, which may belong to another session on the same
			// repo. With nothing claimed there is nothing to abandon.
			const owned = ownedPhase(ctx.cwd);
			if (owned) {
				const machinePhase = readMachinePhase(ctx.cwd, owned.goal) ?? "discovery";
				if (isPlanningPhase(machinePhase)) {
					const goal = tombstoneActiveGoal(ctx.cwd, owned.goal);
					if (goal) {
						sessionGoal = undefined;
						scheduleAbandon(ctx.cwd, () => {
							purgeTombstone(ctx.cwd);
						});
						const graceS = Math.round(getAbandonGraceMs() / 1000);
						ctx.ui.notify(`plan '${goal}' will be discarded in ${graceS}s — re-enable plan mode to keep it`, "warning");
					}
				}
			}
		} else if (cancelAbandon(ctx.cwd)) {
			const goal = restoreTombstonedGoal(ctx.cwd);
			if (goal) {
				// Re-engaging within the grace window hands the goal back to the
				// session that tombstoned it.
				sessionGoal = { cwd: ctx.cwd, goal };
				ctx.ui.notify(`plan '${goal}' kept`, "info");
			}
		} else {
			// No pending grace timer for THIS cwd: purge any leftover tombstone
			// from a killed process, then the H1 sweep for a stale planning goal
			// (see sweepStaleGoal) — a fresh activation always starts clean.
			// cancelAbandon(ctx.cwd) above only reports a timer for this exact
			// cwd, so another repo's still-pending abandon is never touched and
			// never short-circuits this sweep.
			for (const goal of sweepStaleGoal(ctx.cwd)) {
				ctx.ui.notify(`stale plan '${goal}' from a previous session was discarded`, "info");
			}
		}
		enabled = next;
		if (next) {
			restrictTools(ctx);
			// Fresh activation: the owner just engaged plan mode — the working
			// message starts on discovery's mission regardless of what a
			// resumed goal's own phase might be (kept deliberately simple; the
			// next transitionPhase call corrects it the moment the machine
			// actually moves).
			ctx.ui.setWorkingMessage(phaseWorkingMessage("discovery"));
		} else {
			restoreTools();
			// Mandatory reset: pi never clears a custom working message on its
			// own between turns — restore its own default explicitly.
			ctx.ui.setWorkingMessage();
		}
		persistGuardState(toolsBeforePlanMode);
		syncStatus(ctx);
		refreshWidget(ctx);
		ctx.ui.notify(note, type);
	}

	/** THE only implementation of both owner gates (Gate 1 in review_hld, Gate
	 * 2 in review_final): appends the plan panel, opens the harness-composed
	 * form and routes the answer. Called by plan_advance (entering OR
	 * re-opening a review phase) and by ask_smart_plan's phaseGate branch —
	 * there is no other way to open a gate. Readiness is the CALLER's job
	 * (message wording differs slightly per caller, as it always has); this
	 * helper assumes the deliverable is already ready.
	 *
	 * F2: pi runs tools in parallel by default — two gate calls landing in the
	 * same assistant message must never open two independent forms or route
	 * two answers, so a module-level latch (gateFormOpen) refuses reentrant
	 * calls instead of racing them. */
	async function runReviewGate(ctx: ExtensionContext, goal: string, phase: "review_hld" | "review_final", extraDetail?: string) {
		if (gateFormOpen) {
			return refuse("a gate form is already open — wait for the owner's answer");
		}
		gateFormOpen = true;
		try {
			noteCwd(ctx);
			const view = getPlanView(ctx.cwd, goal);
			if (!view) {
				return refuse(`Gate blocked: no plan view for "${goal}" — save one first via plan_save.`);
			}
			// The panel in the transcript — same data shape the renderer expects.
			pi.appendEntry(PRESENT_ENTRY_KEY, { goal });
			// The owner must see the real contract in the form UI itself — never
			// rely on what the model wrote in chat. The model's own detail (if any,
			// from ask_smart_plan's questions[0].detail) is demoted to extra
			// briefing appended after the contract summary, behind a labeled
			// separator (F6) so it can never read as harness contract text.
			const summary = buildContractSummary(view);
			const baseDetail = extraDetail ? `${summary}\n\n— model briefing (unverified) —\n${extraDetail}` : summary;
			// F8: pre-existing staged files make pi-subagents reject every
			// write-worker outright — surface them in Gate 2's own detail (never
			// computed for Gate 1) before the owner decides how to proceed.
			const staged = phase === "review_final" ? gitStagedFiles(ctx.cwd) : [];
			const detail = staged.length > 0 ? `${baseDetail}\n\n${buildStagedPreflight(staged)}` : baseDetail;
			const gateQuestion: AskQuestionInput =
				phase === "review_hld"
					? { question: "Approve this high-level plan?", detail, options: [{ label: "Approve" }, { label: "Reject" }] }
					: {
							question: "Start implementation?",
							detail,
							options:
								staged.length > 0
									? [{ label: "Unstage & start implementation" }, { label: "Start anyway" }, { label: "Stay in planning" }]
									: [{ label: "Start implementation" }, { label: "Stay in planning" }],
						};
			// F3: the gate form is genuinely opening now — clear any earlier
			// postpone so a stale flag never outlives this reopened gate's own
			// outcome (only an actual postpone below re-sets it).
			gatePostponed = false;
			// GATE FORMS ARE FIXED-STRUCTURE and never paged: one binary owner
			// decision from a single un-paged, harness-composed form — routing
			// below is mechanical, never a parse of model-supplied labels. No
			// built-in "None of the above" here (includeNoneOption: false) — the
			// two fixed labels are the only picks; Esc/decline is the sole
			// postpone path below.
			const result = await runAskForm(ctx, [gateQuestion], { includeNoneOption: false });
			if ("declined" in result) {
				// F3: the owner cancelled the form outright (declined) — POSTPONE.
				gatePostponed = true;
				return ok(`The owner postponed the gate — staying in ${phase}. A later plan_advance re-opens it.`, { answers: {}, declined: true, phase });
			}
			const answer = result.answers[gateQuestion.question];
			const label = pickLabel(answer);
			const blocks = [`Q: ${gateQuestion.question}\nA: ${label ?? "(no answer)"}`];

			if (phase === "review_hld") {
				if (label === "Approve") {
					transitionPhase(ctx, goal, "decompose", "Gate 1 APPROVED — HLD locked");
					blocks.push(`(GATE 1 APPROVED — now in decompose. ${phaseMissionLine("decompose")})`);
					return ok(blocks.join("\n"), { answers: result.answers, advanced: true, phase: "decompose" });
				}
				// Only "Reject" remains — the form has no other option (Esc/decline
				// above is the sole postpone path).
				const note = ((await ctx.ui.input("What should change?", "Optional — describe what needs to change")) ?? "").trim();
				transitionPhase(ctx, goal, "discovery", `Gate 1 REJECTED${note ? `: ${note}` : ""}`);
				blocks.push(
					`(GATE 1 REJECTED — back in discovery. ${note ? `Owner's note: ${note}. ` : ""}Re-converge on the HLD with the owner, update it, and journal what changed before the next plan_save.)`,
				);
				return ok(blocks.join("\n"), { answers: result.answers, phase: "discovery" });
			}

			// review_final
			if (label === "Start implementation" || label === "Unstage & start implementation" || label === "Start anyway") {
				if (label === "Unstage & start implementation") {
					// F8: the ONLY git mutation this feature ever performs, scoped to
					// EXACTLY the paths gitStagedFiles just detected — never a bare
					// reset, never other paths.
					try {
						execFileSync("git", ["restore", "--staged", "--", ...staged.map((e) => e.path)], { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
					} catch (err) {
						return refuse(`git restore --staged failed: ${err instanceof Error ? err.message : String(err)} — nothing else changed; staying in review_final.`, { answers: result.answers, phase: "review_final" });
					}
					const remaining = gitStagedFiles(ctx.cwd);
					if (remaining.length > 0) {
						return refuse(
							`${remaining.length} staged entr${remaining.length === 1 ? "y" : "ies"} still remain after unstage (${remaining.map((e) => e.path).join(", ")}) — staying in review_final, guard NOT released.`,
							{ answers: result.answers, phase: "review_final" },
						);
					}
					appendJournal(ctx.cwd, goal, `Gate 2: unstaged ${staged.length} pre-existing staged entries at owner's request: ${staged.map((e) => e.path).join(", ")}`);
				} else if (label === "Start anyway") {
					appendJournal(ctx.cwd, goal, `Gate 2: owner started with ${staged.length} staged entries present (workers will be rejected by pi-subagents)`);
				}
				persistApproved(ctx.cwd, goal);
				transitionPhase(ctx, goal, "execute", "Gate 2 AUTHORIZED — guard released");
				set(ctx, false, "Plan approved — plan mode OFF, full access restored.", "info");
				queueImplementationBriefing(pi, ctx, goal);
				blocks.push("(GATE 2 AUTHORIZED — plan mode released. Wind down this turn; the implementation briefing arrives on the next turn.)");
				return ok(blocks.join("\n"), { answers: result.answers, released: true, phase: "execute" });
			}
			// Only "Stay in planning" remains — the form has no other option
			// (Esc/decline above is the sole postpone path).
			appendJournal(ctx.cwd, goal, "Gate 2: owner stays in planning");
			blocks.push("(Gate 2 not authorized — staying in review_final.)");
			return ok(blocks.join("\n"), { answers: result.answers, phase: "review_final" });
		} finally {
			gateFormOpen = false;
		}
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const details = message.details as { goal?: string } | undefined;
		const goal = details?.goal?.trim();
		const title = theme.fg("customMessageLabel", "◈ PLAN") + theme.fg("customMessageText", goal ? ` — ${goal}` : " — goal not yet set");
		const sub = theme.fg("muted", "read-only ") + buildHeatBar(null);
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(title, 0, 0));
		box.addChild(new Text(sub, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "plan_exit",
		label: "Exit plan mode",
		description: "Ask the user to leave plan mode. Only an affirmative user response deactivates it.",
		promptSnippet: "plan_exit: request to leave plan mode (always asks the user first)",
		promptGuidelines: ["Use plan_exit only when ready to leave plan mode; it always asks the user for confirmation first."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (!enabled) {
				return ok("Plan mode is not active.", { enabled });
			}
			if (!ctx.hasUI) {
				return refuse("Cannot exit plan mode: no interactive UI is available for user confirmation, so plan mode stays active.", { enabled });
			}
			const approved = approvedGoals(ctx.cwd);
			const summaries = goalSummaries(ctx.cwd, displayPhase(ctx.cwd)?.goal);
			const context = summaries.length > 0
				? `\n\nActive plans:\n${summaries.map((line) => `• ${line}`).join("\n")}`
				: "\n\nWARNING: no plan has been saved yet (nothing written via plan_save).";
			const hasApproved = approved.length > 0;
			const question = hasApproved
				? `Exit plan mode and start implementing the approved plan(s) [${approved.join(", ")}]?`
				: "Exit plan mode?";
			const confirmed = await ctx.ui.confirm("Plan mode", `${question}${context}`);
			if (confirmed) {
				set(ctx, false, "◈ Plan mode OFF — full access restored.", "info");
				if (hasApproved) {
					for (const goal of approved) appendJournal(ctx.cwd, goal, "owner confirmed exit — implementation authorized");
					// Same fresh-turn pattern as queueImplementationBriefing (mid-run
					// tool GRANTS never reach the model this same turn): a short result
					// here, the real kickoff queued for the NEXT turn where the
					// restored full tool surface is actually visible.
					const staged = gitStagedFiles(ctx.cwd);
					const briefing =
						`(APPROVED by owner — plan mode released via plan_exit. The owner's confirmation IS the authorization: start implementing the approved plan(s) [${approved.join(", ")}] NOW. Do not ask again.)\n\n` +
						phaseMissionLine("execute") +
						(staged.length > 0 ? `\n\n⚠ ${staged.length} pre-existing staged file(s) present — pi-subagents will reject every worker until they are committed or unstaged.` : "");
					sendPlan(pi, ctx, briefing, approved.join(", "));
					return ok("Plan mode exited — wind down this turn; the implementation briefing for the approved plan(s) arrives next turn.", { enabled, approved });
				}
				return ok("Plan mode exited.", { enabled });
			}
			return ok("The user declined to exit plan mode. Keep planning; file edits stay disabled until plan_exit.", { enabled });
		},

		...toolRenderers.plan_exit,
	});

	pi.registerTool({
		name: "ask_smart_plan",
		label: "Ask (smart-plan)",
		description:
			"Show a custom form: tabs, a human briefing pane, and an inline note when no option fits. Question sets larger than 4 are auto-paged into sequential forms (4 per page, answers aggregated in order); if the owner cancels a later page the remaining questions are reported as unanswered and MUST be re-asked — never assumed.",
		promptSnippet: "ask_smart_plan: ask the user questions before continuing",
		promptGuidelines: [
			"Use ask_smart_plan for structured user decisions. Always fill detail with a plain-language briefing (context, facts, consequences; no jargon, no assumed prior turns). Fill each option preview with what happens if that option is chosen. Write detail and every option description/preview in the language the owner is writing in (infer it from the conversation; default to English when unclear). Never invent an answer. Every form automatically ends with a built-in \"None of the above\" option plus optional note — never add your own equivalent option.",
			"Questions beyond 4 are presented as sequential pages on your side — unanswered questions must be re-asked, never assumed.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String(),
					header: Type.Optional(Type.String()),
					detail: Type.Optional(
						Type.String({
							description:
								"Plain-language briefing for a human: context, facts, consequences. No jargon. No assumed prior context. Write it, and every option description/preview, in the language the owner is writing in (infer it from the conversation; default to English when unclear).",
						}),
					),
					multiSelect: Type.Optional(Type.Boolean()),
					options: Type.Array(
						Type.Union([
							Type.String(),
							Type.Object({
								label: Type.String(),
								description: Type.Optional(Type.String()),
								preview: Type.Optional(Type.String()),
							}),
						]),
						{ minItems: 2, maxItems: 4 }
					),
				}),
				// Generous schema cap for the WHOLE question set: the execution flow
				// auto-pages questions at ASK_FORM_PAGE_MAX (4) per sequential form,
				// so nothing beyond the first page is ever rejected — this cap only
				// bounds what a single tool CALL may carry and removes the old
				// maxItems:4 validation that made the model silently decide the
				// dropped question.
				{ minItems: 1, maxItems: 12 }
			),
			releasePlanGuardOnAnswer: Type.Optional(
				Type.Boolean({
					description:
						"Alias for phaseGate: true, valid ONLY in review_final (the guard-release gate). Invalid everywhere else — use phaseGate: true instead.",
				}),
			),
			phaseGate: Type.Optional(
				Type.Boolean({
					description:
						"Set true ONLY in review_hld or review_final: opens the harness-composed owner gate form (fixed Approve / Reject in review_hld; Start implementation / Stay in planning in review_final). The harness owns the question and options — your questions[0].detail (if set) is folded into extra briefing text after the contract summary; questions[0].options are ignored. Invalid in every other phase — call plan_advance there instead.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// PHASE GATE — the ONLY way the model advances out of review_hld/
			// review_final. The harness composes the question itself (fixed
			// labels, see runReviewGate) so routing is mechanical and never
			// depends on parsing the model's own wording. releasePlanGuardOnAnswer
			// is a plain alias for the review_final gate; invalid everywhere else.
			const gateRequested = params.phaseGate === true || params.releasePlanGuardOnAnswer === true;
			if (!ctx.hasUI) {
				if (gateRequested) {
					return refuse("Gate blocked: no interactive UI is available — the owner gate needs the interactive TUI.", { ui: false });
				}
				return ok("No interactive UI; ask in prose.", { ui: false });
			}

			if (gateRequested && !isSubagentChild) {
				const current = adoptPhase(ctx.cwd);
				if (params.releasePlanGuardOnAnswer === true && params.phaseGate !== true) {
					if (!current || current.phase !== "review_final") {
						return refuse("the guard is released only by the review_final gate (use phaseGate: true).");
					}
				}
				if (!current) {
					return refuse("Gate blocked: no active goal yet — establish the goal before requesting a phase gate.");
				}
				if (current.phase !== "review_hld" && current.phase !== "review_final") {
					return refuse(`Gate blocked: "${current.phase}" has no owner gate — call plan_advance to self-advance instead.`, { phase: current.phase });
				}
				// Deliverable must be complete before the gate form opens; the form
				// must never open unannounced.
				const blocked = deliverableBlocked(ctx, current, `Gate "${current.phase}" blocked — the deliverable is not complete`, { gateBlocked: true, phase: current.phase });
				if (blocked) return blocked;
				// The model's own detail (if any) is demoted to extra briefing
				// appended after the contract summary inside runReviewGate; its
				// options are never consulted — the labels are fixed.
				const modelDetail = params.questions[0]?.detail?.trim();
				return await runReviewGate(ctx, current.goal, current.phase, modelDetail);
			}

			// ORDINARY FORM — auto-paging: question sets larger than one page are
			// split into sequential forms (ASK_FORM_PAGE_MAX per page), aggregated
			// into this single tool result in original order, so an overflow can
			// NEVER be rejected. If a later page is cancelled, the collected
			// answers plus the unanswered questions are reported — nothing is ever
			// invented.
			const collected = await runAskFormPages(ctx, params.questions);
			const blocks = collectedBlocks(collected);
			if (collected.declined) {
				// runAskFormPages guarantees unanswered is nonempty on decline (the
				// question list is never empty, and a decline can only happen mid-
				// paging, before the last page is reached) — no separate emptiness
				// check needed here.
				blocks.push(`UNANSWERED — the owner cancelled before answering these questions (do NOT assume them): ${collected.unanswered.map((q) => q.question).join(" | ")}`);
				blocks.push("ANSWER RULE: unanswered questions must be re-asked, never assumed.");
				return ok(blocks.join("\n"), { answers: collected.answers, declined: true, unanswered: collected.unanswered.map((q) => q.question) });
			}
			return ok(blocks.join("\n"), { answers: collected.answers, declined: false, unanswered: [] });
		},

		...toolRenderers.ask_smart_plan,
	});

	pi.registerTool({
		name: "plan_advance",
		label: "Advance phase",
		description:
			"Formless self-advance: move to the next phase once the CURRENT phase's deliverable is complete. Legal in every planning phase, including review_hld/review_final: called there (or when the target of an advance is a review phase) it opens the owner's gate form itself — panel + form, in the same call — instead of silently advancing.",
		promptSnippet: "plan_advance: self-advance to the next phase once the deliverable is ready; opens the owner's gate form automatically in review_hld/review_final",
		promptGuidelines: [
			"Call plan_advance only once the current phase's LOCAL MISSION deliverable is complete — it refuses (isError, phase untouched) when the deliverable is incomplete. In review_hld/review_final, and when advancing INTO one of them, it opens the owner's gate form itself in the same call — never open it any other way.",
		],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const current = adoptPhase(ctx.cwd);
			if (!current) {
				return refuse("plan_advance blocked — no active goal yet; establish the goal before requesting a phase advance.");
			}
			// Close the shadow-planning gap: advancing a still-planning goal
			// (discovery…review_final) mutates the phase machine and, for review
			// phases, opens an owner gate form — exactly what plan mode's read-only
			// guard exists to protect. Guard-off + execute stays untouched (Gate 2
			// already released it by design).
			if (!enabled && isPlanningPhase(current.phase)) {
				return refuse("plan mode is off — activate it first (shift+tab or /plan)");
			}
			// Already IN a review phase: plan_advance RE-OPENS the owner gate — the
			// harness composes the panel + form itself in this same call; there is
			// no separate presentation step or tool.
			if (current.phase === "review_hld" || current.phase === "review_final") {
				const blocked = deliverableBlocked(ctx, current, `plan_advance blocked — "${current.phase}" deliverable incomplete`, { phase: current.phase });
				if (blocked) return blocked;
				// F4: the owner gate needs the interactive TUI — refuse before opening
				// it rather than letting runReviewGate fabricate an owner "postpone"
				// for a headless caller.
				if (!ctx.hasUI) {
					return refuse(`plan_advance blocked — the owner gate for "${current.phase}" needs the interactive TUI; no interactive UI is available.`, { phase: current.phase });
				}
				return await runReviewGate(ctx, current.goal, current.phase);
			}
			const target = PHASE_NEXT[current.phase];
			if (!target) {
				return refuse(`plan_advance blocked — "${current.phase}" has no further advance.`, { phase: current.phase });
			}
			const blocked = deliverableBlocked(ctx, current, `plan_advance blocked — "${current.phase}" deliverable incomplete`, { phase: current.phase, target });
			if (blocked) return blocked;
			// Target is a review phase: the owner gate needs the interactive TUI —
			// refuse BEFORE transitioning so a goal is never stranded in an
			// ungateable phase.
			if (target === "review_hld" || target === "review_final") {
				if (!ctx.hasUI) {
					return refuse(`plan_advance blocked — the owner gate for "${target}" needs the interactive TUI; no interactive UI is available.`, { phase: current.phase, target });
				}
				transitionPhase(ctx, current.goal, target, `phase advanced: ${current.phase} → ${target}`);
				const gateResult = await runReviewGate(ctx, current.goal, target);
				// Pass-through: forwards runReviewGate's own content/details/isError
				// rather than a fresh literal — doesn't fit the ok()/refuse() shape.
				return {
					content: [{ type: "text", text: `(PHASE ADVANCED — now in ${target}. ${phaseMissionLine(target)})\n\n${gateResult.content[0]?.text ?? ""}` }],
					details: { advanced: true, ...gateResult.details },
					isError: gateResult.isError,
				};
			}
			transitionPhase(ctx, current.goal, target, `phase advanced: ${current.phase} → ${target}`);
			return ok(`(PHASE ADVANCED — now in ${target}. ${phaseMissionLine(target)})`, { advanced: true, phase: target });
		},

		...toolRenderers.plan_advance,
	});

	pi.registerTool({
		name: "plan_save",
		label: "Save plan",
		description: "Write (overwrite) plan.md for a goal in the external plan store.",
		promptSnippet: "plan_save: persist the approved plan for a goal",
		promptGuidelines: ["Use plan_save to write the plan; the store lives outside the repo — never reference its paths."],
		parameters: Type.Object({
			goal: Type.String(),
			content: Type.String(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Close the shadow-planning gap: writing/overwriting plan.md for a
			// still-planning goal (discovery…review_final) with the guard off
			// happens without read-only protection or phase prompts — exactly
			// what plan mode exists to prevent. Execute-phase goals are
			// unaffected (Gate 2 already released them by design).
			if (!enabled && isPlanningPhase(readMachinePhase(ctx.cwd, params.goal) ?? "discovery")) {
				return refuse("plan mode is off — activate it first (shift+tab or /plan)");
			}
			const notOwned = notOwnedRefusal(ctx.cwd, "plan_save", params.goal);
			if (notOwned) return notOwned;
			try {
				savePlan(ctx.cwd, params.goal, params.content);
				refreshWidget(ctx);
				return ok(`Plan saved for ${params.goal}.`, { goal: params.goal });
			} catch (error) {
				return refuse(safeError("plan_save", error));
			}
		},

		...toolRenderers.plan_save,
	});

	pi.registerTool({
		name: "plan_intent",
		label: "Confirm objective",
		description:
			"Owner-backed mechanical gate: reformulate the owner's objective for a goal and open a Confirm/Keep chatting form. Only a Confirm answer creates the confirmed objective (intent.txt) — plan_save refuses any content for the goal until this has run. Re-run in discovery to re-confirm a refined statement (e.g. after a grilling round or a Gate 1 rejection).",
		promptSnippet: "plan_intent: confirm the owner's objective before starting the HLD (owner-backed gate — required once per goal before plan_save)",
		promptGuidelines: [
			"Call plan_intent as soon as you can state the objective, and BEFORE any HLD work — plan_save is rejected until it returns confirmed.",
			"Keep chatting (or Esc) REJECTS the objective — nothing is created; re-elicit with the owner and call plan_intent again with the revised statement. Only Confirm creates it.",
			"Never reference store paths.",
		],
		parameters: Type.Object({
			goal: Type.String(),
			statement: Type.String(),
			openQuestions: Type.Optional(
				Type.Array(OPEN_QUESTION_SCHEMA, {
					minItems: 1,
					maxItems: 12,
					description:
						"Declare any still-open decisions here instead of confirming — the harness forms them (auto-paged) BEFORE any card/confirm form; the store stays untouched. Call plan_intent again with openQuestions empty (or omitted) once resolved.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// F3: plan_intent mutates the plan store — like every other planning
			// flow, it requires plan mode ON. Called with the guard off it would
			// otherwise run unrestricted (the tool_call default-deny hook only
			// enforces while `enabled`), and the resulting goal gets discarded by
			// the next activation's sweepStaleGoal, reading as a fabricated "stale
			// plan discarded" to the owner.
			if (!enabled || isSubagentChild) {
				return refuse("plan mode is off — activate it first (shift+tab or /plan)");
			}
			// F7: a capability refusal must be isError:true, never fall through to
			// runAskForm's own `{ declined: true }` — that path is indistinguishable
			// from a genuine owner cancel and would fabricate "the owner postponed"
			// for a caller that can never actually show the form.
			if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
				return refuse("the objective confirmation form needs the interactive TUI");
			}
			try {
				validateGoalSlug(params.goal);
			} catch (error) {
				return refuse(safeError("plan_intent", error));
			}
			const sanitizedPreview = params.statement.replace(/\s+/g, " ").trim();
			if (!sanitizedPreview) {
				return refuse("plan_intent needs a non-empty objective statement");
			}
			// openQuestions branch: a pre-confirmation safety net, NOT a variant of
			// Confirm — the statement may still be provisional while questions are
			// open, so the length cap below applies ONLY to the confirm branch
			// (hasOpenQuestions === false). Every other guard (slug/statement,
			// lock/goal-switch, intentGuardViolation, gateFormOpen latch below)
			// applies unconditionally to BOTH branches.
			const openQuestions = params.openQuestions ?? [];
			const hasOpenQuestions = openQuestions.length > 0;
			// Cap check moved HERE, pre-form: the owner must never sit through the
			// Confirm/Keep-chatting form only to have confirmIntent reject an
			// over-cap statement afterwards. Refuse before any entry is appended or
			// any form opens — confirmIntent's own check (below, on Confirm) stays as
			// a belt for callers that somehow bypass this one.
			if (!hasOpenQuestions && sanitizedPreview.length > OBJECTIVE_MAX_LEN) {
				return refuse("objective too long — distill it: WHAT the owner wants and the essential constraints, not HOW (implementation choices belong to the HLD)");
			}
			// F2: guard the TARGET goal directly (readMachinePhase/goalIsDone,
			// via intentGuardViolation), not just the session pointer — an
			// unpointed goal past discovery, or one already archived in done/,
			// must refuse just as reliably as a pointed one (previously only
			// `current.phase` was consulted, so Confirm on an unpointed done goal
			// resurrected it via ensureActiveGoalDir with no gate at all).
			const refusal = intentRefusal(ctx.cwd, params.goal);
			if (refusal) return refusal;
			if (gateFormOpen) {
				return refuse("a gate form is already open — wait for the owner's answer");
			}
			gateFormOpen = true;
			try {
				// SAFETY NET: openQuestions lets the model reach plan_intent with open
				// decisions still in hand — declaring them here elicits the SAME paged
				// form ask_smart_plan renders (models fill fields they can see),
				// resolved BEFORE any card/confirm form. The store stays untouched: no
				// OBJECTIVE PROPOSAL entry, no Confirm/Keep-chatting form. The
				// result text tells the model to resolve the answers and re-call
				// plan_intent with openQuestions empty (or omitted) to confirm.
				if (hasOpenQuestions) {
					const collected = await runAskFormPages(ctx, openQuestions);
					const blocks = collectedBlocks(collected);
					if (collected.declined && collected.unanswered.length > 0) {
						blocks.push(`UNANSWERED — the owner cancelled before answering these questions (do NOT assume them): ${collected.unanswered.map((q) => q.question).join(" | ")}`);
						blocks.push("ANSWER RULE: unanswered questions must be re-asked, never assumed.");
					}
					blocks.push("Resolve these answers with the owner, then call plan_intent again with openQuestions empty (or omitted) to confirm.");
					return ok(blocks.join("\n"), {
						goal: params.goal,
						answers: collected.answers,
						declined: collected.declined,
						unanswered: collected.unanswered.map((q) => q.question),
					});
				}
				// The proposal in the transcript — this durable card is the single
				// source for the statement text; the form's side panel does not
				// repeat it (no detail set below).
				pi.appendEntry(INTENT_ENTRY_KEY, { goal: params.goal, statement: sanitizedPreview });
				const question: AskQuestionInput = {
					question: "Is this the objective?",
					options: [{ label: "Confirm" }, { label: "Keep chatting" }],
				};
				// No built-in "None of the above" here (includeNoneOption: false) —
				// Confirm/Keep chatting are the only picks; Esc/decline below is
				// the explicit-rejection path's exact equivalent (same result text).
				const result = await runAskForm(ctx, [question], { includeNoneOption: false });
				if ("declined" in result) {
					return ok(INTENT_KEEP_CHATTING_TEXT, { goal: params.goal, declined: true });
				}
				const answer = result.answers[question.question];
				const label = pickLabel(answer);
				if (label === "Confirm") {
					// F6 (TOCTOU): the guards above ran before the form await — a
					// parallel tool call could have switched/repointed the session
					// goal or advanced/completed THIS goal while the owner was
					// answering. Re-run both checks now, right before the write; any
					// violation refuses with no write, never a stale-checked confirm.
					const refusalNow = intentRefusal(ctx.cwd, params.goal);
					if (refusalNow) return refusalNow;
					try {
						confirmIntent(ctx.cwd, params.goal, params.statement);
					} catch (error) {
						return refuse(safeError("plan_intent", error));
					}
					// Confirming the objective is what binds a goal to THIS session:
					// from here its tool surface, prompt injection and widget cursor
					// follow this goal, not the repo-wide active.txt pointer another
					// session may repoint at any moment.
					setSessionGoal(ctx.cwd, params.goal);
					// Anti-leak: the pre-intent investigation flag must not survive
					// into a later goal confirmed in the same session.
					investigationDone = false;
					refreshWidget(ctx);
					return ok("objective confirmed — proceed: optional grilling round, then HLD co-design and plan_save", { goal: params.goal, confirmed: true });
				}
				// Only "Keep chatting" remains — the form has no other option (Esc/
				// decline above is this same explicit-rejection path's equivalent).
				// Corrections happen in the conversation itself — no note dialog.
				return ok(INTENT_KEEP_CHATTING_TEXT, { goal: params.goal, keepChatting: true });
			} finally {
				gateFormOpen = false;
			}
		},

		...toolRenderers.plan_intent,
	});

	pi.registerTool({
		name: "journal_append",
		label: "Append journal",
		description: "Append timestamped lines to journal.md for a goal in the external plan store.",
		promptSnippet: "journal_append: record decisions/events in the goal journal",
		promptGuidelines: ["Use journal_append to record decisions, deviations, and events; journal is append-only. Never reference store paths."],
		parameters: Type.Object({
			goal: Type.String(),
			lines: Type.String(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// The journal is the plan's append-only logbook — a twin of
			// plan_recall (reading and annotating memory stay available in ANY
			// session, guard on or off, any phase). Unlike plan_save/plan_advance,
			// journaling never advances the phase machine or rewrites plan
			// content, so the shadow-planning guard doesn't apply here. The one
			// guard that DOES apply, unconditionally: the goal must already
			// exist — appendJournal's own ensureActiveGoalDir would otherwise
			// silently CREATE a fresh goal dir from a stray call, resurrecting a
			// phantom goal that was never confirmed via plan_intent.
			if (!goalExists(ctx.cwd, params.goal)) {
				return refuse(`no plan named "${params.goal}" — goals are created by confirming an objective via plan_intent`);
			}
			try {
				appendJournal(ctx.cwd, params.goal, params.lines);
				return ok(`Journal updated for ${params.goal}.`, { goal: params.goal });
			} catch (error) {
				return refuse(safeError("journal_append", error));
			}
		},

		...toolRenderers.journal_append,
	});

	pi.registerTool({
		name: "plan_recall",
		label: "Recall plans",
		description: "Search the external plan store for this repo's goals; returns content (plan + journal tail).",
		promptSnippet: "plan_recall: retrieve prior plan/journal content for this repo",
		promptGuidelines: ["Use plan_recall when the user asks about prior planned work on a topic; return the retrieved content, not a path."],
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const text = recall(ctx.cwd, params.query);
				return ok(text);
			} catch (error) {
				return refuse(safeError("plan_recall", error));
			}
		},

		...toolRenderers.plan_recall,
	});

	pi.registerTool({
		name: "plan_next",
		label: "Ready frontier",
		description: "Mechanically computed ready frontier for a goal: pending tasks whose deps are all done.",
		promptSnippet: "plan_next: get the ready frontier (tasks dispatchable now)",
		promptGuidelines: ["Use plan_next during execution instead of eyeballing deps from memory."],
		parameters: Type.Object({
			goal: Type.String(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const text = nextTasks(ctx.cwd, params.goal);
				return ok(text, { goal: params.goal });
			} catch (error) {
				return refuse(safeError("plan_next", error));
			}
		},

		...toolRenderers.plan_next,
	});

	pi.registerTool({
		name: "plan_task_update",
		label: "Update task status",
		description: "Set a task's status (pending | in_progress | blocked | done) server-side. Claiming (in_progress) snapshots dirty files; closing (done) verifies the delta stayed inside the task's owns and enforces dependency discipline.",
		promptSnippet: "plan_task_update: set task status; done is owns- and dep-checked",
		promptGuidelines: [
			"Claim a task with in_progress before working on it; close it with done only after running its done check yourself. Never rewrite the whole plan via plan_save just to tick a checkbox.",
		],
		parameters: Type.Object({
			goal: Type.String(),
			taskId: Type.String(),
			status: Type.String({ description: "pending | in_progress | blocked | done" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const notOwned = notOwnedRefusal(ctx.cwd, "plan_task_update", params.goal);
			if (notOwned) return notOwned;
			try {
				const text = updateTaskStatus(ctx.cwd, params.goal, params.taskId, params.status);
				noteCwd(ctx);
				refreshWidget(ctx);
				// Live progress on the working message, execute only: the guard is
				// already off by the time real task work happens (Gate 2 released
				// it), so this is the one place execute's own progress can still
				// reach the working line — refreshed on every task-status call.
				if (displayPhase(ctx.cwd)?.phase === "execute") {
					const view = getPlanView(ctx.cwd, params.goal);
					if (view) ctx.ui.setWorkingMessage(`◈ plan · execute — implementing (${view.doneCount}/${view.total} done)`);
				}
				return ok(text, { goal: params.goal, taskId: params.taskId, status: params.status });
			} catch (error) {
				return refuse(safeError("plan_task_update", error));
			}
		},

		...toolRenderers.plan_task_update,
	});

	pi.registerTool({
		name: "plan_verify",
		label: "Verify DoD",
		description: "Run every DoD command of a goal's plan and report pass/fail — the mechanical delivery gate.",
		promptSnippet: "plan_verify: run all DoD commands of a goal and report pass/fail",
		promptGuidelines: ["Run plan_verify before claiming delivery; every command must pass."],
		parameters: Type.Object({
			goal: Type.String(),
			timeoutMs: Type.Optional(Type.Number({ description: "Per-command timeout in ms (default 120000)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const notOwned = notOwnedRefusal(ctx.cwd, "plan_verify", params.goal);
			if (notOwned) return notOwned;
			try {
				const commands = getDoD(ctx.cwd, params.goal);
				if (commands.length === 0) {
					return ok(`No DoD commands in the plan for "${params.goal}".`, { passed: false });
				}
				const timeout = params.timeoutMs ?? 120_000;
				const results = commands.map((command) => {
					const started = Date.now();
					try {
						execFileSync("sh", ["-c", command], { cwd: ctx.cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
						return { command, ok: true, ms: Date.now() - started };
					} catch {
						return { command, ok: false, ms: Date.now() - started };
					}
				});
				const failed = results.filter((r) => !r.ok).length;
				const body = results.map((r) => `${r.ok ? "PASS" : "FAIL"} (${r.ms}ms) ${r.command}`).join("\n");
				const headline = failed === 0 ? `DoD: ${results.length}/${results.length} PASS.` : `DoD FAILED: ${failed}/${results.length} failed.`;
				if (failed === 0) sessionState.dodPassed = true;
				const report = `${headline}\n${body}`;
				return failed === 0 ? ok(report, { passed: true }) : refuse(report, { passed: false });
			} catch (error) {
				return refuse(safeError("plan_verify", error));
			}
		},

		...toolRenderers.plan_verify,
	});

	// plan_present (tool) is gone: the two review gates are harness-driven —
	// runReviewGate appends PRESENT_ENTRY_KEY itself inside plan_advance /
	// ask_smart_plan's phaseGate branch. PRESENT_ENTRY_KEY and its renderer
	// survive so old transcripts (pre-0.10.0) keep rendering their panel.
	pi.registerEntryRenderer(PRESENT_ENTRY_KEY, (entry, _opts, theme) => {
		const goal = (entry.data as { goal?: string } | undefined)?.goal ?? "";
		const view = lastCwd ? getPlanView(lastCwd, goal) : null;
		return {
			render(width = 80): string[] {
				return view ? renderPlanPanel(view, theme, width) : [theme.fg("dim", "(plan not available)")];
			},
			invalidate() {},
		};
	});

	// INTENT_ENTRY_KEY: the "OBJECTIVE PROPOSAL" card plan_intent appends to
	// the main transcript right before opening its Confirm/Keep chatting form
	// (see the plan_intent tool below) — same pattern as
	// PRESENT_ENTRY_KEY above, data-driven from the appended entry itself
	// rather than a store re-read (the statement isn't persisted until Confirm).
	pi.registerEntryRenderer(INTENT_ENTRY_KEY, (entry, _opts, theme) => {
		const data = entry.data as { goal?: string; statement?: string } | undefined;
		const goal = data?.goal ?? "";
		const statement = data?.statement ?? "";
		return {
			render(width = 80): string[] {
				return renderIntentPanel(goal, statement, theme, width);
			},
			invalidate() {},
		};
	});

	pi.registerTool({
		name: "plan_complete",
		label: "Complete goal",
		description: "Move a goal to the completed section of the external plan store.",
		promptSnippet: "plan_complete: mark a goal done (moves it to done/)",
		promptGuidelines: ["Use plan_complete only after all DoD checks pass; re-opening a goal happens automatically on the next plan_save."],
		parameters: Type.Object({
			goal: Type.String(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const notOwned = notOwnedRefusal(ctx.cwd, "plan_complete", params.goal);
			if (notOwned) return notOwned;
			try {
				const completed = completeGoal(ctx.cwd, params.goal);
				if (completed) {
					sessionState.completed = true;
					if (ownedGoal(ctx.cwd) === params.goal) setSessionGoal(ctx.cwd, undefined);
				}
				refreshWidget(ctx);
				// Mandatory reset: plan_complete always restores pi's default
				// working message — pi never clears a custom one on its own.
				ctx.ui.setWorkingMessage();
				return ok(completed ? `Goal ${params.goal} completed.` : `No active goal ${params.goal}.`, { goal: params.goal, completed });
			} catch (error) {
				return refuse(safeError("plan_complete", error));
			}
		},

		...toolRenderers.plan_complete,
	});

	pi.registerCommand("plan", {
		description: "Goal-scoped planning: /plan <goal>",
		handler: async (args, ctx) => {
			// First-class entry point: the user typed the command, so activating the
			// guard needs no further confirmation.
			if (!enabled) {
				set(ctx, true, "Plan mode ON — file edits disabled; write the plan via plan_save.", "warning");
			}
			sendPlan(pi, ctx, planBootstrapMessage(args), args.trim());
		},
	});

	pi.registerCommand("plan-guard", {
		description: "Plan mode control: /plan-guard status|on|off (user-only override)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(enabled ? "Plan mode: ON" : "Plan mode: OFF", "info");
				return;
			}
			if (action === "on") {
				if (enabled) {
					ctx.ui.notify("Plan mode is already ON.", "info");
					return;
				}
				set(ctx, true, "Plan mode ON — file edits disabled; write the plan via plan_save.", "warning");
				return;
			}
			if (action === "off") {
				if (!enabled) {
					ctx.ui.notify("Plan mode is already OFF.", "info");
					return;
				}
				set(ctx, false, "◈ Plan mode OFF — full access restored.", "info");
				return;
			}
			ctx.ui.notify("Usage: /plan-guard status|on|off", "warning");
		},
	});

	pi.registerCommand("plan-status", {
		description: "Dump plan-mode state (goals, phases, frontier) — no LLM turn",
		handler: async (_args, ctx) => {
			const lines = goalSummaries(ctx.cwd, displayPhase(ctx.cwd)?.goal);
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No active goals.", enabled ? "warning" : "info");
		},
	});

	// Owner-only toggle on shift+tab (Claude Code motor memory). Requires the
	// built-in app.thinking.cycle to be remapped away from shift+tab in
	// keybindings.json (see README). ON: engage the read-only guard and notify
	// the owner — NO LLM turn fires. The planning conversation starts when the
	// owner states what to design together; per-phase instructions reach the
	// model via before_agent_start injection.
	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode (read-only)",
		handler: async (ctx) => {
			if (enabled) {
				set(ctx, false, "◈ Plan mode OFF — full access restored.", "info");
				return;
			}
			set(ctx, true, "◈ Plan mode ON — read-only. Tell the model what you want to design together.", "warning");
		},
	});

	// Read-only enforcement while plan mode is active.
	// 1) bash: allowlist of read-only commands (src/bash-guard.ts).
	// 2) DEFAULT-DENY for everything else: only reading, planning-store tools
	//    and web research run — unknown or third-party tools are blocked too.
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (isToolCallEventType("bash", event)) {
			if (!isReadOnlyCommand(event.input.command)) {
				return { block: true, reason: BASH_BLOCK_REASON };
			}
			// Latch: a permitted (read-only) bash call is investigation, not chat.
			if (!isSubagentChild) investigationDone = true;
			return undefined;
		}
		const allowed = phaseAllowedTools(ctx);
		if (!allowed.has(event.toolName)) {
			return {
				block: true,
				reason: isSubagentChild
					? `Your parent session is in plan mode — "${event.toolName}" is not available to read-only subagents (exploration only: read, read-only bash, web research, nested subagent spawn). Report findings to the parent; never touch the plan store or planning tools.`
					: `Plan mode is active — "${event.toolName}" is not available in the current phase (${displayPhase(ctx.cwd)?.phase ?? "discovery"}). Repo changes wait until the user exits plan mode.`,
			};
		}
		// Latch: any other allowed (permitted) tool call is investigation too.
		if (!isSubagentChild) investigationDone = true;
		return undefined;
	});

	// FIX 3 (T5): while the guard is active, remind the model it is read-only
	// on every bash result — it keeps designing instead of trying to write.
	// Plan-store / form tools additionally receive the phase's next-action hint.
	// E2: the hint is scoped to planning tools (`plan_*` + ask_smart_plan) — it
	// is useless (and costs a store read) on every read/bash/web result. Only
	// active while the guard is on.
	pi.on("tool_result", (event, ctx) => {
		if (!enabled) return undefined;
		const toolName = event.toolName;
		const aside: string[] = [];
		if (toolName === "bash") {
			aside.push("[plan mode: read-only guard active — do NOT write/edit; design only]");
		}
		if (!isSubagentChild && (toolName === "ask_smart_plan" || toolName.startsWith("plan_"))) {
			const current = displayPhase(ctx.cwd);
			if (current) {
				const snapshot = buildPhaseSnapshot(ctx, current);
				aside.push(nextActionHint(current.phase, snapshot));
			}
		}
		if (aside.length === 0) return undefined;
		return { content: [...event.content, ...aside.map((text) => ({ type: "text" as const, text }))] };
	});

	// Finalize-retry at agent_settled (parent only): if a planning-phase turn
	// closed in prose instead of the phase's structured tool, the harness
	// regenerates that turn with a steer (max 2 retries per phase), then stops
	// and notifies the owner. turn_end hands us the closing assistant message
	// of each turn directly (typed) — we keep only the latest one, since
	// agent_settled fires once the run is fully settled (no pending retry/
	// continuation) and only that final turn matters for the verdict.
	let lastTurn: { message: TurnEndEvent["message"] } | null = null;
	pi.on("turn_end", (event) => {
		if (isSubagentChild) return;
		lastTurn = { message: event.message };
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled || isSubagentChild) return;
		if (!lastTurn) return;
		// Only regenerate when the session is genuinely idle and nothing is
		// queued (no pending user/steer messages, no open form). B3: a blocking
		// ask_smart_plan form being open means the model is legitimately waiting
		// on the owner's answer — never steer mid-form.
		if (!ctx.isIdle() || ctx.hasPendingMessages() || uiPromptOpen) return;
		// A run triggered by our own steer never re-steers itself.
		if (regenInFlight) {
			regenInFlight = false;
			return;
		}

		// GAP FIX: an empty store (no goal ever named) must NOT bail here — that
		// is exactly the field-failure scenario (a model that never enters the
		// machine at all). Null resolves to phase "discovery", same as every
		// other null-current call site.
		const current = displayPhase(ctx.cwd);
		const phase = current?.phase ?? "discovery";
		const assistant = lastTurn.message;
		if (assistant.role !== "assistant") return;
		const toolNames = assistant.content.filter((c) => c.type === "toolCall").map((c) => c.name);
		const last = assistant.content.at(-1);
		const endedWithText = last?.type === "text";

		const snapshot = buildPhaseSnapshot(ctx, current);
		const verdict = finalizeVerdict(phase, toolNames, endedWithText, snapshot);
		if (verdict.ok) {
			retryCount = 0;
			return;
		}
		if (retryCount >= 2) {
			// Give up: surface to the owner instead of nudging forever.
			ctx.ui.notify(`Plan phase "${phase}": repeated prose closes after ${retryCount + 1} attempts — check the last exchange.`, "warning");
			retryCount = 0;
			return;
		}
		retryCount += 1;
		regenInFlight = true;
		// E1: the verdict carries the phase+key; the RETRY ATTEMPT lives in the
		// caller's counter. Re-cable the escalation through FINALIZE_RULES so the
		// steer text matches the real attempt (finalizeVerdict only knows a
		// generic attempt-1 template by design). The pre-intent and post-intent
		// discovery branches each carry their OWN key: FINALIZE_RULES.discovery.
		// steer is the wrong text for both (it names plan_advance as if the HLD
		// were already complete) — route by verdict.key instead of blindly
		// re-deriving from the phase.
		const rule = FINALIZE_RULES[phase];
		const steer =
			verdict.key === DISCOVERY_PRE_INTENT_KEY
				? discoveryPreIntentSteer(retryCount)
				: verdict.key === DISCOVERY_POST_INTENT_KEY
					? discoveryPostIntentSteer(retryCount)
					: rule!.steer(retryCount, verdict.missing);
		if (ctx.isIdle()) {
			pi.sendUserMessage(steer, {});
		} else {
			pi.sendUserMessage(steer, { deliverAs: "followUp" });
		}
	});

	// B3: track blocking extension UI forms so the settle-retry never steers
	// while the owner is actively answering one.
	pi.on("ui_prompt_start", () => {
		uiPromptOpen = true;
	});
	pi.on("ui_prompt_end", () => {
		uiPromptOpen = false;
	});

	// After context compaction wipes the transcript's texture, the model can
	// lose track of goal/phase/next-action. One-shot recap delivered on the
	// NEXT turn (never mid-compaction) re-orients it without re-injecting the
	// full phase prompt out of band.
	pi.on("session_compact", (_event, ctx) => {
		if (!enabled || isSubagentChild) return;
		const current = displayPhase(ctx.cwd);
		if (!current) return;
		const snapshot = buildPhaseSnapshot(ctx, current);
		const hint = nextActionHint(current.phase, snapshot);
		const recap = `◈ Plan mode recap (post-compaction). Goal: ${current.goal}. Phase: ${current.phase}. ${hint}`;
		pi.sendMessage({ customType: MESSAGE_TYPE, content: recap, display: true, details: { goal: current.goal } }, { deliverAs: "nextTurn" });
	});

	// Per-turn phase injection: only the current state-machine phase (+ global
	// constraints) reaches the model. Appended to the system prompt, not stored.
	pi.on("before_agent_start", async (event, ctx) => {
		// B2: a real owner turn (any new user prompt) resets the prose-close
		// retry budget for the phase. Our own regenerate steers also pass through
		// this hook — regenInFlight is still set for them, so they are skipped and
		// keep their escalating attempt number.
		if (!isSubagentChild && !regenInFlight) retryCount = 0;
		noteCwd(ctx);
		const injection = planInjection(ctx.cwd);
		if (!injection) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
	});

	// Restore guard state on startup/reload/new/resume/fork, re-applying the
	// restricted tool set when the guard was active.
	pi.on("session_start", async (_event, ctx) => {
		// Subagent child that inherited the parent's plan mode: self-activate the
		// read-only guard, keeping the state ephemeral (no store entry, no UI).
		const childDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
		isSubagentChild = Number.isFinite(childDepth) && childDepth > 0;
		if (isSubagentChild && process.env.PI_SMART_PLAN === "1") {
			enabled = true;
			restrictTools(ctx);
			noteCwd(ctx);
			// Observability: record the self-activation in the child's session log so
			// a maintainer can verify the guard engaged on inherited plan mode and at
			// which subagent depth. Separate key on purpose — must NOT collide with
			// STORE_KEY, which the parent reads back to restore its own state.
			pi.appendEntry("plan-guard-child", { inherited: true, depth: childDepth });
			return;
		}
		let restored: { enabled: boolean; tools?: string[]; goal?: string } | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STORE_KEY) {
				const data = entry.data as { enabled?: boolean; tools?: string[]; goal?: string } | undefined;
				restored = { enabled: data?.enabled ?? false, tools: data?.tools, goal: data?.goal };
			}
		}
		enabled = restored?.enabled ?? false;
		// The goal binding rides the SAME transcript entry as the guard flag, so
		// a reload/resume/fork resumes acting on the goal this session owned. A
		// pre-upgrade transcript carries none, leaving sessionGoal undefined and
		// the resolution on its historical active.txt fallback.
		sessionGoal = restored?.goal ? { cwd: ctx.cwd, goal: restored.goal } : undefined;
		// A restored session may have persisted a tool name that no longer exists
		// (e.g. plan_approve, removed in 0.10.0) — intersect against the
		// currently-registered catalogue before it ever reaches setActiveTools.
		if (restored?.tools) {
			const registeredNames = new Set(pi.getAllTools().map((tool) => tool.name));
			toolsBeforePlanMode = restored.tools.filter((name) => registeredNames.has(name));
		} else {
			toolsBeforePlanMode = undefined;
		}
		if (!enabled && pi.getFlag("plan") === true) {
			enabled = true;
			// Fresh activation via the --plan flag (never a plain resume): same
			// tombstone purge + H1 sweep as set()'s ON branch, so a new session
			// with --plan always starts clean.
			const purged = sweepStaleGoal(ctx.cwd);
			// session_start has no confirmed interactive turn underway yet —
			// only notify when there's a UI to receive it, and never block on it.
			if (ctx.hasUI) {
				for (const goal of purged) {
					ctx.ui.notify(`stale plan '${goal}' from a previous session was discarded`, "info");
				}
			}
			persistGuardState(undefined);
		}
		if (enabled) restrictTools(ctx);
		else restoreTools();
		noteCwd(ctx);
		syncStatus(ctx);
		refreshWidget(ctx);
		// The widget must also reflect what OTHER sessions on this repo do (a
		// goal completed elsewhere, a plan started elsewhere). No host event can
		// observe that — every on(...) event fires on this session's own
		// activity — so poll the store instead. Stopping first makes a second
		// session_start (resume/fork replaces the session in-process) replace the
		// watcher rather than stack a second one.
		stopLiveWatch?.();
		stopLiveWatch = startLiveWatch(storeRoot(ctx.cwd), () => refreshWidget(ctx));
	});

	pi.on("session_shutdown", () => {
		stopLiveWatch?.();
		stopLiveWatch = undefined;
	});
}
