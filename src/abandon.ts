/**
 * In-process abandon-grace timer for plan-mode toggle-off.
 *
 * When plan mode is switched off mid-planning, index.ts tombstones the
 * active goal (src/plan-store.ts's tombstoneActiveGoal) and arms a short
 * grace window here before the goal is purged for good. Re-engaging plan
 * mode within the window cancels the pending purge and restores the
 * pointer; letting the timer lapse fires the purge instead. Every handle is
 * unref()'d so a pending abandon never keeps the process alive on its own.
 * Handles are keyed by cwd — a single Map holds at most one pending timer
 * per repo, mirroring that repo's single active.txt pointer, but distinct
 * cwds never interfere with each other's schedule/cancel/fire. Pure: no
 * filesystem access, no imports beyond the ambient timer globals.
 */

export const DEFAULT_ABANDON_GRACE_MS = 10_000;

let graceMs = DEFAULT_ABANDON_GRACE_MS;
const handles = new Map<string, ReturnType<typeof setTimeout>>();

/** Test-only override of the grace window (default: DEFAULT_ABANDON_GRACE_MS). */
export function setAbandonGraceMs(ms: number): void {
	graceMs = ms;
}

/** The current effective grace window, in ms (post any setAbandonGraceMs override). */
export function getAbandonGraceMs(): number {
	return graceMs;
}

/** Arm the abandon timer for this cwd, replacing any prior pending one for
 * the SAME cwd — only the most recently toggled-off goal in a given repo can
 * be pending at a time. Other cwds' pending timers are untouched. */
export function scheduleAbandon(cwd: string, fire: () => void): void {
	const prior = handles.get(cwd);
	if (prior) clearTimeout(prior);
	const handle = setTimeout(() => {
		handles.delete(cwd);
		fire();
	}, graceMs);
	handle.unref();
	handles.set(cwd, handle);
}

/** Cancel a pending abandon for this cwd, if any. Returns true when one was
 * cleared; other cwds' pending timers are untouched either way. */
export function cancelAbandon(cwd: string): boolean {
	const handle = handles.get(cwd);
	if (!handle) return false;
	clearTimeout(handle);
	handles.delete(cwd);
	return true;
}

/** True while a purge is armed and waiting out its grace window for this cwd. */
export function hasPendingAbandon(cwd: string): boolean {
	return handles.has(cwd);
}
