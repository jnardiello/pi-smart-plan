/**
 * DAG-as-data validator for pi-smart-plan plans.
 *
 * Parses the `## Tasks` block of a plan and turns the workflow conventions
 * (unique IDs, resolvable acyclic deps, disjoint owns per parallel layer,
 * verifiable done checks) into mechanical guarantees enforced on plan_save.
 * Also derives the execution waves server-side so the model never hand-writes
 * them.
 *
 * Plans without a `## Tasks` heading are treated as drafts and skipped.
 */

export interface PlanTask {
	id: string;
	done: boolean;
	title: string;
	deps: string[];
	owns: string[];
	hasDoneCheck: boolean;
}

/** Lifecycle phases of the plan state machine (canonical order). */
export const PHASES = ["discovery", "hld", "decompose", "ablate", "present", "execute"] as const;
export type Phase = (typeof PHASES)[number];

const PHASE_LINE = /^phase:\s*(\w+)\s*$/m;

/** Explicit `phase:` marker from the plan status block, when valid. */
export function parsePhaseLine(content: string): Phase | undefined {
	const match = PHASE_LINE.exec(content);
	const value = match?.[1] as Phase | undefined;
	return value && PHASES.includes(value) ? value : undefined;
}

/**
 * Current phase of a plan: explicit `phase:` line wins; otherwise inferred
 * from structure (HLD/Tasks sections) and the guard state. Fallbacks are
 * best-effort — the workflow mandates setting the explicit line at transitions.
 */
export function inferPhase(content: string, guardOn: boolean): Phase {
	if (!guardOn) return "execute";
	const explicit = parsePhaseLine(content);
	if (explicit && explicit !== "execute") return explicit;
	const hasHld = /^##\s+HLD\b/m.test(content);
	const tasks = parseTasks(content);
	if (tasks.length === 0) return hasHld ? "decompose" : "discovery";
	return hasHld ? "present" : "decompose";
}

export interface ValidationIssue {
	task?: string;
	message: string;
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
	const start = lines.findIndex((line) => /^##\s+Tasks\b/.test(line));
	if (start === -1) return [];

	const tasks: PlanTask[] = [];
	let current: PlanTask | undefined;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) break; // next section
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
	const start = lines.findIndex((line) => /^##\s+Review\s+—\s+waves/i.test(line));
	if (start === -1) {
		const trimmed = content.replace(/\s+$/, "");
		return `${trimmed}\n\n${section}\n`;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return [...lines.slice(0, start), ...section.split("\n"), "", ...lines.slice(end)].join("\n");
}

/** Tasks whose deps are all done and which are not done themselves. */
export function readyFrontier(tasks: PlanTask[]): PlanTask[] {
	const doneIds = new Set(tasks.filter((t) => t.done).map((t) => t.id));
	return tasks.filter((t) => !t.done && t.deps.every((dep) => doneIds.has(dep)));
}

/** Preconditions each explicit `phase:` value must satisfy structurally.
 * `execute` is governed by the guard, not by plan content. */
const PHASE_PRECONDITIONS: Record<string, { hld?: boolean; tasks?: boolean }> = {
	discovery: {},
	hld: {},
	decompose: { hld: true },
	ablate: { hld: true, tasks: true },
	present: { hld: true, tasks: true },
};

/** Reject illegal phase jumps on save: an explicit `phase:` line must be
 * backed by the structure it claims (HLD section, task list). */
export function validatePhaseTransition(content: string): ValidationIssue[] {
	const phase = parsePhaseLine(content);
	if (!phase || phase === "execute") return [];
	const pre = PHASE_PRECONDITIONS[phase];
	if (!pre) return [];
	const issues: ValidationIssue[] = [];
	if (pre.hld && !/^##\s+HLD\b/m.test(content)) {
		issues.push({ message: `phase "${phase}" requires a ## HLD section (confirm the design first)` });
	}
	if (pre.tasks && parseTasks(content).length === 0) {
		issues.push({ message: `phase "${phase}" requires at least one task in ## Tasks` });
	}
	return issues;
}

/** Extract executable DoD commands from the `## DoD` section. */
export function parseDoD(content: string): string[] {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => /^##\s+DoD\b/.test(line));
	if (start === -1) return [];
	const commands: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^##\s/.test(line)) break;
		const trimmed = line.trim().replace(/^-\s*/, "").replace(/^`+|`+$/g, "").trim();
		if (trimmed.length > 0 && !trimmed.startsWith("#")) commands.push(trimmed);
	}
	return commands;
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
