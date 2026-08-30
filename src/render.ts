/**
 * pi-smart-plan — pure, testable panel renderers.
 *
 * Every function here takes plain data plus a structural PanelTheme and
 * returns string[] lines: no pi runtime, no I/O, no global state. That's
 * what lets test/smoke.mjs exercise them directly against a plain mock
 * theme object instead of a real pi session.
 */
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
			lines.push(...line(theme.fg("mdHeading", theme.bold(heading[1]))));
			continue;
		}
		const bullet = text.match(/^[-*•]\s+(.*)$/);
		if (bullet) {
			lines.push(...line(`${theme.fg("mdListBullet", "•")} ${theme.fg("text", bullet[1])}`));
			continue;
		}
		lines.push(...line(theme.fg("text", text)));
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

// ---- tiny renderCall/renderResult helpers (index.ts's 12 tool renderers) --
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
