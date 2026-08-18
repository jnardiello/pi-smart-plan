/**
 * pi-smart-plan — read-only plan mode for pi.
 * While active, edit/write are blocked unless the target path resolves inside the
 * <cwd>/backlog/ directory. Only the user (native confirm, ctrl+p toggle) or the
 * /plan-guard command can exit; the model has no unilateral way out.
 */
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runAskForm } from "./src/ask-form.ts";
import { planUserMessage } from "./src/prompts.ts";

const STORE_KEY = "plan-guard";
const STATUS_KEY = "plan-guard";
const ALLOWED_SEGMENT = "backlog";
const BLOCK_REASON =
	"Plan mode is active — you may only write backlog/<goal>/plan.md and " +
	"backlog/<goal>/journal.md. Keep planning, or call plan_exit (user confirmation required).";

let enabled = false;

/** Absolute, normalized path. Built-ins strip a leading "@" before resolving paths. */
function absolutize(cwd: string, raw: string): string {
	const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
	const joined = stripped.startsWith("/") ? stripped : `${cwd}/${stripped}`;
	const parts: string[] = [];
	for (const segment of joined.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.join("/");
}

/** True when the resolved absolute path is inside "<resolved cwd>/backlog/". */
function insideBacklog(cwd: string, rawPath: unknown): boolean {
	if (typeof rawPath !== "string") return false;
	const resolvedPath = absolutize(cwd, rawPath);
	const cwdBacklog = absolutize(cwd, ALLOWED_SEGMENT); // <resolved cwd>/backlog
	return resolvedPath === cwdBacklog || resolvedPath.startsWith(cwdBacklog + "/");
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

	pi.registerTool({
		name: "plan_enter",
		label: "Enter plan mode",
		description: "Activate plan mode: edits/writes outside backlog/ are blocked until the user confirms exit.",
		promptSnippet: "plan_enter: enter read-only plan mode (only backlog/ may be written)",
		promptGuidelines: ["Use plan_enter to start planning; during plan mode write only plan.md / journal.md under backlog/<goal>/."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (enabled) {
				return { content: [{ type: "text", text: "Plan mode is already active." }], details: { enabled } };
			}
			set(ctx, true, "Plan mode ON — writes are restricted to backlog/.", "warning");
			return {
				content: [{ type: "text", text: "Plan mode active. You may only write backlog/<goal>/plan.md and backlog/<goal>/journal.md." }],
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
				content: [{ type: "text", text: "The user declined to exit plan mode. Keep planning and write only under backlog/." }],
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

	pi.registerCommand("plan", {
		description: "Goal-scoped planning: /plan <goal>",
		handler: async (args, ctx) => {
			// First-class entry point: the user typed the command, so activating the
			// guard needs no further confirmation.
			if (!enabled) {
				set(ctx, true, "Plan mode ON — writes are restricted to backlog/.", "warning");
			}
			const message = planUserMessage(args);
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
			}
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
				set(ctx, true, "Plan mode ON — writes are restricted to backlog/.", "warning");
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
			set(ctx, true, "Plan mode ON — writes are restricted to backlog/.", "warning");
			const message = planUserMessage("");
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
		},
	});

	// Block mutating tool calls while plan mode is active.
	// bash is deliberately NOT blocked (accepted residual risk per brief).
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return undefined;
		if (insideBacklog(ctx.cwd, event.input.path)) return undefined;
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
