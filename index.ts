/**
 * pi-smart-plan — read-only plan mode for pi.
 * While active, file edits/writes are blocked unconditionally (no path exceptions).
 * The plan is written into the extension-owned external store via plan_save /
 * journal_append — the model never handles store paths. Only the user (native
 * confirm, ctrl+p toggle) or the /plan-guard command can exit; the model has no
 * unilateral way out.
 */
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runAskForm } from "./src/ask-form.ts";
import { planUserMessage } from "./src/prompts.ts";
import { savePlan, appendJournal, recall, completeGoal, PlanStoreValidationError } from "./src/plan-store.ts";

const STORE_KEY = "plan-guard";
const STATUS_KEY = "plan-guard";
const MESSAGE_TYPE = "smart-plan";
const FALLBACK_GOAL = "goal da definire";
const BLOCK_REASON =
	"Plan mode is active — file edits are disabled. Write the plan via plan_save and " +
	"journal_append; repo changes wait until you exit plan mode (plan_exit, user confirmation required).";

/** Error text for a failed store tool. Validation errors (safe, no paths) are
 * forwarded verbatim; anything else (fs errors with absolute store paths embedded)
 * maps to a generic message so store locations never leak to the model. */
function safeError(operation: string, error: unknown): string {
	const message = error instanceof PlanStoreValidationError ? error.message : "plan store I/O error";
	return `${operation} failed: ${message}`;
}

let enabled = false;

/** Deliver a plan request as a custom message: full workflow content goes to the LLM,
 * the TUI shows only the single-line renderer. Idle → trigger a turn immediately;
 * busy → queue as a non-interrupting followUp. */
function sendPlan(pi: ExtensionAPI, ctx: ExtensionContext, args: string): void {
	const message = planUserMessage(args);
	const goal = args.trim();
	if (ctx.isIdle()) {
		pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true, details: { goal } }, { triggerTurn: true });
	} else {
		pi.sendMessage({ customType: MESSAGE_TYPE, content: message, display: true, details: { goal } }, { deliverAs: "followUp" });
	}
}

function syncStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, enabled ? "PLAN" : undefined);
}

export default function planGuard(pi: ExtensionAPI): void {
	function set(ctx: ExtensionContext, next: boolean, note: string, type: "info" | "warning"): void {
		enabled = next;
		pi.appendEntry(STORE_KEY, { enabled }); // persist for reload/resume
		syncStatus(ctx);
		ctx.ui.notify(note, type);
	}

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const goal = (message.details as { goal?: string } | undefined)?.goal?.trim();
		const label = `/plan — ${goal ? goal : FALLBACK_GOAL}`;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("customMessageText", label), 0, 0));
		return box;
	});

	pi.registerTool({
		name: "plan_enter",
		label: "Enter plan mode",
		description: "Activate plan mode: file edits/writes are blocked until the user confirms exit.",
		promptSnippet: "plan_enter: enter read-only plan mode (write only via plan_save/journal_append)",
		promptGuidelines: ["Use plan_enter to start planning; during plan mode write only via plan_save / journal_append into the external plan store."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (enabled) {
				return { content: [{ type: "text", text: "Plan mode is already active." }], details: { enabled } };
			}
			set(ctx, true, "Plan mode ON — file edits disabled; write the plan via plan_save.", "warning");
			return {
				content: [{ type: "text", text: "Plan mode active. File edits are disabled; write the plan via plan_save and journal_append." }],
				details: { enabled },
			};
		},
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
			const confirmed = await ctx.ui.confirm("Plan mode", "Exit plan mode?");
			if (confirmed) {
				set(ctx, false, "Plan mode OFF — edits/writes re-enabled.", "info");
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
			sendPlan(pi, ctx, args);
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
				set(ctx, false, "Plan mode OFF — edits/writes re-enabled.", "info");
				return;
			}
			ctx.ui.notify("Usage: /plan-guard status|on|off", "warning");
		},
	});

	// Persistent ctrl+p shortcut: user-only ON/OFF toggle. ctrl+p is normally
	// bound to the built-in model cycle; freeing it may require remapping
	// (app.model.cycleForward to ctrl+alt+p) — see README.
	pi.registerShortcut("ctrl+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (enabled) {
				set(ctx, false, "Plan mode OFF — edits/writes re-enabled.", "info");
				return;
			}
			set(ctx, true, "Plan mode ON — file edits disabled; write the plan via plan_save.", "warning");
			sendPlan(pi, ctx, "");
		},
	});

	// Block mutating tool calls while plan mode is active — unconditionally, no
	// path exceptions: the plan is written via plan_save/journal_append instead.
	// bash is deliberately NOT blocked (accepted residual risk per brief).
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return undefined;
		return { block: true, reason: BLOCK_REASON };
	});

	// Restore guard state on startup/reload/new/resume/fork.
	pi.on("session_start", async (_event, ctx) => {
		let restored = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STORE_KEY) {
				const data = entry.data as { enabled?: boolean } | undefined;
				enabled = data?.enabled ?? false;
				restored = true;
			}
		}
		if (!restored) enabled = false;
		syncStatus(ctx);
	});
}
