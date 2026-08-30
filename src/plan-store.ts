/**
 * External plan store.
 * Plan/journal artifacts live in an EPHEMERAL extension-owned store under the
 * system temp dir: <tmpdir>/pi-smart-plan-<uid>/<repo-slug>/<goal>/ — per-user
 * (uid suffix + 0700 dirs, plans never world-readable) and wiped on reboot by
 * design. The model never touches those paths: all I/O goes through the pure
 * store functions below, and they return CONTENT, never bare paths.
 *
 * Position = state: active goals live at <root>/<goal>, completed ones at
 * <root>/done/<goal>. Re-opening a goal moves it back to active. Each goal
 * dir also carries phase.txt (machine phase) and, once the owner-backed
 * objective has been confirmed via plan_intent, intent.txt (confirmed
 * statement + timestamp) — plan_save refuses to write plan.md until
 * intent.txt exists.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, statSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	applyWavesSection,
	buildWavesSection,
	computeLayers,
	flipCheckbox,
	ownsCovers,
	parseDoD,
	parseTasks,
	PHASES,
	readyFrontier,
	sectionText,
	shapeErrorMessage,
	toPhase,
	validatePhaseShape,
	validateTaskGraph,
	validationErrorMessage,
	type Phase,
	type ValidationIssue,
} from "./plan-validate.ts";

const GOAL_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const JOURNAL_TAIL = 20;
const STORE_DIR_MODE = 0o700;
/** C0 (excluding the whitespace already collapsed by the `\s+` pass below),
 * DEL and C1 control bytes — stripped from a confirmed objective statement so
 * an ANSI escape sequence (or any other control byte) the owner/model typed
 * can never land in journal.md / the plan panel / a form's rendered detail. */
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;
/** Objective statements are the WHAT, not the HOW — a mechanical length cap
 * keeps implementation detail out of `confirmIntent` and forces distillation
 * to 1–3 sentences (outcome + essential constraints); the HLD is where
 * implementation choices belong, and stays what simplify ablates. */
export const OBJECTIVE_MAX_LEN = 400;

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

/** True when `goal` currently lives in the completed bucket (done/<goal>).
 * Pure read — callers use it to refuse an active-goal-only operation (e.g.
 * plan_intent) on an already-completed goal instead of silently resurrecting
 * it. Validates nothing itself; callers validate the slug first. */
export function goalIsDone(cwd: string, goal: string): boolean {
	return existsSync(doneGoalDir(cwd, goal));
}

/** Path of the "last touched goal" pointer at the repo-slug store root. */
function activePointerPath(cwd: string): string {
	return join(storeRoot(cwd), "active.txt");
}

/** Trimmed content of active.txt ("" when absent). */
function readActivePointer(cwd: string): string {
	return readOptional(activePointerPath(cwd)).trim();
}

/** Path of the abandon-grace tombstone at the repo-slug store root. */
function tombstonePath(cwd: string): string {
	return join(storeRoot(cwd), "abandoned.txt");
}

/** Goal slugs come from the model — reject anything but kebab-case before it
 * ever reaches a filesystem call (blocks `/`, `..`, spaces via the pattern).
 * Also reserves the bucket name `done`. Messages are safe to forward to the
 * model — they never embed filesystem paths. */
export class PlanStoreValidationError extends Error {
	issues?: ValidationIssue[];
	constructor(message: string, issues?: ValidationIssue[]) {
		super(message);
		this.name = "PlanStoreValidationError";
		this.issues = issues;
	}
}

/** Single goal-slug validation entry point — every internal write path plus
 * every external caller (e.g. plan_intent) goes through this one function,
 * without going through a write path. */
export function validateGoalSlug(goal: string): void {
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
 * Refreshes the active.txt pointer (last-touched goal) at the store root.
 * Returns the active goal directory; the single choke point behind every
 * write path (savePlan, appendJournal, setMachinePhase).
 *
 * Phase ownership (B1): brand-new goals are pinned to the ENTRY phase
 * (discovery) the moment their directory is created — phase.txt exists before
 * any plan is written, so a first plan.md that already carries HLD+Tasks can
 * never drag inference to a later phase and deadlock a gate. A pre-v0.10 goal
 * that already exists without phase.txt is pinned to discovery the same way,
 * the first time a write touches it; pure read paths (currentPhase /
 * goalSummaries / resolvePhase) never write phase.txt. Once phase.txt exists
 * the ONLY writer is setMachinePhase (the owner-driven gate): no content ever
 * changes the phase again.
 */
function ensureActiveGoalDir(cwd: string, goal: string): string {
	validateGoalSlug(goal);
	const goalDir = activeGoalDir(cwd, goal);
	const fresh = !existsSync(goalDir);
	if (fresh) {
		const doneDir = doneGoalDir(cwd, goal);
		if (existsSync(doneDir)) {
			mkdirSync(storeRoot(cwd), { recursive: true, mode: STORE_DIR_MODE });
			renameSync(doneDir, goalDir);
		}
	}
	mkdirSync(goalDir, { recursive: true, mode: STORE_DIR_MODE });
	if (!existsSync(phaseTxtPath(cwd, goal))) {
		writeFileSync(phaseTxtPath(cwd, goal), "discovery\n", "utf8");
	}
	writeFileSync(activePointerPath(cwd), `${goal}\n`, "utf8");
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
/** A `phase:` line from legacy plans — stripped on save (machine-owned today). */
const PHASE_LINE = /^phase:\s*\w+\s*$/gm;

/** Strip a model-supplied `phase:` line. Legacy plans may carry one; the phase
 * is machine-managed today (phase.txt), so any echoed marker is dropped. */
function stripPhaseLine(content: string): string {
	return content.replace(PHASE_LINE, "").replace(/^\n+/, "");
}

/** Read the machine-managed phase for a goal (undefined when never set). Raw
 * file content is validated through toPhase; unknown/garbage content returns
 * undefined. */
export function readMachinePhase(cwd: string, goal: string): Phase | undefined {
	try {
		const raw = readFileSync(phaseTxtPath(cwd, goal), "utf8").trim();
		return toPhase(raw);
	} catch {
		return undefined;
	}
}

/** True for every phase except "execute" — the abandon-on-exit trigger (index.ts's
 * `set()`) fires only while a goal is still mid-planning; Gate 2's release
 * transitions to "execute" before it calls `set(false)`, so that toggle is
 * excluded automatically. */
export function isPlanningPhase(phase: Phase): boolean {
	return phase !== "execute";
}

/** Set (or migrate) the machine-managed phase for a goal — the ONLY writer of
 * the phase marker. Never touches plan.md content: the marker stays in a
 * machine-only file the model cannot read or write. */
export function setMachinePhase(cwd: string, goal: string, phase: Phase): void {
	validateGoalSlug(goal);
	if (!PHASES.includes(phase)) throw new PlanStoreValidationError(`invalid phase "${phase}"`);
	ensureActiveGoalDir(cwd, goal);
	writeFileSync(phaseTxtPath(cwd, goal), `${phase}\n`, "utf8");
}

/** Raw plan markdown for a goal ("" when absent). Used for phase-gate snapshot
 * assembly; returns CONTENT, never paths. */
export function readPlan(cwd: string, goal: string): string {
	return readOptional(join(activeGoalDir(cwd, goal), "plan.md"));
}

/** Per-line date prefix appendJournal stamps on every non-empty journal line
 * (`YYYY-MM-DD <content>`) — stripped before checking for a `[→ <to>] ` marker. */
const JOURNAL_DATE_PREFIX = /^\d{4}-\d{2}-\d{2} /;

/** Non-empty journal lines added since the CURRENT phase started, derived
 * purely from journal.md content (0 when the journal is absent). transitionPhase
 * (index.ts) journals a UNIFORM `[→ <to>] ` marker line on every phase change —
 * this scans for the LAST such marker (after stripping the per-line date
 * prefix appendJournal stamps on write) and counts the non-empty lines after
 * it. A goal that has never transitioned yet (no marker found, e.g. still in
 * its entry phase) counts the whole file. Restart-proof and goal-scoped by
 * construction: a pure read of the goal's own journal.md, no in-memory
 * baseline to lose on a guard off/on cycle or leak across goals. */
export function journalEntriesSincePhaseStart(cwd: string, goal: string): number {
	const lines = readOptional(join(activeGoalDir(cwd, goal), "journal.md"))
		.split("\n")
		.filter((line) => line.trim().length > 0);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].replace(JOURNAL_DATE_PREFIX, "").startsWith("[→ ")) {
			return lines.length - i - 1;
		}
	}
	return lines.length;
}

/** Path of the machine phase marker. Exposed as a pure helper; callers must not
 * surface it to the model. */
export function phaseTxtPath(cwd: string, goal: string): string {
	return join(activeGoalDir(cwd, goal), "phase.txt");
}

/** Path of the confirmed-objective marker. Exposed as a pure helper; callers
 * must not surface it to the model. */
function intentPath(cwd: string, goal: string): string {
	return join(activeGoalDir(cwd, goal), "intent.txt");
}

/**
 * Confirm the owner-backed objective for a goal: validates the slug, then
 * sanitizes the statement to a SINGLE line — runs of whitespace (including
 * newlines) collapse to one space first, then any remaining C0/DEL/C1 control
 * byte (e.g. an ANSI escape) is stripped outright — before the result is
 * trimmed. intent.txt is line-parsed the same way as the abandon tombstone,
 * and the statement is echoed verbatim into journal.md and the plan panel, so
 * neither raw newlines nor control bytes may survive (documented risk: any
 * original multi-line formatting is lost by design, not a bug). Throws
 * PlanStoreValidationError when the sanitized statement is empty, or when it
 * exceeds OBJECTIVE_MAX_LEN — the objective is the WHAT, not the HOW; over the
 * cap the caller must distill rather than pad. Writes
 * `<statement>\n<epoch-ms>\n` to intent.txt via the same ensureActiveGoalDir
 * choke point every other write path uses (pins discovery + refreshes the
 * active.txt pointer), then journals "intent confirmed: <statement>".
 * Re-confirming an existing intent is a plain overwrite plus another journal
 * line — this IS the re-confirmation mechanism for post-confirm refinement,
 * not an error.
 */
export function confirmIntent(cwd: string, goal: string, statement: string): void {
	validateGoalSlug(goal);
	const sanitized = statement.replace(/\s+/g, " ").replace(CONTROL_CHARS, "").trim();
	if (!sanitized) {
		throw new PlanStoreValidationError(`empty objective statement — restate the owner's objective before confirming it via plan_intent`);
	}
	if (sanitized.length > OBJECTIVE_MAX_LEN) {
		throw new PlanStoreValidationError(
			`objective too long — distill it: WHAT the owner wants and the essential constraints, not HOW (implementation choices belong to the HLD)`,
		);
	}
	ensureActiveGoalDir(cwd, goal);
	writeFileSync(intentPath(cwd, goal), `${sanitized}\n${Date.now()}\n`, "utf8");
	appendJournal(cwd, goal, `intent confirmed: ${sanitized}`);
}

/** Parse a `<label>\n<epoch-ms>\n` stamped file's raw content into
 * `{label, at}`, or null on a missing/unparsable file (empty first line or a
 * non-numeric second line). Shared by parseIntent (intent.txt, label = the
 * confirmed statement) and readTombstone (abandoned.txt, label = the
 * tombstoned goal) — same on-disk shape, different field name at the call
 * site. */
function parseStamped(raw: string): { label: string; at: number } | null {
	if (!raw.trim()) return null;
	const [firstLine, atLine] = raw.split("\n");
	const label = (firstLine ?? "").trim();
	const at = Number((atLine ?? "").trim());
	if (!label || !Number.isFinite(at)) return null;
	return { label, at };
}

/** Parse intent.txt's raw content, same shape as readTombstone. Shared by
 * readIntent and recall's done-goal lookup (which reads from done/<goal>/,
 * outside the active-goal path). */
function parseIntent(raw: string): { statement: string; at: number } | null {
	const parsed = parseStamped(raw);
	return parsed ? { statement: parsed.label, at: parsed.at } : null;
}

/** Parsed content of a confirmed objective (intent.txt), or null when absent
 * or unparsable. Pure read. */
export function readIntent(cwd: string, goal: string): { statement: string; at: number } | null {
	return parseIntent(readOptional(intentPath(cwd, goal)));
}

/** F1: same as readIntent, but also checks the ARCHIVED position (done/<goal>/
 * intent.txt) when the goal has no active intent.txt. completeGoal moves a
 * goal's whole directory (intent.txt included) to done/ on completion, and
 * ensureActiveGoalDir moves it wholesale back to active on reopen — so this
 * is only needed for the brief window savePlan's pre-write gate runs in,
 * BEFORE its own ensureActiveGoalDir call reopens a completed goal. Used
 * exclusively by savePlan's gate so a completed goal's already-confirmed
 * objective still satisfies it instead of wrongly refusing the reopen. */
function readIntentEitherPosition(cwd: string, goal: string): { statement: string; at: number } | null {
	return readIntent(cwd, goal) ?? parseIntent(readOptional(join(doneGoalDir(cwd, goal), "intent.txt")));
}

export function savePlan(cwd: string, goal: string, content: string): string {
	validateGoalSlug(goal);
	// Read-only check (readIntentEitherPosition never writes): a save with no
	// confirmed objective — active OR archived (F1: a completed goal's
	// intent.txt lives in done/<goal>/ until ensureActiveGoalDir reopens it
	// further down) — is rejected before any disk write, so the "rejected
	// save creates nothing" invariant holds — plan.md must never exist
	// without a confirmed intent.txt next to it.
	if (!readIntentEitherPosition(cwd, goal)) {
		throw new PlanStoreValidationError(
			`plan_save rejected for "${goal}" — no confirmed objective yet: restate the owner's objective and confirm it via plan_intent first`,
		);
	}
	// The phase is machine-managed (phase.txt) — strip any line the model echoes
	// and validate the DAG server-side. Phase transitions only happen via the
	// form-driven gate (setMachinePhase), never through plan content.
	const stripped = stripPhaseLine(content);
	// Shape-validate BEFORE touching disk: a rejected first save must create no
	// goal dir, no phase.txt, no active.txt pointer — so the phase lookup here
	// is read-only (ensureActiveGoalDir hasn't run yet); brand-new goals default
	// to discovery, matching the pin ensureActiveGoalDir applies on first write.
	const phase = readMachinePhase(cwd, goal) ?? "discovery";
	const issues = validatePhaseShape(phase, stripped);
	if (issues.length) throw new PlanStoreValidationError(shapeErrorMessage(phase, issues), issues);
	let finalContent = stripped;
	const tasks = parseTasks(stripped);
	if (tasks.length > 0) {
		const issues = validateTaskGraph(tasks);
		if (issues.length > 0) throw new PlanStoreValidationError(validationErrorMessage(issues));
		finalContent = applyWavesSection(stripped, buildWavesSection(tasks, computeLayers(tasks)!));
	}
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
 * With query: case-insensitive match against the confirmed intent + plan.md +
 * journal.md; matched goals include their confirmed intent (when set), the
 * full plan.md and the last ~20 journal lines.
 * Always returns content, never bare paths.
 */
export function recall(cwd: string, query?: string): string {
	const root = storeRoot(cwd);
	const needle = (query ?? "").toLowerCase().trim();
	// `done` is the completion bucket, not a goal: never list it as active.
	const active = listGoalDirs(root).filter((name) => name !== "done");
	const doneRoot = join(root, "done");
	const done = listGoalDirs(doneRoot);

	const sections: string[] = [];
	const activeHeading = active.length ? `Active goals:\n${active.map((g) => `- ${g}`).join("\n")}` : "Active goals: none";
	sections.push(activeHeading);
	const doneHeading = done.length ? `Done goals:\n${done.map((g) => `- ${g}`).join("\n")}` : "Done goals: none";
	sections.push(doneHeading);

	// Single unified list — active entries first (sorted), then done entries
	// (sorted), each carrying its own dir + display tag; the two branches
	// below iterate it once instead of duplicating themselves per bucket.
	const goals = [
		...active.map((goal) => ({ goal, dir: join(root, goal), tag: "(active)" })),
		...done.map((goal) => ({ goal, dir: join(doneRoot, goal), tag: "(done)" })),
	];

	if (needle === "") {
		for (const { goal, dir } of goals) {
			const plan = readOptional(join(dir, "plan.md"));
			sections.push(`\n- ${goal}: ${planHeadline(plan, goal)}`);
		}
		return sections.join("\n");
	}

	const hits: string[] = [];
	for (const { goal, dir, tag } of goals) {
		const plan = readOptional(join(dir, "plan.md"));
		const journal = readOptional(join(dir, "journal.md"));
		const intent = parseIntent(readOptional(join(dir, "intent.txt")))?.statement ?? "";
		if ((intent + "\n" + plan + "\n" + journal).toLowerCase().includes(needle)) {
			const intentBlock = intent ? `\n### intent\n${intent}\n` : "";
			hits.push(`\n## ${goal} ${tag}\n${intentBlock}\n### plan.md\n${plan}\n\n### journal.md (last ${JOURNAL_TAIL} lines)\n${journalTail(journal)}`);
		}
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
	validateGoalSlug(goal);
	const goalDir = activeGoalDir(cwd, goal);
	if (!existsSync(goalDir)) return false;
	const doneDir = doneGoalDir(cwd, goal);
	mkdirSync(join(storeRoot(cwd), "done"), { recursive: true, mode: STORE_DIR_MODE });
	renameSync(goalDir, doneDir);
	// Only clear the pointer when it named THIS goal — a stray completeGoal
	// call for a goal that isn't the last-touched one must not blank it out.
	if (readActivePointer(cwd) === goal) {
		rmSync(activePointerPath(cwd), { force: true });
	}
	return true;
}

/**
 * Tombstone the currently-pointed active goal for the abandon-grace window:
 * writes abandoned.txt (`<goal>\n<epoch-ms>\n`) FIRST, then removes
 * active.txt — the pointer stops resolving immediately (currentPhase → null)
 * while the goal dir itself is left untouched for the grace period. Returns
 * the tombstoned goal, or null when active.txt is absent or names a goal
 * whose directory no longer exists (nothing to tombstone).
 */
export function tombstoneActiveGoal(cwd: string): string | null {
	const goal = readActivePointer(cwd);
	if (!goal || !existsSync(activeGoalDir(cwd, goal))) return null;
	writeFileSync(tombstonePath(cwd), `${goal}\n${Date.now()}\n`, "utf8");
	rmSync(activePointerPath(cwd), { force: true });
	return goal;
}

/**
 * Reverse a pending tombstone within its grace window: restores active.txt to
 * the tombstoned goal, but ONLY when active.txt is currently absent — it
 * must never clobber a pointer plan_exit (or any other write) has since
 * re-created. The tombstone file is always removed. The tombstoned slug is
 * validated the same way purgeTombstone validates it before ever touching a
 * goal dir (GOAL_PATTERN + not "done") — a corrupt/invalid slug is never
 * written into active.txt; the tombstone is simply dropped and null
 * returned. Returns the goal the tombstone named (restored-or-kept), or
 * null when there was no tombstone or its slug failed validation.
 */
export function restoreTombstonedGoal(cwd: string): string | null {
	const tomb = readTombstone(cwd);
	if (!tomb) return null;
	if (!GOAL_PATTERN.test(tomb.goal) || tomb.goal === "done") {
		rmSync(tombstonePath(cwd), { force: true });
		return null;
	}
	if (!existsSync(activePointerPath(cwd))) {
		writeFileSync(activePointerPath(cwd), `${tomb.goal}\n`, "utf8");
	}
	rmSync(tombstonePath(cwd), { force: true });
	return tomb.goal;
}

/**
 * Resolve a pending tombstone by discarding the goal for good: removes the
 * goal directory (rm -rf), the tombstone, and the pointer if it still names
 * the same goal. Partial-state rule: if active.txt has since been re-pinned
 * to the SAME goal (e.g. a re-save during the grace window), the goal is
 * kept FOR THIS CALL — only the stale tombstone is removed, and null is
 * returned so the caller knows nothing was discarded here. That guarantee is
 * local to the grace-timer fire path (scheduleAbandon's callback, where the
 * window's elapsed real time is the only thing that could have raced a
 * re-save): sweepStaleGoal's fresh-activation sweep (index.ts) calls this
 * first to clear a leftover tombstone, then — if the pointer is still
 * sitting in a planning phase — immediately re-tombstones and purges the
 * SAME goal again, discarding it after all. A "kept" return from this
 * function is therefore not a standing promise that the goal survives the
 * whole sweep, only this one call. The removal path is built exclusively
 * from the store root + the tombstoned goal slug (never from arbitrary
 * input); a tombstone whose goal fails the kebab-case slug pattern is
 * treated as corrupt and only the tombstone file itself is cleared — same
 * for a tombstone file that exists but is unparsable (see readTombstone):
 * the garbage file is removed rather than left to linger forever, and no
 * goal dir is ever touched in that case. Returns the purged goal, or null
 * when nothing was purged.
 */
export function purgeTombstone(cwd: string): string | null {
	const tomb = readTombstone(cwd);
	if (!tomb) {
		if (existsSync(tombstonePath(cwd))) rmSync(tombstonePath(cwd), { force: true });
		return null;
	}
	const { goal } = tomb;
	if (readActivePointer(cwd) === goal) {
		rmSync(tombstonePath(cwd), { force: true });
		return null;
	}
	if (GOAL_PATTERN.test(goal) && goal !== "done") {
		rmSync(activeGoalDir(cwd, goal), { recursive: true, force: true });
	}
	rmSync(tombstonePath(cwd), { force: true });
	if (readActivePointer(cwd) === goal) rmSync(activePointerPath(cwd), { force: true });
	return goal;
}

/** Parsed content of a pending tombstone (abandoned.txt), or null when absent
 * or unparsable. */
export function readTombstone(cwd: string): { goal: string; at: number } | null {
	const parsed = parseStamped(readOptional(tombstonePath(cwd)));
	return parsed ? { goal: parsed.label, at: parsed.at } : null;
}

/**
 * Pure phase resolution for read paths (currentPhase, goalSummaries, ...):
 * the machine-managed phase.txt always wins — even with the guard off or
 * re-engaged, which is what keeps a goal re-guarded mid-execute staying in
 * execute. A goal with no phase.txt yet falls back to discovery (the entry
 * phase — ensureActiveGoalDir pins every write-touched goal to phase.txt
 * immediately, so this is only a transient pre-write default). Never writes
 * to disk; write-path pinning lives in ensureActiveGoalDir instead.
 */
function resolvePhase(cwd: string, goal: string): Phase {
	return readMachinePhase(cwd, goal) ?? "discovery";
}

/** One summary line per active goal: phase, progress, ready frontier (widget/dialog). */
export function goalSummaries(cwd: string): string[] {
	const root = storeRoot(cwd);
	const lines: string[] = [];
	for (const name of listGoalDirs(root)) {
		if (name === "done") continue;
		const content = readOptional(join(root, name, "plan.md"));
		const phase = resolvePhase(cwd, name);
		const tasks = parseTasks(content);
		if (tasks.length === 0) {
			lines.push(`${name} [${phase}] (no tasks yet)`);
			continue;
		}
		const done = tasks.filter((t) => t.done).length;
		const ready = readyFrontier(tasks).map((t) => t.id).join(", ");
		lines.push(`${name} [${phase}] ${done}/${tasks.length} done · ready: ${ready || "—"}`);
	}
	return lines;
}

/** Active goal driving per-turn prompt injection. Pointer-only: resolves
 * active.txt (last goal touched by a write) when it still names a live goal
 * (plan.md or phase.txt on disk); returns null otherwise — no pointer, or a
 * pointer naming a goal with neither file (e.g. purged, or the pointer was
 * just removed for a pending abandon tombstone). There is no fallback scan:
 * active.txt is the only resume path (0.10.0 was never published, so there
 * are no pre-pointer sessions to support), and inert orphan goal dirs are
 * still listed elsewhere (goalSummaries / plan_recall / plan_exit's dialog). */
export function currentPhase(cwd: string): { goal: string; phase: Phase } | null {
	const pointer = readActivePointer(cwd);
	if (!pointer) return null;
	const planPath = join(activeGoalDir(cwd, pointer), "plan.md");
	if (!existsSync(planPath) && !existsSync(phaseTxtPath(cwd, pointer))) return null;
	return { goal: pointer, phase: resolvePhase(cwd, pointer) };
}

/** Read a goal's plan.md, throwing the standard "no active plan" error when
 * it's empty/absent. Shared by every read path that must hard-refuse before
 * proceeding without one: nextTasks, updateTaskStatus, persistApproved and
 * getDoD. */
function requirePlan(cwd: string, goal: string): string {
	const content = readPlan(cwd, goal);
	if (!content) {
		throw new PlanStoreValidationError(`no active plan for goal "${goal}" — save one first via plan_save`);
	}
	return content;
}

/**
 * Mechanically computed ready frontier for a goal: pending tasks whose deps
 * are all done. Returns CONTENT (never paths); throws when no plan exists.
 */
export function nextTasks(cwd: string, goal: string): string {
	validateGoalSlug(goal);
	const content = requirePlan(cwd, goal);
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

/** Raw non-empty `git status --porcelain` lines for cwd, or null outside a
 * git worktree or when git fails. Shared by gitDirtyFiles and gitStagedFiles
 * — they run the identical command and differ only in how they turn a
 * porcelain line into their own return shape. */
function gitPorcelainLines(cwd: string): string[] | null {
	try {
		if (!existsSync(join(cwd, ".git"))) return null;
		const out = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").filter((line) => line.trim().length > 0);
	} catch {
		return null;
	}
}

/** Dirty files (modified + untracked, renames split) relative to repo root.
 * Returns null outside a git worktree or when git fails — callers degrade to
 * the weaker all-owns check. */
function gitDirtyFiles(cwd: string): string[] | null {
	const lines = gitPorcelainLines(cwd);
	if (lines === null) return null;
	return lines.flatMap((line) => line.slice(3).trim().replace(/^"|"$/g, "").split(" -> "));
}

/** Staged files (index differs from HEAD) relative to repo root — the SAME
 * line[0] !== " " && line[0] !== "?" criterion pi-subagents' worker
 * acceptance uses to detect pre-existing staged files, which otherwise makes
 * it reject EVERY write-worker outright. Robust to non-git dirs (returns
 * []; gitDirtyFiles returns null for the same case — this one returns []
 * since callers here never need to distinguish "no git" from "no staged
 * files"). */
export function gitStagedFiles(cwd: string): { code: string; path: string }[] {
	const lines = gitPorcelainLines(cwd);
	if (lines === null) return [];
	return lines
		.filter((line) => line[0] !== " " && line[0] !== "?")
		.map((line) => ({ code: line.slice(0, 2), path: line.slice(3).trim().replace(/^"|"$/g, "") }));
}

/** True when BOTH porcelain columns are non-space (e.g. "MM", "AM") — the
 * index differs from the worktree, so unstaging keeps the worktree content
 * but drops the staged/unstaged split. */
export function isPartiallyStaged(code: string): boolean {
	return code.length === 2 && code[0] !== " " && code[1] !== " ";
}

/** Path of the per-goal claim-baseline store: taskId → dirty files present in
 * the worktree at that task's FIRST claim (in_progress). Lives inside the
 * goal dir next to plan.md/phase.txt (same 0700 dir), so an abandon purge
 * (which rm -rf's the whole goal dir) removes it for free — no separate
 * cleanup path needed. */
function claimsPath(cwd: string, goal: string): string {
	return join(activeGoalDir(cwd, goal), "claims.json");
}

/** Parsed claims.json ({} when the file is missing, unreadable, or not a JSON
 * object) — robust to a missing file by construction: a task's first claim
 * always starts from an empty/absent map and creates its own entry. */
function readClaims(cwd: string, goal: string): Record<string, string[]> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(claimsPath(cwd, goal), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {};
	} catch {
		return {};
	}
}

function writeClaims(cwd: string, goal: string, claims: Record<string, string[]>): void {
	writeFileSync(claimsPath(cwd, goal), JSON.stringify(claims), "utf8");
}

/**
 * Set a task's status server-side.
 *
 * Claiming (in_progress) captures a dirty-file baseline ONLY on the task's
 * FIRST claim, persisted per-task in <goal>/claims.json (same store patterns
 * as phase.txt/intent.txt). A RE-claim of a task that is already in_progress
 * — including a retry right after a rejected close — reuses that baseline
 * verbatim and never overwrites it. This closes a field-found hole where
 * re-claiming silently folded every already-dirty file into a brand-new
 * baseline, making the very next close's delta empty and the owns-check
 * vacuous (claim → fail → re-claim → done always passed).
 *
 * Closing (done) verifies that every file changed SINCE the baseline (or
 * every dirty file, for a task closed without ever being claimed) falls
 * inside SOME task's declared owns — the closing task's own owns OR any
 * OTHER task's owns in the same plan. Tasks claimed together in the same
 * wave share one git worktree, so a sibling's in-flight edits are
 * indistinguishable from "outside the plan" by file path alone; they are
 * still accounted for by the plan (their own owns), so only files outside
 * EVERY task's owns are flagged. A rejected close leaves the baseline
 * untouched, so a retry after fixing the files still diffs from the
 * ORIGINAL claim point, never a freshly-reset one. The baseline entry is
 * cleared only once the task is actually closed (done) successfully — a
 * later re-claim (reopening an already-done task) starts a fresh baseline,
 * same as an unclaimed task's first claim. Every dependency must already be
 * done before a close is accepted.
 *
 * The checkbox is flipped surgically — the rest of the plan is never
 * touched. Transitions are journaled.
 */
export function updateTaskStatus(cwd: string, goal: string, taskId: string, status: string): string {
	validateGoalSlug(goal);
	if (!(status === "pending" || status === "in_progress" || status === "blocked" || status === "done")) {
		throw new PlanStoreValidationError(`invalid status "${status}" — use pending | in_progress | blocked | done`);
	}
	const planPath = join(activeGoalDir(cwd, goal), "plan.md");
	const content = requirePlan(cwd, goal);
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
			const base = readClaims(cwd, goal)[taskId];
			const scope = base ? dirty.filter((file) => !base.includes(file)) : dirty;
			const allOwns = tasks.flatMap((t) => t.owns);
			const violations = scope.filter((file) => !ownsCovers(file, allOwns));
			if (violations.length > 0) {
				appendJournal(cwd, goal, `task ${taskId} DONE REJECTED — files outside owns: ${violations.join(", ")}`);
				throw new PlanStoreValidationError(
					`task ${taskId}: changed files outside every task's owns [${allOwns.join(", ")}]: ${violations.join(", ")} — fix or escalate to the owner`,
				);
			}
		}
	}

	const updated = flipCheckbox(content, taskId, status === "done");
	if (updated === null) throw new PlanStoreValidationError(`task line for "${taskId}" not found in the plan`);
	writeFileSync(planPath, updated, "utf8");

	if (status === "in_progress") {
		const claims = readClaims(cwd, goal);
		if (!(taskId in claims)) {
			claims[taskId] = gitDirtyFiles(cwd) ?? [];
			writeClaims(cwd, goal, claims);
		}
	} else if (status === "done") {
		const claims = readClaims(cwd, goal);
		if (taskId in claims) {
			delete claims[taskId];
			writeClaims(cwd, goal, claims);
		}
		appendJournal(cwd, goal, `task ${taskId} closed (owns verified)`);
	}
	return `Task ${taskId} → ${status}${status === "done" ? " (owns + deps verified)" : ""}.`;
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
	intent: string;
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
	const content = readPlan(cwd, goal);
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
	const firstLine = (name: string) => sectionText(content, name).split("\n")[0] ?? "";
	return {
		goal,
		intent: readIntent(cwd, goal)?.statement ?? "",
		scope: firstLine("Scope"),
		nonGoals: sectionText(content, "Non-goals").split("\n").join(" · "),
		dod: parseDoD(content),
		hld: sectionText(content, "HLD"),
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
 * ephemeral working store). Called only after Gate 2 (owner validated the
 * contract). Returns the destination path — internal use only.
 */
export function persistApproved(cwd: string, goal: string): string {
	validateGoalSlug(goal);
	const content = requirePlan(cwd, goal);
	const destDir = join(approvedRoot(), repoSlug(cwd), goal);
	mkdirSync(destDir, { recursive: true });
	const dest = join(destDir, "plan.md");
	writeFileSync(dest, content, "utf8");
	appendJournal(cwd, goal, "plan APPROVED by owner and persisted durably");
	return dest;
}

/** Names of ACTIVE goals already approved in the durable store (no re-confirm). */
export function approvedGoals(cwd: string): string[] {
	const approved = join(approvedRoot(), repoSlug(cwd));
	const goals: string[] = [];
	for (const name of listGoalDirs(storeRoot(cwd))) {
		if (name !== "done" && existsSync(join(approved, name))) goals.push(name);
	}
	return goals;
}

/** Executable DoD commands of a goal's plan (mechanical delivery gate). */
export function getDoD(cwd: string, goal: string): string[] {
	return parseDoD(requirePlan(cwd, goal));
}
