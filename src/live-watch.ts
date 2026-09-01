/**
 * Live repaint watcher for the plan widget.
 *
 * The pi host exposes no timer/tick/idle event, and every `on(...)` event
 * fires on THIS session's own activity — so a session can never observe
 * another session's writes through the extension API. Node globals do run in
 * the extension process (src/abandon.ts already relies on that), so this
 * module stat-polls the store root on a plain setInterval instead: no fs.watch
 * (its reliability on the temp dir is unverified), no cached state in front of
 * the store, just a cheap snapshot compared tick over tick.
 *
 * What the snapshot sees: the store root's own mtime — which changes whenever
 * a goal directory is created, renamed into done/ on completion, or removed by
 * an abandon purge — the active.txt pointer's presence and stamp, and each
 * active goal's phase.txt stamp. Content rewritten in place inside another
 * session's goal (plan.md task ticks) is NOT observed; that is the deliberate
 * cost of staying at a handful of stats per tick.
 *
 * Every handle is unref()'d, so polling never keeps the process alive on its
 * own, and no path here throws: a store root that does not exist yet (no plan
 * has ever been saved for this repo) simply snapshots as empty.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** `<mtimeMs>:<size>` for a path, or "-" when it is missing/unreadable. */
function stamp(path: string): string {
	try {
		const stats = statSync(path);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "-";
	}
}

/**
 * Cheap digest of the store state any session could have changed. Equal
 * digests mean "nothing worth repainting happened"; the value itself is
 * opaque and must never be parsed or surfaced.
 */
export function storeSnapshot(root: string): string {
	if (!existsSync(root)) return "";
	const parts = [stamp(root), stamp(join(root, "active.txt"))];
	let names: string[] = [];
	try {
		names = readdirSync(root).sort();
	} catch {
		return parts.join("|");
	}
	for (const name of names) {
		if (name === "done") continue;
		parts.push(`${name}=${stamp(join(root, name, "phase.txt"))}`);
	}
	return parts.join("|");
}

/**
 * Poll `root` every `intervalMs` and call `onChange` ONLY when the snapshot
 * actually changed since the previous tick — never on the first sample, and
 * never twice for one change. A throwing `onChange` is swallowed: an
 * exception escaping a timer callback would take the whole pi process down.
 * Returns the stop function.
 */
export function startLiveWatch(root: string, onChange: () => void, intervalMs: number = DEFAULT_WATCH_INTERVAL_MS): () => void {
	let last = storeSnapshot(root);
	const handle = setInterval(() => {
		const next = storeSnapshot(root);
		if (next === last) return;
		last = next;
		try {
			onChange();
		} catch {
			// A disposed session context (shutdown racing a tick) must not crash pi.
		}
	}, intervalMs);
	handle.unref();
	return () => clearInterval(handle);
}
