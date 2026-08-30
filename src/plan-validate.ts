/**
 * DAG-as-data validator for pi-smart-plan plans.
 *
 * Parses the `## Tasks` block of a plan and turns the workflow conventions
 * (unique IDs, resolvable acyclic deps, disjoint owns per parallel layer,
 * verifiable done checks) into mechanical guarantees enforced on plan_save.
 * Also derives the execution waves server-side so the model never hand-writes
 * them.
 *
 * Also the single source of truth for the phase enum (re-exported by
 * phase-machine.ts, never redefined) and for the save-time deliverable-shape
 * check: every plan_save must carry the full HLD shape — non-empty
 * ## HLD/Scope/Non-goals/Decisions/DoD with canonical English headings,
 * body text in any language — regardless of phase (see validatePhaseShape).
 *
 * Plans without a `## Tasks` heading are treated as drafts and skipped by
 * the task-graph functions below.
 */

export interface PlanTask {
	id: string;
	done: boolean;
	title: string;
	deps: string[];
	owns: string[];
	hasDoneCheck: boolean;
}

/**
 * Lifecycle phases of the plan state machine (canonical order), exactly two
 * owner touchpoints:
 *   discovery (chat, save HLD) → simplify (auto trim + cut log) →
 *   review_hld (Gate 1: present + approve) → decompose (auto DAG) →
 *   review_final (Gate 2: present + yes/no) → execute (guard released).
 */
export const PHASES = ["discovery", "simplify", "review_hld", "decompose", "review_final", "execute"] as const;
export type Phase = (typeof PHASES)[number];

/** Validate a raw phase.txt value against the canonical Phase set — the only
 * check readMachinePhase needs (phase.txt only ever holds one of today's
 * canonical names). Undefined when the value isn't recognized. */
export function toPhase(value: string): Phase | undefined {
	return (PHASES as readonly string[]).includes(value) ? (value as Phase) : undefined;
}

export interface ValidationIssue {
	task?: string;
	message: string;
}

/** Locate a top-level `## <heading>` section: from the line matching
 * `headingRe` to just before the next `^##` heading, or the end of `lines`.
 * Null when `headingRe` matches nothing. Shared by every "find `## X`, run
 * until the next section" scan below (sectionText, parseTasks,
 * applyWavesSection, parseDoD) — callers differ only in what they do with
 * the span; the per-site heading regex (including waves' case-insensitive
 * `/i`) is passed in and never altered here. */
function sectionSpan(lines: string[], headingRe: RegExp): { start: number; end: number } | null {
	const start = lines.findIndex((line) => headingRe.test(line));
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { start, end };
}

/** Text of a top-level `## Name` section (without the heading), or "" when
 * the section is absent or empty. Single source of truth — plan-store.ts
 * imports this directly rather than keeping its own copy. */
export function sectionText(content: string, name: string): string {
	const lines = content.split("\n");
	const span = sectionSpan(lines, new RegExp(`^##\\s+${name}\\b`));
	if (!span) return "";
	return lines
		.slice(span.start + 1, span.end)
		.join("\n")
		.trim();
}

const TASK_HEADER = /^\s*-\s*\[( |x)\]\s*([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.*)$/;
const DEPS_LINE = /^\s+deps:\s*\[([^\]]*)\]/;
const OWNS_LINE = /^\s+owns:\s*\[([^\]]*)\]/;
const DONE_LINE = /^\s+done:\s*(\S.*)$/;

function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Extract tasks from the `## Tasks` section; [] when the section is absent. */
export function parseTasks(content: string): PlanTask[] {
	const lines = content.split("\n");
	const span = sectionSpan(lines, /^##\s+Tasks\b/);
	if (!span) return [];

	const tasks: PlanTask[] = [];
	let current: PlanTask | undefined;
	for (let i = span.start + 1; i < span.end; i++) {
		const line = lines[i];
		const header = TASK_HEADER.exec(line);
		if (header) {
			current = {
				id: header[2],
				done: header[1] === "x",
				title: header[3].trim(),
				deps: [],
				owns: [],
				hasDoneCheck: false,
			};
			tasks.push(current);
			continue;
		}
		if (!current) continue;
		const deps = DEPS_LINE.exec(line);
		if (deps) {
			current.deps = parseList(deps[1]);
			continue;
		}
		const owns = OWNS_LINE.exec(line);
		if (owns) {
			current.owns = parseList(owns[1]);
			continue;
		}
		if (DONE_LINE.test(line)) current.hasDoneCheck = true;
	}
	return tasks;
}

/** True when two owns entries can touch the same file (prefix-aware). */
function ownsOverlap(a: string, b: string): boolean {
	if (a === "*" || b === "*") return true;
	const na = a.replace(/\/+$/, "");
	const nb = b.replace(/\/+$/, "");
	return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/** Topological layers (longest-path layering). Returns null on cycle. */
export function computeLayers(tasks: PlanTask[]): Map<string, number> | null {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const memo = new Map<string, number>();
	const visiting = new Set<string>();

	function layerOf(id: string): number | null {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) return null; // cycle
		visiting.add(id);
		const task = byId.get(id);
		let result: number | null = 1;
		for (const dep of task?.deps ?? []) {
			const depLayer = layerOf(dep);
			if (depLayer === null) {
				result = null;
				break;
			}
			result = Math.max(result ?? 1, depLayer + 1);
		}
		visiting.delete(id);
		if (result === null) return null;
		memo.set(id, result);
		return result;
	}

	for (const task of tasks) {
		if (layerOf(task.id) === null) return null;
	}
	return memo;
}

/** Validate the parsed graph; returns all violations (empty = valid). */
export function validateTaskGraph(tasks: PlanTask[]): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const seen = new Set<string>();
	for (const task of tasks) {
		if (seen.has(task.id)) {
			issues.push({ task: task.id, message: `duplicate task ID "${task.id}"` });
			continue;
		}
		seen.add(task.id);
	}
	const byId = new Map(tasks.map((t) => [t.id, t]));
	for (const task of tasks) {
		if (!seen.has(task.id)) continue; // duplicate already reported
		for (const dep of task.deps) {
			if (!byId.has(dep)) {
				issues.push({ task: task.id, message: `dep "${dep}" does not match any task ID` });
			}
		}
		if (!task.hasDoneCheck) {
			issues.push({ task: task.id, message: `missing "done:" verification check` });
		}
	}
	const layers = computeLayers(tasks);
	if (layers === null) {
		issues.push({ message: "dependency graph contains a cycle" });
		return issues;
	}
	// Owns must be disjoint between tasks that could run in parallel (same layer).
	const byLayer = new Map<number, PlanTask[]>();
	for (const task of tasks) {
		const layer = layers.get(task.id) ?? 0;
		byLayer.set(layer, [...(byLayer.get(layer) ?? []), task]);
	}
	for (const [layer, group] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				for (const ownA of group[i].owns) {
					for (const ownB of group[j].owns) {
						if (ownsOverlap(ownA, ownB)) {
							issues.push({
								task: group[j].id,
								message: `owns "${ownB}" overlaps "${ownA}" of task ${group[i].id} in the same wave (layer ${layer})`,
							});
						}
					}
				}
			}
		}
	}
	return issues;
}

/** Human-readable error text for PlanStoreValidationError. */
export function validationErrorMessage(issues: ValidationIssue[]): string {
	return (
		"plan rejected by DAG validation — fix and re-save:\n" +
		issues.map((issue) => `- ${issue.task ? `${issue.task}: ` : ""}${issue.message}`).join("\n")
	);
}

/** Derived waves section, regenerated server-side on every save. */
export function buildWavesSection(tasks: PlanTask[], layers: Map<string, number>): string {
	const byLayer = new Map<number, string[]>();
	for (const task of tasks) {
		const layer = layers.get(task.id) ?? 0;
		byLayer.set(layer, [...(byLayer.get(layer) ?? []), task.done ? `${task.id} ✓` : task.id]);
	}
	const lines = [...byLayer.keys()].sort((a, b) => a - b).map((layer) => `- Wave ${layer}: ${byLayer.get(layer)!.join(", ")}`);
	return `## Review — waves (derived)\n${lines.join("\n")}`;
}

/** Replace an existing derived-waves section, or append one. */
export function applyWavesSection(content: string, section: string): string {
	const lines = content.split("\n");
	const span = sectionSpan(lines, /^##\s+Review\s+—\s+waves/i);
	if (!span) {
		const trimmed = content.replace(/\s+$/, "");
		return `${trimmed}\n\n${section}\n`;
	}
	return [...lines.slice(0, span.start), ...section.split("\n"), "", ...lines.slice(span.end)].join("\n");
}

/** Tasks whose deps are all done and which are not done themselves. */
export function readyFrontier(tasks: PlanTask[]): PlanTask[] {
	const doneIds = new Set(tasks.filter((t) => t.done).map((t) => t.id));
	return tasks.filter((t) => !t.done && t.deps.every((dep) => doneIds.has(dep)));
}

/** Extract executable DoD commands from the `## DoD` section. */
export function parseDoD(content: string): string[] {
	const lines = content.split("\n");
	const span = sectionSpan(lines, /^##\s+DoD\b/);
	if (!span) return [];
	const commands: string[] = [];
	for (let i = span.start + 1; i < span.end; i++) {
		const line = lines[i];
		const trimmed = line.trim().replace(/^-\s*/, "").replace(/^`+|`+$/g, "").trim();
		if (trimmed.length > 0 && !trimmed.startsWith("#")) commands.push(trimmed);
	}
	return commands;
}

/** Sections every plan_save must carry, whatever the current phase — ideation
 * happens in chat, not across partial saves. */
const REQUIRED_SECTIONS = ["HLD", "Scope", "Non-goals", "Decisions", "DoD"] as const;

/** Phases whose deliverable additionally requires a non-empty ## Tasks DAG. */
const TASK_REQUIRED_PHASES: ReadonlySet<Phase> = new Set<Phase>(["decompose", "review_final", "execute"]);

const CANONICAL_HEADINGS_NOTE =
	"section headings must use the CANONICAL ENGLISH names (## HLD, ## Scope, ## Non-goals, ## Decisions, ## DoD, ## Tasks); body text may be in any language.";

/** Every top-level `## ` heading present in `content`, verbatim and in
 * document order — shown back to the model in the diagnostic below so a plan
 * with e.g. `## Decisioni chiuse` sees exactly what it wrote. */
function presentHeadings(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => /^##\s+\S/.test(line))
		.map((line) => line.trim());
}

/** One diagnostic issue for any missing-section case: names what's missing,
 * shows every heading actually found, and states the canonical-names fix —
 * a single round trip instead of five separate nags. */
function missingSectionsIssue(content: string, missingNames: readonly string[]): ValidationIssue {
	const found = presentHeadings(content);
	const foundText = found.length > 0 ? found.join(", ") : "(none found)";
	return {
		message: `missing required section(s): ${missingNames.map((name) => `## ${name}`).join(", ")}. Headings found in the plan: ${foundText}. ${CANONICAL_HEADINGS_NOTE}`,
	};
}

/**
 * Save-time deliverable-shape check. Every plan_save must carry the full HLD
 * shape regardless of phase: non-empty ## HLD, ## Scope, ## Non-goals,
 * ## Decisions, ## DoD with at least one executable DoD command (reuses
 * parseDoD). decompose/review_final/execute additionally require at least
 * one parsed task. Missing sections collapse into a single diagnostic issue
 * (see missingSectionsIssue) rather than one per section. Extra sections
 * beyond the required set are always allowed.
 */
export function validatePhaseShape(phase: Phase, content: string): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const missingSections = REQUIRED_SECTIONS.filter((name) => !sectionText(content, name));
	if (missingSections.length > 0) {
		issues.push(missingSectionsIssue(content, missingSections));
	} else if (parseDoD(content).length === 0) {
		issues.push({ message: "## DoD has no executable command line — list at least one command, one per line" });
	}
	if (TASK_REQUIRED_PHASES.has(phase) && parseTasks(content).length === 0) {
		issues.push({ message: "no tasks in ## Tasks — define the task DAG (id/deps/owns/done per task)" });
	}
	return issues;
}

/** Human-readable error text for PlanStoreValidationError on a shape-invalid
 * plan_save. Mirrors validationErrorMessage's bullet format. */
export function shapeErrorMessage(phase: Phase, issues: ValidationIssue[]): string {
	return (
		`plan_save rejected — content does not meet the "${phase}" deliverable shape:\n` +
		issues.map((issue) => `- ${issue.task ? `${issue.task}: ` : ""}${issue.message}`).join("\n")
	);
}

/** True when `file` falls inside one of the owns entries. */
export function ownsCovers(file: string, owns: string[]): boolean {
	return owns.some((own) => {
		if (own === "*") return true;
		const nOwn = own.replace(/\/+$/, "");
		const nFile = file.replace(/\/+$/, "");
		return nFile === nOwn || nFile.startsWith(nOwn + "/");
	});
}

/** Flip one task checkbox server-side. Returns null when the line is missing. */
export function flipCheckbox(content: string, taskId: string, done: boolean): string | null {
	const re = new RegExp(`^(\\s*- \\[)( |x)(\\] ${taskId}:)`, "m");
	if (!re.test(content)) return null;
	return content.replace(re, `$1${done ? "x" : " "}$3`);
}
