/**
 * pi-smart-plan — read-only plan mode for pi.
 * While active, edit/write are blocked unless the target path resolves inside the
 * <cwd>/backlog/ directory. Only the user (native confirm, ctrl+p toggle) or the
 * /plan-guard command can exit; the model has no unilateral way out.
 */
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

	pi.registerCommand("plan", {
		description: "Goal-scoped planning: /plan <goal>",
		handler: async (args, ctx) => {
			// First-class entry point: the user typed the command, so activating the
			// guard needs no further confirmation.
			if (!enabled) {
				set(ctx, true, "Plan mode ON — writes are restricted to backlog/.", "warning");
			}
			// Verified against pi 0.84.2 docs/skills.md + docs/packages.md: a packaged
			// skill in ./skills is discovered via pi.skills in package.json and /skill:name
			// messages expand ONLY when sendUserMessage passes expandPromptTemplates:true
			// (dist/core/agent-session.js _expandSkillCommand; default is false).
			// An empty goal is fine: Phase 1 elicits it.
			const goal = args.trim();
			const message = goal ? `/skill:plan ${goal}` : "/skill:plan";
			if (ctx.isIdle()) {
				pi.sendUserMessage(message, { expandPromptTemplates: true });
			} else {
				pi.sendUserMessage(message, { expandPromptTemplates: true, deliverAs: "followUp" });
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
			const next = !enabled;
			set(ctx, next, next ? "Plan mode ON — writes are restricted to backlog/." : "Plan mode OFF — edits/writes re-enabled.", next ? "warning" : "info");
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
