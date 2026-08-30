/**
 * Custom ask_smart_plan form: tabs, label+description, side preview, inline note.
 * Pattern taken from pi's official question.ts / questionnaire.ts examples.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type AskQuestion = {
	question: string;
	header?: string;
	detail?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string; preview?: string }[];
};

/** Lenient option shape accepted at the tool boundary: a bare string is
 * shorthand for `{ label }` — a real session lost a round trip to
 * `options.M: must be object` when the model passed plain strings. */
export type AskOptionInput = string | { label: string; description?: string; preview?: string };

/** Lenient question shape accepted at the tool boundary (options may be bare
 * strings). Normalized to `AskQuestion` via `normalizeAskQuestions` before any
 * downstream code sees it — a strict widening, existing `AskQuestion[]`
 * callers keep compiling unchanged. */
export type AskQuestionInput = {
	question: string;
	header?: string;
	detail?: string;
	multiSelect?: boolean;
	options: AskOptionInput[];
};

export type AskFormResult = { declined: true } | { answers: Record<string, string | string[]> };

/** Maximum questions rendered per sequential form page. Auto-paging splits any
 * larger question set into multiple sequential forms, so an overflow can never
 * be rejected (the old schema hard-rejected >4 questions, which made the model
 * silently decide the dropped question — this paging makes that impossible). */
export const ASK_FORM_PAGE_MAX = 4;

/** Aggregated outcome of a paged form run (sequential pages of at most
 * ASK_FORM_PAGE_MAX questions). On cancellation (`declined`) every question
 * from the cancelled page onward is reported in `unanswered` — answers are
 * never invented for questions the owner never saw. */
export type PagedAskFormResult = {
	declined: boolean;
	answers: Record<string, string | string[]>;
	unanswered: AskQuestion[];
};

const CUSTOM = "None of the above";
const PREVIEW_MIN = 80;

/** Coerces bare-string options to `{ label }`; called at the entry of both
 * `runAskForm` and `runAskFormPages` so all downstream code keeps seeing the
 * strict `AskQuestion` shape regardless of what the tool boundary received. */
export function normalizeAskQuestions(questions: AskQuestionInput[]): AskQuestion[] {
	return questions.map((q) => ({
		...q,
		options: q.options.map((opt) => (typeof opt === "string" ? { label: opt } : opt)),
	}));
}

export async function runAskForm(
	ctx: ExtensionContext,
	questionsInput: AskQuestionInput[],
	opts?: { includeNoneOption?: boolean },
): Promise<AskFormResult> {
	const includeNoneOption = opts?.includeNoneOption ?? true;
	const questions = normalizeAskQuestions(questionsInput);
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
		return { declined: true };
	}

	const result = await ctx.ui.custom<AskFormResult>((tui, theme, _kb, done) => {
		let tab = 0;
		let optionIndex = 0;
		let editMode = false;
		let paneScroll = 0;
		let cached: string[] | undefined;
		const answers = new Map<string, string | string[]>();
		const multiPicks = new Map<string, string[]>();
		const totalTabs = questions.length + (questions.length > 1 ? 1 : 0);

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function qKey(q: AskQuestion): string {
			return q.question;
		}

		function chip(q: AskQuestion, i: number): string {
			const raw = (q.header ?? `Q${i + 1}`).trim();
			return raw.length > 12 ? `${raw.slice(0, 11)}…` : raw;
		}

		function optionsOf(q: AskQuestion): { label: string; description?: string; preview?: string; custom?: boolean }[] {
			return includeNoneOption ? [...q.options, { label: CUSTOM, custom: true }] : [...q.options];
		}

		function refresh(): void {
			cached = undefined;
			tui.requestRender();
		}

		function resetPane(): void {
			paneScroll = 0;
		}

		function finish(): void {
			const out: Record<string, string | string[]> = {};
			for (const q of questions) {
				const a = answers.get(qKey(q));
				if (a !== undefined) out[q.question] = a;
			}
			done({ answers: out });
		}

		function finishIfReady(): void {
			if (allAnswered()) finish();
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(qKey(q)));
		}

		function saveSingle(q: AskQuestion, value: string): void {
			answers.set(qKey(q), value);
			if (questions.length === 1) {
				finish();
				return;
			}
			if (tab < questions.length - 1) tab += 1;
			else tab = questions.length;
			optionIndex = 0;
			refresh();
		}

		editor.onSubmit = (value) => {
			const q = questions[tab];
			if (!q) return;
			const trimmed = value.trim();
			if (!trimmed) {
				// Empty note on the built-in "None of the above": the note is OPTIONAL — accept as-is.
				editMode = false;
				editor.setText("");
				if (q.multiSelect) {
					multiPicks.set(qKey(q), [CUSTOM]);
					answers.set(qKey(q), [CUSTOM]);
				} else {
					saveSingle(q, CUSTOM);
				}
				refresh();
				return;
			}
			editMode = false;
			editor.setText("");
			if (q.multiSelect) {
				const picks = multiPicks.get(qKey(q)) ?? [];
				picks.push(trimmed.includes(CUSTOM) ? trimmed : `${CUSTOM} — ${trimmed}`);
				multiPicks.set(qKey(q), picks);
				answers.set(qKey(q), picks);
				refresh();
				return;
			}
			saveSingle(q, trimmed.includes(CUSTOM) ? trimmed : `${CUSTOM} — ${trimmed}`);
		};

		function handleInput(data: string): void {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (questions.length > 1 && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
				tab = (tab + 1) % totalTabs;
				optionIndex = 0;
				resetPane();
				refresh();
				return;
			}
			if (questions.length > 1 && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
				tab = (tab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
				resetPane();
				refresh();
				return;
			}

			if (tab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) finish();
				else if (matchesKey(data, Key.escape)) done({ declined: true });
				return;
			}

			const q = questions[tab];
			const opts = optionsOf(q);

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				resetPane();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				resetPane();
				refresh();
				return;
			}
			if (data === "j" || data === "J" || matchesKey(data, Key.pageDown)) {
				paneScroll += data === "j" || data === "J" ? 1 : 5;
				refresh();
				return;
			}
			if (data === "k" || data === "K" || matchesKey(data, Key.pageUp)) {
				paneScroll = Math.max(0, paneScroll - (data === "k" || data === "K" ? 1 : 5));
				refresh();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done({ declined: true });
				return;
			}

			if (q.multiSelect && matchesKey(data, Key.space)) {
				const opt = opts[optionIndex];
				if (!opt) return;
				let picks = [...(multiPicks.get(qKey(q)) ?? [])];
				if (opt.custom) {
					picks = picks.includes(CUSTOM) ? [] : [CUSTOM];
				} else {
					picks = picks.filter((pick) => pick !== CUSTOM);
					const i = picks.indexOf(opt.label);
					if (i >= 0) picks.splice(i, 1);
					else picks.push(opt.label);
				}
				multiPicks.set(qKey(q), picks);
				if (picks.length) answers.set(qKey(q), picks);
				else answers.delete(qKey(q));
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (q.multiSelect) {
					const opt = opts[optionIndex];
					if (opt?.custom) {
						let picks = (multiPicks.get(qKey(q)) ?? []).filter((pick) => pick !== CUSTOM);
						picks.push(CUSTOM);
						multiPicks.set(qKey(q), picks);
						answers.set(qKey(q), picks);
						finishIfReady();
						refresh();
						return;
					}
					if (answers.has(qKey(q))) {
						if (tab < questions.length - 1) tab += 1;
						else if (questions.length > 1) tab = questions.length;
						else finish();
						optionIndex = 0;
						refresh();
					}
					return;
				}
				const opt = opts[optionIndex];
				if (!opt) return;
				if (opt.custom) {
					editMode = true;
					refresh();
					return;
				}
				saveSingle(q, opt.label);
			}
		}

		function addWrapped(lines: string[], text: string, width: number): void {
			lines.push(...wrapTextWithAnsi(text, width));
		}

		function addPrefixed(lines: string[], prefix: string, text: string, width: number): void {
			const pw = visibleWidth(prefix);
			if (pw >= width) {
				addWrapped(lines, prefix + text, width);
				return;
			}
			const wrapped = wrapTextWithAnsi(text, width - pw);
			const cont = " ".repeat(pw);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
			}
		}

		function padVisible(s: string, width: number): string {
			const vis = visibleWidth(s);
			if (vis >= width) return s;
			return s + " ".repeat(width - vis);
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const w = Math.max(1, width);
			const lines: string[] = [];
			const wide = w >= PREVIEW_MIN;
			const listWidth = wide ? Math.max(24, Math.floor(w * 0.58)) : w;

			lines.push(theme.fg("accent", "─".repeat(w)));

			if (questions.length > 1) {
				const parts: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const answered = answers.has(qKey(questions[i]));
					const mark = answered ? "■" : "□";
					const text = ` ${mark} ${chip(questions[i], i)} `;
					const active = i === tab;
					const styled = active
						? theme.bg
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg("accent", text)
						: theme.fg(answered ? "success" : "muted", text);
					parts.push(styled);
				}
				const submitActive = tab === questions.length;
				const submit = allAnswered() ? " ✓ Submit " : " Submit ";
				const submitStyled = submitActive
					? theme.bg
						? theme.bg("selectedBg", theme.fg("text", submit))
						: theme.fg("accent", submit)
					: theme.fg(allAnswered() ? "success" : "dim", submit);
				parts.push(submitStyled);
				addWrapped(lines, parts.join(" "), w);
				lines.push("");
			}

			if (tab === questions.length) {
				addPrefixed(lines, " ", theme.fg("text", allAnswered() ? "All questions answered. Enter to submit." : "Answer every question, then submit."), w);
				addPrefixed(lines, " ", theme.fg("dim", "Tab change question • Enter submit • Esc cancel"), w);
				lines.push(theme.fg("accent", "─".repeat(w)));
				cached = lines;
				return lines;
			}

			const q = questions[tab];
			const opts = optionsOf(q);
			addPrefixed(lines, " ", theme.fg("text", q.question), w);
			if (q.multiSelect) addPrefixed(lines, " ", theme.fg("muted", "Multi-select — Space to toggle"), w);
			lines.push("");

			const selected = opts[optionIndex];

			const body: string[] = [];
			for (let i = 0; i < opts.length; i++) {
				const opt = opts[i];
				const on = i === optionIndex;
				const picks = multiPicks.get(qKey(q)) ?? [];
				const checked = q.multiSelect && picks.includes(opt.label) ? "[x] " : q.multiSelect ? "[ ] " : "";
				const prefix = on ? theme.fg("accent", "> ") : "  ";
				const label = `${i + 1}. ${checked}${opt.label}${opt.custom && editMode ? " ✎" : ""}`;
				addPrefixed(body, prefix, theme.fg(on || (opt.custom && editMode) ? "accent" : "text", label), listWidth);
				if (opt.description && !opt.custom) {
					addPrefixed(body, "     ", theme.fg("muted", opt.description), listWidth);
				}
			}

			const paneWidth = wide ? Math.max(8, w - listWidth - 3) : w;
			const briefing: string[] = [];
			if (q.detail?.trim()) {
				addPrefixed(briefing, "", theme.fg("text", q.detail.trim()), paneWidth);
			} else {
				addPrefixed(briefing, "", theme.fg("dim", "No briefing on this question."), paneWidth);
			}
			if (selected && !selected.custom) {
				briefing.push("");
				addPrefixed(briefing, "", theme.fg("accent", `If you pick “${selected.label}”:`), paneWidth);
				const consequence = (selected.preview || selected.description || "").trim();
				if (consequence) addPrefixed(briefing, "", theme.fg("muted", consequence), paneWidth);
				else addPrefixed(briefing, "", theme.fg("dim", "No extra consequences written for this option."), paneWidth);
			} else if (selected?.custom) {
				briefing.push("");
				addPrefixed(briefing, "", theme.fg("muted", "Optional note — submit an empty note to accept \u201cNone of the above\u201d as-is."), paneWidth);
			}
			const viewport = Math.max(body.length, 6);
			const maxScroll = Math.max(0, briefing.length - viewport);
			if (paneScroll > maxScroll) paneScroll = maxScroll;
			const view = briefing.slice(paneScroll, paneScroll + viewport);
			while (view.length < viewport) view.push("");
			const more = paneScroll < maxScroll || paneScroll > 0;

			if (wide) {
				const rule = theme.fg("dim", "│");
				for (let r = 0; r < viewport; r++) {
					const left = padVisible(body[r] ?? "", listWidth);
					lines.push(`${left} ${rule} ${view[r] ?? ""}`);
				}
				if (more) {
					addPrefixed(lines, padVisible("", listWidth) + " ", theme.fg("dim", `↕ ${paneScroll + 1}–${paneScroll + view.length}/${briefing.length}  J/K or PgUp/PgDn`), w);
				}
			} else {
				lines.push(...body);
				lines.push("");
				lines.push(...view);
				if (more) addPrefixed(lines, " ", theme.fg("dim", "J/K or PgUp/PgDn to scroll briefing"), w);
			}

			if (editMode) {
				lines.push("");
				addPrefixed(lines, " ", theme.fg("muted", "Your note:"), w);
				for (const line of editor.render(Math.max(1, w - 2))) {
					lines.push(` ${line}`);
				}
			}

			lines.push("");
			const hint = editMode
				? "Enter submit note • Esc back to list"
				: q.multiSelect
					? "↑↓ • Space toggle • Enter next • Esc cancel"
					: "↑↓ options • J/K briefing • Enter • Esc" + (questions.length > 1 ? " • Tab" : "");
			addPrefixed(lines, " ", theme.fg("dim", hint), w);
			lines.push(theme.fg("accent", "─".repeat(w)));
			cached = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});

	return result ?? { declined: true };
}

/** Run `runAskForm` over `questions` as sequential pages of at most `pageMax`
 * (default ASK_FORM_PAGE_MAX), aggregating every page's answers into a single
 * result keyed by the original question text — original order preserved. If a
 * page is cancelled (`declined`), the answers collected so far are kept and all
 * questions from the cancelled page onward are reported as `unanswered`; the
 * tool never invents them. */
export async function runAskFormPages(
	ctx: ExtensionContext,
	questionsInput: AskQuestionInput[],
	pageMax: number = ASK_FORM_PAGE_MAX,
): Promise<PagedAskFormResult> {
	const questions = normalizeAskQuestions(questionsInput);
	const answers: Record<string, string | string[]> = {};
	for (let i = 0; i < questions.length; i += pageMax) {
		const page = questions.slice(i, i + pageMax);
		const result = await runAskForm(ctx, page);
		if ("declined" in result) {
			return { declined: true, answers, unanswered: questions.slice(i) };
		}
		Object.assign(answers, result.answers);
	}
	return { declined: false, answers, unanswered: [] };
}
