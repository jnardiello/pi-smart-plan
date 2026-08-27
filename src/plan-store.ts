/**
 * External plan store.
 * Plan/journal artifacts live in an EPHEMERAL extension-owned store under the
 * system temp dir: <tmpdir>/pi-smart-plan-<uid>/<repo-slug>/<goal>/ — per-user
 * (uid suffix + 0700 dirs, plans never world-readable) and wiped on reboot by
 * design. The model never touches those paths: all I/O goes through the pure
 * store functions below, and they return CONTENT, never bare paths.
 *
 * Position = state: active goals live at <root>/<goal>, completed ones at
 * <root>/done/<goal>. Re-opening a goal moves it back to active.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	applyWavesSection,
	buildWavesSection,
	computeLayers,
	flipCheckbox,
	inferPhase,
	ownsCovers,
	parseDoD,
	parseTasks,
	readyFrontier,
	validatePhaseTransition,
	validateTaskGraph,
	validationErrorMessage,
	type Phase,
} from "./plan-validate.ts";

const GOAL_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const JOURNAL_TAIL = 20;
const STORE_DIR_MODE = 0o700;

/** Absolute cwd with `/` → `-`, pi sessions-dir style: /Users/x/repo → -Users-x-repo. */
function repoSlug(cwd: string): string {
	return resolve(cwd).replaceAll("/", "-");
}

/** Root of this repo's store: <tmpdir>/pi-smart-plan-<uid>/<repo-slug>.
 * Per-user subdir keeps plans private even though the parent is world-writable. */
function storeRoot(cwd: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return join(tmpdir(), `pi-smart-plan-${uid}`, repoSlug(cwd));
}

function activeGoalDir(cwd: string, goal: string): string {
	return join(storeRoot(cwd), goal);
}

function doneGoalDir(cwd: string, goal: string): string {
	return join(storeRoot(cwd), "done", goal);
}

/** Goal slugs come from the model — reject anything but kebab-case before it
 * ever reaches a filesystem call (blocks `/`, `..`, spaces via the pattern).
 * Also reserves the bucket name `done`. Messages are safe to forward to the
 * model — they never embed filesystem paths. */
export class PlanStoreValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanStoreValidationError";
	}
}

function validateGoal(goal: string): void {
	if (!GOAL_PATTERN.test(goal)) {
		throw new PlanStoreValidationError(
			`Invalid goal "${goal}": use kebab-case with lowercase letters and digits only (e.g. "fix-crash"). ` +
				"No slashes, dots, or spaces allowed."
		);
	}
	if (goal === "done") {
		throw new PlanStoreValidationError(`"done" is a reserved name — pick a different goal slug.`);
	}
}

/** Today's date as YYYY-MM-DD (local calendar day). */
function isoDate(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Ensure the goal exists as an active directory, reopening it from done/ first
 * when it only lives there. Validates the slug and creates dirs as needed.
 * Returns the active goal directory; used by both savePlan and appendJournal.
 */
function ensureActiveGoalDir(cwd: string, goal: string): string {
	validateGoal(goal);
	const goalDir = activeGoalDir(cwd, goal);
	if (!existsSync(goalDir)) {
		const doneDir = doneGoalDir(cwd, goal);
		if (existsSync(doneDir)) {
			mkdirSync(storeRoot(cwd), { recursive: true, mode: STORE_DIR_MODE });
			renameSync(doneDir, goalDir);
		}
	}
	mkdirSync(goalDir, { recursive: true, mode: STORE_DIR_MODE });
	return goalDir;
}

/**
 * Write (overwrite) <root>/<goal>/plan.md after mechanical DAG validation:
 * duplicate IDs, unknown deps, cycles, overlapping owns within a wave and
 * missing done checks reject the save with a precise error. The derived
 * `## Review — waves` section is regenerated server-side on every save.
 * Plans without a `## Tasks` block are treated as drafts and saved as-is.
 * If the goal currently exists only in done/, move it back to active first.
 * Returns the written path for internal log/notify use — never surface it to
 * the model.
 */
export function savePlan(cwd: string, goal: string, content: string): string {
	validateGoal(goal);
	let finalContent = content;
	const tasks = parseTasks(content);
	if (tasks.length > 0) {
		const issues = validateTaskGraph(tasks);
		if (issues.length > 0) throw new PlanStoreValidationError(validationErrorMessage(issues));
		finalContent = applyWavesSection(content, buildWavesSection(tasks, computeLayers(tasks)!));
	}
	const phaseIssues = validatePhaseTransition(content);
	if (phaseIssues.length > 0) throw new PlanStoreValidationError(validationErrorMessage(phaseIssues));
	const goalDir = ensureActiveGoalDir(cwd, goal);
	const planPath = join(goalDir, "plan.md");
	writeFileSync(planPath, finalContent, "utf8");
	return planPath;
}

/**
 * Append to <root>/<goal>/journal.md, each non-empty line prefixed with the ISO
 * date (YYYY-MM-DD). Creates the file/dirs if missing. Journal is append-only.
 * Returns the journal path for internal use only.
 */
export function appendJournal(cwd: string, goal: string, lines: string): string {
	const goalDir = ensureActiveGoalDir(cwd, goal);
	const journalPath = join(goalDir, "journal.md");
	const date = isoDate();
	const entry = lines
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => `${date} ${line}`)
		.join("\n");
	appendFileSync(journalPath, entry ? `\n${entry}\n` : "", "utf8");
	return journalPath;
}

/** Read a file, tolerating a missing/broken one. */
function readOptional(filePath: string): string {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}

/** dir/<goal> entries under a parent dir, sorted; ignores non-directories. */
function listGoalDirs(parent: string): string[] {
	let names: string[] = [];
	try {
		names = readdirSync(parent);
	} catch {
		return names; // parent missing/unreadable → empty list
	}
	return names
		.filter((name) => {
			try {
				return statSync(join(parent, name)).isDirectory();
			} catch {
				return false; // broken entry (dead symlink, vanished dir) — skip it alone
			}
		})
		.sort();
}

/** First non-empty line of a plan; goal slug fallback. */
function planHeadline(plan: string, goal: string): string {
	for (const line of plan.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return `(empty plan) — ${goal}`;
}

/** Last ~N lines of a journal, non-empty tail preserved. */
function journalTail(journal: string): string {
	const lines = journal.split("\n").filter((line) => line.length > 0);
	return lines.slice(-JOURNAL_TAIL).join("\n");
}

/**
 * Text recall of the plan store for this repo.
 * Without query: list active + done goals with the plan's first line.
 * With query: case-insensitive match against plan.md + journal.md; matched goals
 * include the full plan.md and the last ~20 journal lines.
 * Always returns content, never bare paths.
 */
export function recall(cwd: string, query?: string): string {
	const root = storeRoot(cwd);
	const needle = (query ?? "").toLowerCase().trim();
	// `done` is the completion bucket, not a goal: never list it as active.
	const active = listGoalDirs(root).filter((name) => name !== "done");
	const doneRoot = join(root, "done");
	const done = listGoalDirs(doneRoot).map((name) => ({ name, done: true }));

	const sections: string[] = [];
	const activeHeading = active.length ? `Active goals:\n${active.map((g) => `- ${g}`).join("\n")}` : "Active goals: none";
	sections.push(activeHeading);
	const doneHeading = done.length ? `Done goals:\n${done.map((g) => `- ${g.name}`).join("\n")}` : "Done goals: none";
	sections.push(doneHeading);

	if (needle === "") {
		for (const g of active) {
			const plan = readOptional(join(root, g, "plan.md"));
			sections.push(`\n- ${g}: ${planHeadline(plan, g)}`);
		}
		for (const g of done) {
			const plan = readOptional(join(doneRoot, g.name, "plan.md"));
			sections.push(`\n- ${g.name}: ${planHeadline(plan, g.name)}`);
		}
		return sections.join("\n");
	}

	const hits: string[] = [];
	for (const g of active) {
		const plan = readOptional(join(root, g, "plan.md"));
		const journal = readOptional(join(root, g, "journal.md"));
		if ((plan + "\n" + journal).toLowerCase().includes(needle)) hits.push(`\n## ${g} (active)\n\n### plan.md\n${plan}\n\n### journal.md (last ${JOURNAL_TAIL} lines)\n${journalTail(journal)}`);
	}
	for (const g of done) {
		const plan = readOptional(join(doneRoot, g.name, "plan.md"));
		const journal = readOptional(join(doneRoot, g.name, "journal.md"));
		if ((plan + "\n" + journal).toLowerCase().includes(needle)) hits.push(`\n## ${g.name} (done)\n\n### plan.md\n${plan}\n\n### journal.md (last ${JOURNAL_TAIL} lines)\n${journalTail(journal)}`);
	}
	if (hits.length === 0) {
		sections.push(`\nNo plans match "${query}".`);
	} else {
		sections.push(...hits);
	}
	return sections.join("\n");
}

/**
 * Move <root>/<goal>/ → <root>/done/<goal>/. Returns false when the active goal
 * does not exist.
 */
export function completeGoal(cwd: string, goal: string): boolean {
	validateGoal(goal);
	const goalDir = activeGoalDir(cwd, goal);
	if (!existsSync(goalDir)) return false;
	const doneDir = doneGoalDir(cwd, goal);
	mkdirSync(join(storeRoot(cwd), "done"), { recursive: true, mode: STORE_DIR_MODE });
	renameSync(goalDir, doneDir);
	return true;
}

/** True when at least one active goal in this repo's store has a plan.md. */
export function hasActivePlans(cwd: string): boolean {
	const root = storeRoot(cwd);
	for (const name of listGoalDirs(root)) {
		if (name !== "done" && existsSync(join(root, name, "plan.md"))) return true;
	}
	return false;
}

/** One summary line per active goal: phase, progress, ready frontier (widget/dialog). */
export function goalSummaries(cwd: string, guardOn: boolean): string[] {
	const root = storeRoot(cwd);
	const lines: string[] = [];
	for (const name of listGoalDirs(root)) {
		if (name === "done") continue;
		const content = readOptional(join(root, name, "plan.md"));
		const tasks = parseTasks(content);
		if (tasks.length === 0) {
			lines.push(`${name} [${inferPhase(content, guardOn)}] (no tasks yet)`);
			continue;
		}
		const done = tasks.filter((t) => t.done).length;
		const ready = readyFrontier(tasks).map((t) => t.id).join(", ");
		lines.push(`${name} [${inferPhase(content, guardOn)}] ${done}/${tasks.length} done · ready: ${ready || "—"}`);
	}
	return lines;
}

/** First active goal with its inferred phase — drives per-turn prompt injection.
 * Ties broken by most-recently-modified plan.md (the goal being worked on). */
export function currentPhase(cwd: string, guardOn: boolean): { goal: string; phase: Phase } | null {
	const root = storeRoot(cwd);
	let best: { goal: string; phase: Phase; mtime: number } | null = null;
	for (const name of listGoalDirs(root)) {
		if (name === "done") continue;
		const planPath = join(root, name, "plan.md");
		const content = readOptional(planPath);
		if (!content) continue;
		let mtime = 0;
		try {
			mtime = statSync(planPath).mtimeMs;
		} catch {
			mtime = 0;
		}
		if (!best || mtime > best.mtime) best = { goal: name, phase: inferPhase(content, guardOn), mtime };
	}
	return best ? { goal: best.goal, phase: best.phase } : null;
}

/**
 * Mechanically computed ready frontier for a goal: pending tasks whose deps
 * are all done. Returns CONTENT (never paths); throws when no plan exists.
 */
export function nextTasks(cwd: string, goal: string): string {
	validateGoal(goal);
	const content = readOptional(join(activeGoalDir(cwd, goal), "plan.md"));
	if (!content) {
		throw new PlanStoreValidationError(`no active plan for goal "${goal}" — save one first via plan_save`);
	}
	const tasks = parseTasks(content);
	if (tasks.length === 0) {
		return `Plan for "${goal}" has no Tasks section yet.`;
	}
	const doneCount = tasks.filter((t) => t.done).length;
	const frontier = readyFrontier(tasks);
	const lines = [`Goal "${goal}": ${doneCount}/${tasks.length} tasks done.`];
	if (frontier.length === 0) {
		lines.push("Ready frontier: none — every remaining task has unmet deps (re-plan or close deps first).");
	} else {
		lines.push(`Ready frontier (${frontier.length}) — dispatch these now:`);
		for (const task of frontier) {
			lines.push(`- ${task.id}: ${task.title}`);
			lines.push(`  owns: [${task.owns.join(", ")}]`);
		}
	}
	return lines.join("\n");
}

// --- task lifecycle: owns verification + dependency discipline ---------------

/** Dirty files (modified + untracked, renames split) relative to repo root.
 * Returns null outside a git worktree or when git fails — callers degrade to
 * the weaker all-owns check. */
function gitDirtyFiles(cwd: string): string[] | null {
	try {
		if (!existsSync(join(cwd, ".git"))) return null;
		const out = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.flatMap((line) => line.slice(3).trim().replace(/^"|"$/g, "").split(" -> "));
	} catch {
		return null;
	}
}

/** Dirty-file baseline captured when a task is claimed (in_progress). */
const taskSnapshots = new Map<string, string[]>();
const snapshotKey = (goal: string, taskId: string) => `${goal}::${taskId}`;

/**
 * Set a task's status server-side. Claiming (in_progress) snapshots dirty
 * files; closing (done) verifies the delta stayed inside the task's owns and
 * that every dependency is already done. The checkbox is flipped surgically —
 * the rest of the plan is never touched. Transitions are journaled.
 */
export function updateTaskStatus(cwd: string, goal: string, taskId: string, status: string): string {
	validateGoal(goal);
	if (!(status === "pending" || status === "in_progress" || status === "blocked" || status === "done")) {
		throw new PlanStoreValidationError(`invalid status "${status}" — use pending | in_progress | blocked | done`);
	}
	const planPath = join(activeGoalDir(cwd, goal), "plan.md");
	const content = readOptional(planPath);
	if (!content) throw new PlanStoreValidationError(`no active plan for goal "${goal}" — save one first via plan_save`);
	const tasks = parseTasks(content);
	const task = tasks.find((t) => t.id === taskId);
	if (!task) throw new PlanStoreValidationError(`unknown task "${taskId}" in goal "${goal}"`);

	if (status === "done") {
		const undone = task.deps.filter((dep) => tasks.find((t) => t.id === dep)?.done !== true);
		if (undone.length > 0) {
			throw new PlanStoreValidationError(`task ${taskId}: dependencies not done yet (${undone.join(", ")}) — close them first`);
		}
		const dirty = gitDirtyFiles(cwd);
		if (dirty) {
			const base = taskSnapshots.get(snapshotKey(goal, taskId));
			const scope = base ? dirty.filter((file) => !base.includes(file)) : dirty;
			const checkAgainst = base ? task.owns : tasks.flatMap((t) => t.owns);
			const violations = scope.filter((file) => !ownsCovers(file, checkAgainst));
			if (violations.length > 0) {
				taskSnapshots.delete(snapshotKey(goal, taskId));
				appendJournal(cwd, goal, `task ${taskId} DONE REJECTED — files outside owns: ${violations.join(", ")}`);
				throw new PlanStoreValidationError(
					`task ${taskId}: changed files outside its owns [${checkAgainst.join(", ")}]: ${violations.join(", ")} — fix or escalate to the owner`,
				);
			}
		}
	}

	const updated = flipCheckbox(content, taskId, status === "done");
	if (updated === null) throw new PlanStoreValidationError(`task line for "${taskId}" not found in the plan`);
	writeFileSync(planPath, updated, "utf8");

	if (status === "in_progress") {
		taskSnapshots.set(snapshotKey(goal, taskId), gitDirtyFiles(cwd) ?? []);
	} else {
		taskSnapshots.delete(snapshotKey(goal, taskId));
	}
	if (status === "done") appendJournal(cwd, goal, `task ${taskId} closed (owns verified)`);
	return `Task ${taskId} → ${status}${status === "done" ? " (owns + deps verified)" : ""}.`;
}

/** Raw text of a top-level ## section (without the heading), or "". */
function extractSection(content: string, name: string): string {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => new RegExp(`^##\\s+${name}\\b`).test(line));
	if (start === -1) return "";
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s/.test(lines[i])) break;
		out.push(lines[i]);
	}
	return out.join("\n").trim();
}

export interface PlanViewTask {
	id: string;
	title: string;
	done: boolean;
	deps: string[];
	owns: string[];
	ready: boolean;
	wave: number;
}

export interface PlanView {
	goal: string;
	scope: string;
	nonGoals: string;
	dod: string[];
	hld: string;
	tasks: PlanViewTask[];
	doneCount: number;
	total: number;
	frontier: string[];
}

/** Structured snapshot of a goal's plan for UI rendering (live panel). */
export function getPlanView(cwd: string, goal: string): PlanView | null {
	const content = readOptional(join(activeGoalDir(cwd, goal), "plan.md"));
	if (!content) return null;
	const tasks = parseTasks(content);
	const layers = computeLayers(tasks) ?? new Map();
	const doneIds = new Set(tasks.filter((t) => t.done).map((t) => t.id));
	const viewTasks: PlanViewTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		done: t.done,
		deps: t.deps,
		owns: t.owns,
		ready: !t.done && t.deps.every((dep) => doneIds.has(dep)),
		wave: layers.get(t.id) ?? 0,
	}));
	const firstLine = (name: string) => extractSection(content, name).split("\n")[0] ?? "";
	return {
		goal,
		scope: firstLine("Scope"),
		nonGoals: extractSection(content, "Non-goals").split("\n").join(" · "),
		dod: parseDoD(content),
		hld: extractSection(content, "HLD"),
		tasks: viewTasks,
		doneCount: tasks.filter((t) => t.done).length,
		total: tasks.length,
		frontier: readyFrontier(tasks).map((t) => t.id),
	};
}

/** Durable home of APPROVED plans: <agentDir>/smart-plan/approved/<repo>/<goal>/. */
function approvedRoot(): string {
	return join(getAgentDir(), "smart-plan", "approved");
}

/**
 * Persist the APPROVED plan to the durable store (survives reboots, unlike the
 * ephemeral working store). Called only after Gate 1 (owner validated the
 * contract). Returns the destination path — internal use only.
 */
export function persistApproved(cwd: string, goal: string): string {
	validateGoal(goal);
	const content = readOptional(join(activeGoalDir(cwd, goal), "plan.md"));
	if (!content) throw new PlanStoreValidationError(`no active plan for goal "${goal}" — save one first via plan_save`);
	const destDir = join(approvedRoot(), repoSlug(cwd), goal);
	mkdirSync(destDir, { recursive: true });
	const dest = join(destDir, "plan.md");
	writeFileSync(dest, content, "utf8");
	appendJournal(cwd, goal, "plan APPROVED by owner and persisted durably");
	return dest;
}

/** Executable DoD commands of a goal's plan (mechanical delivery gate). */
export function getDoD(cwd: string, goal: string): string[] {
	const content = readOptional(join(activeGoalDir(cwd, goal), "plan.md"));
	if (!content) throw new PlanStoreValidationError(`no active plan for goal "${goal}" — save one first via plan_save`);
	return parseDoD(content);
}
