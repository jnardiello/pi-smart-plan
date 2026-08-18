/**
 * Custom ask_smart_plan form: tabs, label+description, side preview, inline note.
 * Pattern taken from pi's official question.ts / questionnaire.ts examples.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type AskQuestion = {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: { label: string; description?: string; preview?: string }[];
};

export type AskFormResult = { declined: true } | { answers: Record<string, string | string[]> };

const CUSTOM = "None of these — I'll specify";
const PREVIEW_MIN = 80;

export async function runAskForm(ctx: ExtensionContext, questions: AskQuestion[]): Promise<AskFormResult> {
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
		return { declined: true };
	}

	const result = await ctx.ui.custom<AskFormResult>((tui, theme, _kb, done) => {
		let tab = 0;
		let optionIndex = 0;
		let editMode = false;
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
			return [...q.options, { label: CUSTOM, custom: true }];
		}

		function refresh(): void {
			cached = undefined;
			tui.requestRender();
		}

		function finish(): void {
			const out: Record<string, string | string[]> = {};
			for (const q of questions) {
				const a = answers.get(qKey(q));
				if (a !== undefined) out[q.question] = a;
			}
			done({ answers: out });
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
				editMode = false;
				editor.setText("");
				refresh();
				return;
			}
			editMode = false;
			editor.setText("");
			if (q.multiSelect) {
				const picks = multiPicks.get(qKey(q)) ?? [];
				picks.push(trimmed);
				multiPicks.set(qKey(q), picks);
				answers.set(qKey(q), picks);
				refresh();
				return;
			}
			saveSingle(q, trimmed);
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
				refresh();
				return;
			}
			if (questions.length > 1 && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
				tab = (tab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
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
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done({ declined: true });
				return;
			}

			if (q.multiSelect && matchesKey(data, Key.space)) {
				const opt = opts[optionIndex];
				if (!opt || opt.custom) return;
				const picks = multiPicks.get(qKey(q)) ?? [];
				const i = picks.indexOf(opt.label);
				if (i >= 0) picks.splice(i, 1);
				else picks.push(opt.label);
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
						editMode = true;
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
			const previewText = selected?.preview || selected?.description || "";

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

			if (wide && previewText) {
				const previewWidth = w - listWidth - 3;
				const previewLines = wrapTextWithAnsi(theme.fg("dim", previewText), Math.max(8, previewWidth));
				const rows = Math.max(body.length, previewLines.length);
				for (let r = 0; r < rows; r++) {
					const left = (body[r] ?? "").padEnd(listWidth);
					const right = previewLines[r] ?? "";
					lines.push(`${left} │ ${right}`);
				}
			} else {
				lines.push(...body);
				if (!wide && previewText) {
					lines.push("");
					addPrefixed(lines, " ", theme.fg("dim", previewText), w);
				}
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
					: "↑↓ • Enter select • Esc cancel" + (questions.length > 1 ? " • Tab questions" : "");
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
