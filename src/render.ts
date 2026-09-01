/**
 * pi-smart-plan — pure, testable panel renderers.
 *
 * Every function here takes plain data plus a structural PanelTheme and
 * returns string[] lines: no pi runtime, no I/O, no global state. That's
 * what lets test/smoke.mjs exercise them directly against a plain mock
 * theme object instead of a real pi session.
 */
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Phase } from "./plan-validate.ts";
import { PHASE_CAPTIONS, PHASE_PROMPTS } from "./prompts.ts";
import type { PlanView, PlanViewTask } from "./plan-store.ts";

/** Structural theme contract these renderers depend on — the same {fg, bold}
 * shape the panels have always taken. pi's real Theme class satisfies this
 * structurally; test/smoke.mjs's fakeTheme mock is exactly this shape.
 * Deliberately NOT widened to bg/italic/getMarkdownTheme(): see
 * renderHldBody's doc for why the HLD body is hand-styled instead of routed
 * through pi-tui's Markdown component. */
export interface PanelTheme {
	fg: (color: any, text: string) => string;
	bold: (text: string) => string;
}

const BORDER_GLYPH = "▌";
/** Below this width the todo-DAG drops its `∥`/`← deps` annotations so the
 * tree itself (branches, glyphs, id, title) never gets crowded out. */
const NARROW_WIDTH = 50;

/** Border-prefixed line builders shared by every panel: every physical line
 * is `▌ <content>`. `line` wraps prose to width - 2 (for multi-line text
 * that's fine to break across rows); `trunc` truncates instead (for
 * single-line tree/DAG rows, where wrapping would break the ├─/└─
 * structure). */
function makeLineBuilders(theme: PanelTheme, width: number): { bar: string; line: (content?: string) => string[]; trunc: (content: string) => string[] } {
	const bar = theme.fg("borderAccent", BORDER_GLYPH);
	const contentWidth = Math.max(1, width - 2);
	const line = (content = ""): string[] => {
		if (!content) return [bar];
		return wrapTextWithAnsi(content, contentWidth).map((part) => `${bar} ${part}`);
	};
	const trunc = (content: string): string[] => [`${bar} ${truncateToWidth(content, contentWidth)}`];
	return { bar, line, trunc };
}

/** Inline markdown for the HLD body, in the same hand-styled spirit as
 * renderHldBody: `**b**`/`__b__` bold, `` `c` `` code and `*i*`/`_i_` italic
 * lose their markers (code/italic stay unstyled — PanelTheme names no color
 * for either). Only balanced, non-empty, non-space-hugging pairs match, so a
 * lone `*` or `a * b * c` survives verbatim; `_` pairs additionally require
 * non-word neighbours so `snake_case_name` is left alone. */
function renderInlineMarkdown(text: string, bold: (value: string) => string): string {
	const pattern = /`([^`\n]+)`|\*\*(\S|\S[^\n]*?\S)\*\*|(?<!\w)__(\S|\S[^\n]*?\S)__(?!\w)|\*(\S|\S[^\n]*?\S)\*|(?<!\w)_(\S|\S[^\n]*?\S)_(?!\w)/g;
	return text.replace(pattern, (_match, code, starBold, underBold, starItalic, underItalic) => {
		if (code !== undefined) return code;
		if (starBold !== undefined) return bold(starBold);
		if (underBold !== undefined) return bold(underBold);
		return starItalic ?? underItalic;
	});
}

/** HLD body fallback. pi-tui's `Markdown` component needs `getMarkdownTheme()`,
 * but that function reads pi's process-global theme singleton instead of the
 * `theme` instance handed to this (or any) entry renderer — wiring it in
 * here would make this module secretly depend on global runtime state (and
 * on a real initialized `Theme` instance, which test/smoke.mjs's plain
 * fakeTheme mock is not), breaking the "pure function of its own arguments"
 * contract this whole file is built around. So: a small hand-styled
 * fallback instead — `#`-prefixed lines as headings (mdHeading),
 * `-`/`*`/`•`-prefixed lines as bullets (mdListBullet), everything else as
 * plain wrapped text. */
function renderHldBody(hld: string, theme: PanelTheme, line: (content?: string) => string[]): string[] {
	const lines: string[] = [];
	for (const raw of hld.split("\n")) {
		const text = raw.trim();
		if (!text) continue;
		const heading = text.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			// Headings bold the whole row, so inline bold must be a no-op here:
			// a nested bold's reset would un-bold the rest of the heading.
			lines.push(...line(theme.fg("mdHeading", theme.bold(renderInlineMarkdown(heading[1], (value) => value)))));
			continue;
		}
		const bullet = text.match(/^[-*•]\s+(.*)$/);
		if (bullet) {
			lines.push(...line(`${theme.fg("mdListBullet", "•")} ${theme.fg("text", renderInlineMarkdown(bullet[1], (value) => theme.bold(value)))}`));
			continue;
		}
		lines.push(...line(theme.fg("text", renderInlineMarkdown(text, (value) => theme.bold(value)))));
	}
	return lines;
}

/** One task's tree row: branch glyph, done/ready/pending glyph, id + title,
 * then EITHER its deps (`← T1,T2`, dim) or — for a task sharing a
 * multi-task wave with no deps of its own — the in-wave parallel marker
 * `∥`. The first task of a wave never gets `∥` (the wave header already
 * says "these run together"; the marker exists to flag the OTHER tasks
 * riding along with it). Both annotations are dropped below NARROW_WIDTH. */
function renderTaskLine(task: PlanViewTask, isLast: boolean, indexInWave: number, waveSize: number, theme: PanelTheme, narrow: boolean): string {
	const branch = isLast ? "└─" : "├─";
	const glyph = task.done ? theme.fg("success", "☑") : task.ready ? theme.fg("accent", "☐") : theme.fg("dim", "☐");
	const title = theme.fg(task.done ? "muted" : "text", `${task.id}  ${task.title}`);
	let trailer = "";
	if (!narrow) {
		if (task.deps.length > 0) trailer = ` ${theme.fg("dim", `← ${task.deps.join(",")}`)}`;
		else if (waveSize >= 2 && indexInWave > 0) trailer = ` ${theme.fg("dim", "∥")}`;
	}
	return `${branch} ${glyph} ${title}${trailer}`;
}

/** Style-B todo-DAG: one vertical trunk (`│`) linking wave headers, `├─`/
 * `└─` branches per task within a wave, done/ready/pending glyphs, the
 * in-wave parallel marker `∥`, cross-wave deps `← T1,T2`, closed by a
 * `N/M done · ready now: …` footer. Waves are grouped by `task.wave`
 * (already 1-based from computeLayers) in first-seen order, which tolerates
 * the store not having tasks pre-sorted by wave. Returns [] when there are
 * no tasks yet (HLD-only draft) — the DAG only renders once tasks exist. */
function renderTaskDag(view: PlanView, theme: PanelTheme, builders: { line: (content?: string) => string[]; trunc: (content: string) => string[] }, narrow: boolean): string[] {
	if (view.tasks.length === 0) return [];
	const { line, trunc } = builders;
	const waveOrder: number[] = [];
	const byWave = new Map<number, PlanViewTask[]>();
	for (const task of view.tasks) {
		if (!byWave.has(task.wave)) {
			byWave.set(task.wave, []);
			waveOrder.push(task.wave);
		}
		byWave.get(task.wave)!.push(task);
	}
	const lines: string[] = [];
	let prevWaveTasks: PlanViewTask[] | undefined;
	for (const waveNum of waveOrder) {
		const waveTasks = byWave.get(waveNum)!;
		if (prevWaveTasks) lines.push(...trunc(theme.fg("dim", "│")));
		let header = `${theme.fg("accent", "●")} ${theme.bold(`WAVE ${waveNum}`)}`;
		if (prevWaveTasks && prevWaveTasks.length > 0) {
			const first = prevWaveTasks[0].id;
			const last = prevWaveTasks[prevWaveTasks.length - 1].id;
			const range = first === last ? first : `${first}–${last}`;
			header += `   ${theme.fg("dim", `(waits for ${range})`)}`;
		}
		lines.push(...trunc(header));
		waveTasks.forEach((task, i) => {
			lines.push(...trunc(renderTaskLine(task, i === waveTasks.length - 1, i, waveTasks.length, theme, narrow)));
		});
		prevWaveTasks = waveTasks;
	}
	lines.push(...line());
	const ready = view.frontier.length > 0 ? view.frontier.join(" ") : "none";
	lines.push(...trunc(theme.fg("muted", `${view.doneCount}/${view.total} done · ready now: ${ready}`)));
	return lines;
}

/** Themed implementation-plan panel: header, a labeled OBJECTIVE / SCOPE /
 * NON-GOALS / DoD block, the HLD body, then — once tasks exist — the
 * style-B todo-DAG. The LIVE checklist behavior is the caller's: it
 * re-reads getPlanView on every redraw and calls this function fresh, so
 * glyphs/footer always reflect the current store. */
export function renderPlanPanel(view: PlanView, theme: PanelTheme, width: number): string[] {
	const { bar, line, trunc } = makeLineBuilders(theme, width);
	const narrow = width < NARROW_WIDTH;
	const lines: string[] = [];
	const label = (name: string, value: string): string[] => line(theme.fg("accent", theme.bold(name)) + theme.fg("text", `: ${value}`));
	lines.push(...line(theme.fg("accent", theme.bold("◈ IMPLEMENTATION PLAN")) + theme.fg("muted", ` — ${view.goal}`)));
	if (view.intent) lines.push(...label("OBJECTIVE", view.intent));
	if (view.scope) lines.push(...label("SCOPE", view.scope));
	if (view.nonGoals) lines.push(...label("NON-GOALS", view.nonGoals));
	if (view.dod.length) lines.push(...label("DoD", view.dod.join(" && ")));
	if (view.hld) {
		lines.push(bar);
		lines.push(...line(theme.fg("accent", theme.bold("HLD"))));
		lines.push(...renderHldBody(view.hld, theme, line));
	}
	if (view.tasks.length > 0) {
		lines.push(bar);
		lines.push(...renderTaskDag(view, theme, { line, trunc }, narrow));
	}
	return lines;
}

/** Themed objective-proposal card, rendered into the transcript BEFORE the
 * plan_intent Confirm/Keep chatting form opens: title, goal slug and the
 * statement wrapped to the full panel width — the form's own side panel
 * only shows a few lines, so this is the durable, fully-readable copy in
 * the main transcript. Same border glyph/theme as renderPlanPanel. */
export function renderIntentPanel(goal: string, statement: string, theme: PanelTheme, width: number): string[] {
	const { bar, line } = makeLineBuilders(theme, width);
	const lines: string[] = [];
	lines.push(...line(theme.fg("accent", theme.bold("◈ OBJECTIVE PROPOSAL")) + theme.fg("muted", ` — ${goal}`)));
	lines.push(bar);
	lines.push(...line(theme.fg("text", statement)));
	return lines;
}

// ---- tiny renderCall/renderResult helpers (index.ts's 11 tool renderers) --
// Same "pure, testable" contract as the panel renderers above, just shaped
// for one-liner tool rows instead of multi-line panels.

/** First text block's raw string from a tool result's content array.
 * Duck-typed against AgentToolResult's content shape (never importing
 * pi-agent-core types here) — image content or a missing block reads as "". */
export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
}

/** First line of a (possibly multi-line) string — keeps error/summary
 * renderResult lines to one line regardless of how long the underlying
 * message is. */
export function firstLine(text: string): string {
	return text.split("\n")[0] ?? "";
}

/** `▪ <verb>` call-line label shared by every tool's renderCall: bold, in
 * the toolTitle color, same convention pi's own built-in tool renderers use
 * (examples/extensions/built-in-tool-renderer.ts). Callers append their own
 * accent-colored argument after this. */
export function toolCallLabel(theme: PanelTheme, verb: string): string {
	return theme.fg("toolTitle", theme.bold(`▪ ${verb}`));
}

/** One-line mission for a phase, pulled straight from its PHASE_PROMPTS entry
 * (single source of truth — never duplicated) — used to tell the model what
 * the phase it just entered is for, right after a transition. Falls back to
 * a bare phase name if the LOCAL MISSION line is ever missing. */
export function phaseMissionLine(phase: Phase): string {
	const match = PHASE_PROMPTS[phase].match(/^LOCAL MISSION:.*$/m);
	return match ? match[0] : `phase ${phase}`;
}

/** plan_task_update's renderCall verb per status — "claimed"/"done" read more
 * naturally in a one-liner than the raw enum values (pending/blocked pass
 * through unchanged). */
const TASK_STATUS_VERB: Record<string, string> = { in_progress: "claimed", done: "done", blocked: "blocked", pending: "pending" };

/** Shared renderResult prelude: while the result is still partial, a themed
 * "<verb>…" placeholder; once settled, an optional themed error line — the
 * exact `if (context.isError) return new Text(theme.fg("error", …), 0, 0)`
 * early-return that 9 of the 11 tools share. errorText is omitted by the two
 * tools (plan_task_update, plan_verify) whose own isError handling isn't
 * this simple early-return; they call this only for the isPartial line and
 * keep their own logic below it. Returns the Text to return immediately, or
 * undefined to fall through into the tool's own ready-state body. */
export function stdResult(theme: PanelTheme, isPartial: boolean, verb: string, isError?: boolean, errorText?: string): Text | undefined {
	if (isPartial) return new Text(theme.fg("warning", `${verb}…`), 0, 0);
	if (isError && errorText !== undefined) return new Text(theme.fg("error", errorText), 0, 0);
	return undefined;
}

/** Result-context shape every renderResult reads isError from — duck-typed,
 * same rationale as resultText's. */
interface RenderContext {
	isError?: boolean;
}

/** The second renderResult argument: isPartial always, expanded only for the
 * two tools (plan_recall, plan_verify) with a collapsed/expanded body. */
interface ResultOpts {
	isPartial: boolean;
	expanded?: boolean;
}

/** Every tool's {renderCall, renderResult} pair, keyed by tool name —
 * spread into that tool's registerTool({…}) call in index.ts. Loosely typed
 * on purpose (the 11 pairs are genuinely heterogeneous in their args/result
 * shapes); each function body below is still precisely typed against what it
 * actually reads. */
export const toolRenderers: Record<string, { renderCall: (...args: any[]) => Text; renderResult: (...args: any[]) => Text }> = {
	plan_exit: {
		renderCall(_args: unknown, theme: PanelTheme, _context: unknown) {
			return new Text(toolCallLabel(theme, "exiting plan mode"), 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = firstLine(resultText(result));
			const prelude = stdResult(theme, isPartial, "confirming", context.isError, text);
			if (prelude) return prelude;
			const details = result.details as { enabled?: boolean; approved?: string[] } | undefined;
			if (details?.enabled === false) {
				const approved = details.approved?.length ? theme.fg("muted", ` — implementing ${details.approved.join(", ")}`) : "";
				return new Text(theme.fg("success", "plan mode exited ✓") + approved, 0, 0);
			}
			return new Text(theme.fg("muted", text), 0, 0);
		},
	},

	ask_smart_plan: {
		renderCall(args: { phaseGate?: boolean; releasePlanGuardOnAnswer?: boolean; questions: unknown[] }, theme: PanelTheme, _context: unknown) {
			const gate = args.phaseGate === true || args.releasePlanGuardOnAnswer === true;
			const n = args.questions.length;
			const label = gate ? "opening the owner gate" : `asking the owner (${n} question${n === 1 ? "" : "s"})`;
			return new Text(toolCallLabel(theme, label), 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = firstLine(resultText(result));
			const prelude = stdResult(theme, isPartial, "asking", context.isError, text);
			if (prelude) return prelude;
			const details = result.details as
				| { answers?: Record<string, unknown>; declined?: boolean; unanswered?: string[]; advanced?: boolean; released?: boolean; phase?: string }
				| undefined;
			if (details?.released) return new Text(theme.fg("success", `authorized ✓ → ${details.phase}`), 0, 0);
			if (details?.advanced) return new Text(theme.fg("success", `approved ✓ → ${details.phase}`), 0, 0);
			if (details?.declined) {
				const unanswered = details.unanswered?.length ? ` (${details.unanswered.length} unanswered)` : "";
				return new Text(theme.fg("warning", `postponed${unanswered}`), 0, 0);
			}
			const count = details?.answers ? Object.keys(details.answers).length : 0;
			return new Text(theme.fg("success", `answered ✓ (${count})`), 0, 0);
		},
	},

	plan_advance: {
		renderCall(_args: unknown, theme: PanelTheme, _context: unknown) {
			return new Text(toolCallLabel(theme, "advancing…"), 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = firstLine(resultText(result));
			const prelude = stdResult(theme, isPartial, "advancing", context.isError, text);
			if (prelude) return prelude;
			const details = result.details as { phase?: Phase; declined?: boolean; released?: boolean } | undefined;
			if (details?.phase) {
				let line = theme.fg("success", "→ ") + theme.fg("accent", theme.bold(details.phase)) + theme.fg("muted", ` — ${PHASE_CAPTIONS[details.phase]}`);
				if (details.declined) line += theme.fg("warning", " (postponed)");
				else if (details.released) line += theme.fg("muted", " (guard released)");
				return new Text(line, 0, 0);
			}
			return new Text(theme.fg("success", text), 0, 0);
		},
	},

	plan_save: {
		renderCall(args: { goal: string }, theme: PanelTheme, _context: unknown) {
			return new Text(`${toolCallLabel(theme, "saving plan")} ${theme.fg("accent", args.goal)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const prelude = stdResult(theme, isPartial, "saving", context.isError, firstLine(resultText(result)));
			if (prelude) return prelude;
			return new Text(theme.fg("success", "plan saved ✓") + theme.fg("muted", " (waves rebuilt)"), 0, 0);
		},
	},

	plan_intent: {
		renderCall(args: { openQuestions?: unknown[]; goal: string }, theme: PanelTheme, _context: unknown) {
			const n = args.openQuestions?.length ?? 0;
			const label = n > 0 ? `asking ${n} open question${n === 1 ? "" : "s"}` : "proposing objective";
			return new Text(`${toolCallLabel(theme, label)} ${theme.fg("accent", args.goal)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = firstLine(resultText(result));
			const prelude = stdResult(theme, isPartial, "confirming", context.isError, text);
			if (prelude) return prelude;
			const details = result.details as { confirmed?: boolean; declined?: boolean; keepChatting?: boolean; unanswered?: string[] } | undefined;
			if (details?.confirmed) return new Text(theme.fg("success", "objective confirmed ✓"), 0, 0);
			if (details?.declined || details?.keepChatting) return new Text(theme.fg("warning", "keep chatting — objective rejected"), 0, 0);
			if (details?.unanswered) return new Text(theme.fg("muted", `open questions asked (${details.unanswered.length} unanswered)`), 0, 0);
			return new Text(theme.fg("muted", text), 0, 0);
		},
	},

	journal_append: {
		renderCall(args: { lines: string }, theme: PanelTheme, _context: unknown) {
			const preview = truncateToWidth(firstLine(args.lines), 60);
			return new Text(`${toolCallLabel(theme, "noting")} ${theme.fg("accent", `"${preview}"`)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const prelude = stdResult(theme, isPartial, "noting", context.isError, firstLine(resultText(result)));
			if (prelude) return prelude;
			return new Text(theme.fg("success", "noted ✓"), 0, 0);
		},
	},

	plan_recall: {
		renderCall(args: { query?: string }, theme: PanelTheme, _context: unknown) {
			let text = toolCallLabel(theme, "recalling plans");
			if (args.query) text += ` ${theme.fg("accent", args.query)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }, { expanded, isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = resultText(result);
			const prelude = stdResult(theme, isPartial, "recalling", context.isError, firstLine(text));
			if (prelude) return prelude;
			const lines = text.split("\n").filter((l) => l.trim().length > 0);
			if (lines.length === 0) return new Text(theme.fg("muted", "no matching plans"), 0, 0);
			const shown = expanded ? lines.slice(0, 30) : lines.slice(0, 3);
			let out = shown.map((l) => theme.fg("text", truncateToWidth(l, 100))).join("\n");
			const hidden = lines.length - shown.length;
			if (hidden > 0) {
				const more = expanded ? `... ${hidden} more lines` : `... ${hidden} more (${keyHint("app.tools.expand", "to expand")})`;
				out += `\n${theme.fg("dim", more)}`;
			}
			return new Text(out, 0, 0);
		},
	},

	plan_next: {
		renderCall(args: { goal: string }, theme: PanelTheme, _context: unknown) {
			return new Text(`${toolCallLabel(theme, "what's ready?")} ${theme.fg("accent", args.goal)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = resultText(result);
			const prelude = stdResult(theme, isPartial, "checking", context.isError, firstLine(text));
			if (prelude) return prelude;
			const ids = [...text.matchAll(/^- (\S+):/gm)].map((m) => m[1]);
			if (ids.length > 0) return new Text(theme.fg("accent", `ready: ${ids.join(" ")}`), 0, 0);
			if (text.includes("no Tasks section")) return new Text(theme.fg("muted", "no tasks yet"), 0, 0);
			return new Text(theme.fg("success", "all done ✓"), 0, 0);
		},
	},

	plan_task_update: {
		renderCall(args: { taskId: string; status: string }, theme: PanelTheme, _context: unknown) {
			const verb = TASK_STATUS_VERB[args.status] ?? args.status;
			return new Text(`${toolCallLabel(theme, `${args.taskId} →`)} ${theme.fg("accent", verb)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const prelude = stdResult(theme, isPartial, "updating");
			if (prelude) return prelude;
			const text = firstLine(resultText(result));
			return new Text(theme.fg(context.isError ? "error" : "success", text), 0, 0);
		},
	},

	plan_verify: {
		renderCall(args: { goal: string }, theme: PanelTheme, _context: unknown) {
			return new Text(`${toolCallLabel(theme, "running DoD checks")} ${theme.fg("accent", args.goal)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }, { expanded, isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const prelude = stdResult(theme, isPartial, "running DoD checks");
			if (prelude) return prelude;
			const text = resultText(result);
			const lines = text.split("\n").filter(Boolean);
			const headline = lines[0] ?? "";
			// A caught error (safeError text) never starts with "DoD" — the two
			// real DoD headlines always do ("DoD: N/N PASS." / "DoD FAILED: …").
			if (context.isError && !headline.startsWith("DoD")) return new Text(theme.fg("error", headline), 0, 0);
			const rows = lines.slice(1).map((row) => {
				const m = row.match(/^(PASS|FAIL) \((\d+)ms\) (.*)$/);
				if (!m) return { failed: false, line: theme.fg("dim", row) };
				const passed = m[1] === "PASS";
				const glyph = passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
				return { failed: !passed, line: `${glyph} ${theme.fg("dim", `(${m[2]}ms)`)} ${theme.fg(passed ? "text" : "error", m[3])}` };
			});
			const color = headline.startsWith("DoD FAILED") ? "error" : headline.startsWith("DoD:") ? "success" : "muted";
			const summary = theme.fg(color, theme.bold(headline));
			// Collapsed: headline plus only the failing rows (all-pass stays a
			// single line); expanded: the full per-command breakdown.
			const shown = expanded ? rows : rows.filter((r) => r.failed);
			if (shown.length === 0) return new Text(summary, 0, 0);
			return new Text([summary, ...shown.map((r) => r.line)].join("\n"), 0, 0);
		},
	},

	plan_complete: {
		renderCall(args: { goal: string }, theme: PanelTheme, _context: unknown) {
			return new Text(`${toolCallLabel(theme, "completing")} ${theme.fg("accent", args.goal)}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, { isPartial }: ResultOpts, theme: PanelTheme, context: RenderContext) {
			const text = firstLine(resultText(result));
			const prelude = stdResult(theme, isPartial, "completing", context.isError, text);
			if (prelude) return prelude;
			const details = result.details as { completed?: boolean } | undefined;
			return new Text(theme.fg(details?.completed ? "success" : "muted", details?.completed ? "goal completed ✓" : text), 0, 0);
		},
	},
};
