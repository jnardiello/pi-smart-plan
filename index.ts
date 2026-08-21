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
 * - state-mutating tools from other extensions (subagent spawn, chrome
 *   interaction) are removed and additionally blocked as a backstop;
 * - the only write path is the extension-owned external store via
 *   plan_save / journal_append / plan_complete — the model never handles
 *   store paths.
 *
 * The plan is written into the external store via plan_save / journal_append.
 * ctrl+p sends a short goal-elicitation prompt; the full goal workflow is
 * injected only by /plan.
 */
import { execFileSync } from "node:child_process";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runAskForm } from "./src/ask-form.ts";
import { GLOBAL_CONSTRAINTS, PHASE_PROMPTS, planBootstrapMessage } from "./src/prompts.ts";
import { PHASES, type Phase } from "./src/plan-validate.ts";
import { isReadOnlyCommand } from "./src/bash-guard.ts";
import { savePlan, appendJournal, recall, completeGoal, currentPhase, getDoD, goalSummaries, nextTasks, updateTaskStatus, PlanStoreValidationError } from "./src/plan-store.ts";

const STORE_KEY = "plan-guard";
const STATUS_KEY = "plan-guard";
const MESSAGE_TYPE = "smart-plan";
const BASH_BLOCK_REASON =
	"Plan mode is active — bash is limited to read-only commands (ls, rg, cat, git status/diff/log, …). " +
	"Persist plans via plan_save / journal_append; repo changes wait until the user exits plan mode (plan_exit).";

/** While plan mode is on the session is DEFAULT-DENY: only these tools run —
 * read-only built-ins for codebase investigation, the planning store tools
 * (the only writes allowed, into the external plans folder), and web research
 * for understanding the problem. Everything else — write built-ins,
 * subagents, chrome, unknown or future third-party tools — is blocked.
 * Extend this set deliberately if a specific tool is ever needed. */
const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"ask_smart_plan",
	"plan_exit",
	"plan_save",
	"journal_append",
	"plan_recall",
	"plan_complete",
	"plan_next",
	"plan_task_update",
	"web_search",
	"source_check",
	"fetch_content",
	"get_search_content",
]);

/** Error text for a failed store tool. Validation errors (safe, no paths) are
 * forwarded verbatim; anything else (fs errors with absolute store paths embedded)
 * maps to a generic message so store locations never leak to the model. */
function safeError(operation: string, error: unknown): string {
	const message = error instanceof PlanStoreValidationError ? error.message : "plan store I/O error";
	return `${operation} failed: ${message}`;
}

let enabled = false;

/** Deliver a plan request as a custom message: content goes to the LLM, the
 * TUI shows only the single-line renderer. Idle → trigger a turn immediately;
 * busy → queue as a non-interrupting followUp. */
function sendPlan(pi: ExtensionAPI, ctx: ExtensionContext, content: string, goal: string, source: "command" | "shortcut"): void {
	const payload = { customType: MESSAGE_TYPE, content, display: true, details: { goal, source } };
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

/** Heat ramp for the phase bar: starts neutral gray, warms up to vivid
 * orange as the plan approaches completion (fixed xterm-256 hues, deliberately
 * theme-independent). Transparency effect: upcoming cells show their future
 * hue at low density (░░), reached ones burn at full density (██). */
const PHASE_HEAT: Record<Phase, number> = {
	discovery: 243, // neutral gray
	hld: 137, // muted brown-orange
	decompose: 179, // tan-orange
	ablate: 172, // dark orange
	present: 208, // orange
	execute: 214, // bright orange
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

/** Live task tracking (Codex update_plan parity): goals, phase, progress and
 * ready frontier rendered as a TUI widget while plan mode is active. */
/** Live state-machine view (Codex update_plan parity): themed phase pipeline
 * plus per-goal progress and ready frontier, rendered above the editor. */
function refreshWidget(ctx: ExtensionContext): void {
	if (!enabled) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
		const lines: string[] = [];
		const current = currentPhase(ctx.cwd, true)?.phase ?? "discovery";
		lines.push(theme.fg("accent", theme.bold("◈ PLAN MODE")) + theme.fg("muted", " · read-only"));
		lines.push(`${buildHeatBar(current)}  ${theme.fg("accent", theme.bold(current))}`);
		const goals = goalSummaries(ctx.cwd, enabled);
		for (const goal of goals) lines.push(theme.fg("muted", `  ${goal}`));
		if (current === "discovery" && goals.length === 0) {
			lines.push(theme.fg("muted", "  → tell me what you want to design together"));
		}
		return { render: () => lines, invalidate: () => {} };
	});
}

/** Progressive disclosure: inject ONLY the current phase's instructions (+
 * global constraints). While the guard is off, keep the execute block alive
 * while an approved goal is still in flight (execution/delivery). */
function planInjection(cwd: string): string | undefined {
	if (enabled) {
		const current = currentPhase(cwd, true);
		const phase = current?.phase ?? "discovery";
		return `${GLOBAL_CONSTRAINTS}\n\n${PHASE_PROMPTS[phase]}`;
	}
	const current = currentPhase(cwd, false);
	if (current?.phase === "execute") return `${GLOBAL_CONSTRAINTS}\n\n${PHASE_PROMPTS.execute}`;
	return undefined;
}

export default function planGuard(pi: ExtensionAPI): void {
	/** Active-tool snapshot taken on first engagement, restored on exit. */
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start with the read-only plan guard engaged",
		type: "boolean",
		default: false,
	});

	function restrictTools(): void {
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		pi.setActiveTools(toolsBeforePlanMode.filter((name) => PLAN_MODE_ALLOWED_TOOLS.has(name)));
	}

	function restoreTools(): void {
		if (toolsBeforePlanMode !== undefined) pi.setActiveTools(toolsBeforePlanMode);
		toolsBeforePlanMode = undefined;
	}

	function set(ctx: ExtensionContext, next: boolean, note: string, type: "info" | "warning"): void {
		enabled = next;
		if (next) restrictTools();
		else restoreTools();
		pi.appendEntry(STORE_KEY, { enabled, tools: toolsBeforePlanMode }); // persist for reload/resume
		syncStatus(ctx);
		refreshWidget(ctx);
		ctx.ui.notify(note, type);
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const details = message.details as { goal?: string; source?: string } | undefined;
		const goal = details?.goal?.trim();
		const title = theme.fg("customMessageLabel", "◈ PLAN") + theme.fg("customMessageText", goal ? ` — ${goal}` : " — goal da definire");
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
				return { content: [{ type: "text", text: "Plan mode is not active." }], details: { enabled } };
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Cannot exit plan mode: no interactive UI is available for user confirmation, so plan mode stays active." }],
					details: { enabled },
				};
			}
			const summaries = goalSummaries(ctx.cwd, enabled);
			const context = summaries.length > 0
				? `\n\nActive plans:\n${summaries.map((line) => `• ${line}`).join("\n")}`
				: "\n\nWARNING: no plan has been saved yet (nothing written via plan_save).";
			const confirmed = await ctx.ui.confirm("Plan mode", `Exit plan mode?${context}`);
			if (confirmed) {
				set(ctx, false, "◈ Plan mode OFF — full access restored.", "info");
				return { content: [{ type: "text", text: "Plan mode exited." }], details: { enabled } };
			}
			return {
				content: [{ type: "text", text: "The user declined to exit plan mode. Keep planning; file edits stay disabled until plan_exit." }],
				details: { enabled },
			};
		},
	});

	pi.registerTool({
		name: "ask_smart_plan",
		label: "Ask (smart-plan)",
		description: "Show a custom form: tabs, a human briefing pane, and an inline note when no option fits.",
		promptSnippet: "ask_smart_plan: ask the user questions before continuing",
		promptGuidelines: [
			"Use ask_smart_plan for structured user decisions. Always fill detail with a plain-language briefing (context, facts, consequences; no jargon, no assumed prior turns). Fill each option preview with what happens if that option is chosen. Offer a custom note path; never invent an answer.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String(),
					header: Type.Optional(Type.String()),
					detail: Type.Optional(
						Type.String({
							description:
								"Plain-language briefing for a human: context, facts, consequences. No jargon. No assumed prior context.",
						}),
					),
					multiSelect: Type.Optional(Type.Boolean()),
					options: Type.Array(
						Type.Object({
							label: Type.String(),
							description: Type.Optional(Type.String()),
							preview: Type.Optional(Type.String()),
						}),
						{ minItems: 2, maxItems: 4 }
					),
				}),
				{ minItems: 1, maxItems: 4 }
			),
			releasePlanGuardOnAnswer: Type.Optional(
				Type.Boolean({
					description:
						"Set true ONLY on the final plan-approval form: when the user answers without declining, the read-only plan guard is released in the same interaction (single approval gate).",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "No interactive UI; ask in prose." }], details: { ui: false } };
			}
			const result = await runAskForm(ctx, params.questions);
			if ("declined" in result) {
				return { content: [{ type: "text", text: "The user declined." }], details: { answers: {}, declined: true } };
			}
			const blocks = Object.entries(result.answers).map(([q, a]) => `Q: ${q}\nA: ${Array.isArray(a) ? a.join(", ") : a}`);
			if (params.releasePlanGuardOnAnswer === true && enabled) {
				set(ctx, false, "Plan approved — plan mode OFF, full access restored.", "info");
				blocks.push("(Approved: plan mode released — proceed with execution.)");
				return { content: [{ type: "text", text: blocks.join("\n") }], details: { answers: result.answers, released: true } };
			}
			return { content: [{ type: "text", text: blocks.join("\n") }], details: { answers: result.answers } };
		},
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
			try {
				savePlan(ctx.cwd, params.goal, params.content);
				refreshWidget(ctx);
				return { content: [{ type: "text", text: `Plan saved for ${params.goal}.` }], details: { goal: params.goal } };
			} catch (error) {
				return { content: [{ type: "text", text: safeError("plan_save", error) }], details: {}, isError: true };
			}
		},
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
			try {
				appendJournal(ctx.cwd, params.goal, params.lines);
				return { content: [{ type: "text", text: `Journal updated for ${params.goal}.` }], details: { goal: params.goal } };
			} catch (error) {
				return { content: [{ type: "text", text: safeError("journal_append", error) }], details: {}, isError: true };
			}
		},
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
				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: safeError("plan_recall", error) }], details: {}, isError: true };
			}
		},
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
				return { content: [{ type: "text", text }], details: { goal: params.goal } };
			} catch (error) {
				return { content: [{ type: "text", text: safeError("plan_next", error) }], details: {}, isError: true };
			}
		},
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
			try {
				const text = updateTaskStatus(ctx.cwd, params.goal, params.taskId, params.status);
				refreshWidget(ctx);
				return { content: [{ type: "text", text }], details: { goal: params.goal, taskId: params.taskId, status: params.status } };
			} catch (error) {
				return { content: [{ type: "text", text: safeError("plan_task_update", error) }], details: {}, isError: true };
			}
		},
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
			try {
				const commands = getDoD(ctx.cwd, params.goal);
				if (commands.length === 0) {
					return { content: [{ type: "text", text: `No DoD commands in the plan for "${params.goal}".` }], details: { passed: false } };
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
				return { content: [{ type: "text", text: `${headline}\n${body}` }], details: { passed: failed === 0 }, isError: failed > 0 };
			} catch (error) {
				return { content: [{ type: "text", text: safeError("plan_verify", error) }], details: {}, isError: true };
			}
		},
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
			try {
				const completed = completeGoal(ctx.cwd, params.goal);
				refreshWidget(ctx);
				return {
					content: [{ type: "text", text: completed ? `Goal ${params.goal} completed.` : `No active goal ${params.goal}.` }],
					details: { goal: params.goal, completed },
				};
			} catch (error) {
				return { content: [{ type: "text", text: safeError("plan_complete", error) }], details: {}, isError: true };
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Goal-scoped planning: /plan <goal>",
		handler: async (args, ctx) => {
			// First-class entry point: the user typed the command, so activating the
			// guard needs no further confirmation.
			if (!enabled) {
				set(ctx, true, "Plan mode ON — file edits disabled; write the plan via plan_save.", "warning");
			}
			sendPlan(pi, ctx, planBootstrapMessage(args), args.trim(), "command");
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
			const lines = goalSummaries(ctx.cwd, enabled);
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
	pi.on("tool_call", async (event, _ctx) => {
		if (!enabled) return undefined;
		if (isToolCallEventType("bash", event)) {
			if (!isReadOnlyCommand(event.input.command)) {
				return { block: true, reason: BASH_BLOCK_REASON };
			}
			return undefined;
		}
		if (!PLAN_MODE_ALLOWED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode is active — "${event.toolName}" is not available while planning (only reading, planning-store tools and web research are allowed). Repo changes wait until the user exits plan mode.`,
			};
		}
		return undefined;
	});

	// Per-turn phase injection: only the current state-machine phase (+ global
	// constraints) reaches the model. Appended to the system prompt, not stored.
	pi.on("before_agent_start", async (event, ctx) => {
		const injection = planInjection(ctx.cwd);
		if (!injection) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
	});

	// Restore guard state on startup/reload/new/resume/fork, re-applying the
	// restricted tool set when the guard was active.
	pi.on("session_start", async (_event, ctx) => {
		let restored: { enabled: boolean; tools?: string[] } | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STORE_KEY) {
				const data = entry.data as { enabled?: boolean; tools?: string[] } | undefined;
				restored = { enabled: data?.enabled ?? false, tools: data?.tools };
			}
		}
		enabled = restored?.enabled ?? false;
		toolsBeforePlanMode = restored?.tools;
		if (!enabled && pi.getFlag("plan") === true) {
			enabled = true;
			pi.appendEntry(STORE_KEY, { enabled, tools: undefined });
		}
		if (enabled) restrictTools();
		else restoreTools();
		syncStatus(ctx);
		refreshWidget(ctx);
	});
}
