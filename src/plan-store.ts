/**
 * External plan store (T1).
 * Plan/journal artifacts move out of the repo into the extension-owned store at
 * <agentDir>/smart-plan/<repo-slug>/<goal>/. The model never touches those paths:
 * all I/O goes through the pure store functions below, and they return CONTENT,
 * never bare paths for the model to re-read.
 *
 * Position = state: active goals live at <root>/<goal>, completed ones at
 * <root>/done/<goal>. Re-opening a goal moves it back to active.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const GOAL_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const JOURNAL_TAIL = 20;

/** Agent config directory (e.g. ~/.pi/agent) — exported by the peer package. */
function agentDirOf(): string {
	return getAgentDir();
}

/** Absolute cwd with `/` → `-`, pi sessions-dir style: /Users/x/repo → -Users-x-repo. */
function repoSlug(cwd: string): string {
	return resolve(cwd).replaceAll("/", "-");
}

/** Root of this repo's store: <agentDir>/smart-plan/<repo-slug>. */
function storeRoot(cwd: string): string {
	return join(agentDirOf(), "smart-plan", repoSlug(cwd));
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
			mkdirSync(storeRoot(cwd), { recursive: true });
			renameSync(doneDir, goalDir);
		}
	}
	mkdirSync(goalDir, { recursive: true });
	return goalDir;
}

/**
 * Write (overwrite) <root>/<goal>/plan.md. If the goal currently exists only in
 * done/, move it back to active first (re-opening). Returns the written path for
 * internal log/notify use — never surface it to the model.
 */
export function savePlan(cwd: string, goal: string, content: string): string {
	const goalDir = ensureActiveGoalDir(cwd, goal);
	const planPath = join(goalDir, "plan.md");
	writeFileSync(planPath, content, "utf8");
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
	mkdirSync(join(storeRoot(cwd), "done"), { recursive: true });
	renameSync(goalDir, doneDir);
	return true;
}
