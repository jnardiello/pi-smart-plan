/**
 * Read-only bash classifier for plan mode.
 *
 * Allowlist semantics: a command is read-only ONLY if it matches a known
 * read-only pattern AND no destructive pattern matches anywhere in the
 * string. Anything unknown (interpreters, script runners, uncategorized
 * binaries) is therefore blocked — conservative by design.
 *
 * Adapted from the official pi plan-mode example (examples/extensions/plan-mode),
 * with these tightenings:
 * - `find -delete / -exec / -fprint*` treated as destructive;
 * - `sed -i` treated as destructive;
 * - curl output/upload/verb flags (-o, -O, --output, --remote-name, --upload,
 *   -T, -X POST/PUT/DELETE/PATCH) treated as destructive;
 * - harmless noise redirects (2>&1, >/dev/null, 2>/dev/null) stripped before
 *   matching so common read pipelines keep working;
 * - compound lines (`&&`, `||`, `;`, `|`) are split quote-aware and EVERY
 *   segment must be allowlisted — a safe first segment no longer promotes the
 *   rest of the line (closes the `echo x && ./evil` bypass), and `cd <path>`
 *   segments plus transparent wrappers (timeout/command/env) are peeled first;
 * - `find -ok / -okdir` (interactive exec — same class as -exec) treated as
 *   destructive alongside -delete/-exec/-execdir/-fprint*;
 * - awk/sed/sort are allowlisted by command NAME only, so each is additionally
 *   vetted at the point its SAFE_PATTERN matches (see INTERPRETER_GUARDS):
 *   awk `system(...)`, a `|` (pipe to/from a command), or `>`/`>>` (print
 *   redirect) inside the program; sed GNU `w`/`W` (write) or `e` (exec)
 *   commands inside the script; sort `-o`/`--output` (in-place overwrite) —
 *   any hit blocks the whole segment, conservative by design.
 */

/** Destructive patterns — tested against the WHOLE command string, so they
 * catch destructive fragments hidden in compounds and pipelines. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // single redirect (>> handled below; 2>&1 stripped earlier)
	/>>/,
	/\bfind\b[^|;&]*\s-(delete|exec|execdir|okdir|ok|fprint\w*)\b/i,
	/\bsed\b[^|;&]*\s-i\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|unlink|publish|pack|exec|init)/i,
	/\byarn\s+(add|remove|install|publish|up)/i,
	/\bpnpm\s+(add|remove|install|publish|update)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|fetch|merge|rebase|reset|restore|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean|gc|apply|am|worktree|bisect|rm|mv|branch\s+-[dD])/i,
	// curl output/upload/verb flags — scoped to curl so wget -O - (stdout) stays
	// readable; any wget use outside the narrow SAFE form is blocked anyway by
	// allowlist semantics.
	/\bcurl\b[^|;&]*\s-o(\s|=)/i,
	/\bcurl\b[^|;&]*\s-O(\s|$)/,
	/\bcurl\b[^|;&]*(--output|--remote-name|--upload)/,
	/\bcurl\b[^|;&]*\s-T(\s|$)/i,
	/\bcurl\b[^|;&]*-X\s*(POST|PUT|DELETE|PATCH)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

/** Read-only patterns — anchored at command start (allowlist). */
const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|blame|rev-parse|describe|shortlog|reflog|ls-files|ls-remote|config\s+--get|config\s+--list)/i,
	/^\s*npm\s+(ls|list|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+(--version|-v)\b/i,
	/^\s*python3?\s+(--version|-V)\b/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-\s/i, // wget to stdout only
];

/** Per-interpreter extra vetting for SAFE_PATTERNS entries that allowlist a
 * command by NAME only (awk/sed/sort): the write/exec primitive can hide in
 * the (often single-quoted) program or flag text that neither
 * DESTRUCTIVE_PATTERNS nor the bare command-name allowlist ever separately
 * inspects. Each `dangerous` check runs ONLY on a segment whose own `safe`
 * pattern already matched, against that segment's cleaned text (post
 * wrapper-stripping) — so every heuristic below is deliberately
 * conservative: when a construct could be either a real command or an
 * innocent regex/argument, it blocks.
 *
 * - awk: `system(...)` execs a shell; `|` pipes `print`/`getline` to or from
 *   a command string; `>`/`>>` redirects `print` output to a file. Any `|`
 *   anywhere in the program blocks the segment — including inside a regex
 *   alternation like `/foo|bar/` — because a top-level pipe would already
 *   have been split into its own segment by splitSegments, so a `|` surviving
 *   inside one segment can only be quoted awk-program text, and we cannot
 *   distinguish "pipe to a command" from "regex alternation" without a real
 *   awk parser.
 * - sed (only `sed -n ...` is ever allowlisted): GNU `w`/`W` writes the
 *   matched/pattern-space text to a file, `e` execs a shell command. A real
 *   sed parser would require the letter to sit at a command position (after
 *   `;`, a newline, an address, or script-start) to avoid flagging a regex
 *   address that merely contains the letter (e.g. `/we/p`). We don't have
 *   one, so — conservative-deny — this instead blocks any `w`/`W`/`e`
 *   immediately followed by whitespace and another token, i.e. "looks like a
 *   command with an argument". This can over-block an address regex that
 *   happens to contain that shape (e.g. `/some error/p`) — accepted, per
 *   this file's block-when-unsure design.
 * - sort: `-o`/`--output` overwrites a file in place (the `sort -o f f` PoC
 *   overwrites its own input). `o` is not shared with any other sort short
 *   flag, so any `-`-prefixed cluster containing `o` is treated as `-o`. */
const INTERPRETER_GUARDS: { safe: RegExp; dangerous: (segment: string) => boolean }[] = [
	{ safe: /^\s*awk\b/, dangerous: (s) => /\bsystem\s*\(/.test(s) || /\|/.test(s) || /(^|[^<])>(?!>)/.test(s) || />>/.test(s) },
	{ safe: /^\s*sed\s+-n/i, dangerous: (s) => /[wWe]\s+\S/.test(s) },
	{ safe: /^\s*sort\b/, dangerous: (s) => /(^|\s)-[a-zA-Z]*o/.test(s) || /--output\b/.test(s) },
];

/** Strip harmless noise redirects so common read pipelines keep passing
 * (tolerant of optional whitespace around the redirect). */
function normalize(command: string): string {
	return command
		.replaceAll(/\s*2>&1/g, "")
		.replaceAll(/\s*2>\s*\/dev\/null/g, "")
		.replaceAll(/\s*>\s*\/dev\/null/g, "");
}

/** Split a command line into `&&`/`||`/`;`/`|` segments, never splitting inside
 * single or double quotes (minimal char-by-char splitter, no full bash parser).
 * Returns `null` when the command contains `$(` or a backtick outside single
 * quotes — command substitution we cannot analyze, so the caller blocks the
 * whole line conservatively. */
function splitSegments(command: string): string[] | null {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (inSingle) { if (ch === "'") inSingle = false; current += ch; continue; }
		if (inDouble) {
			if ((ch === "$" && next === "(") || ch === "`") return null; // expands within double quotes
			if (ch === '"') inDouble = false;
			current += ch;
			continue;
		}
		if (ch === "'") { inSingle = true; current += ch; continue; }
		if (ch === '"') { inDouble = true; current += ch; continue; }
		// Outer level: a literal newline ends the command (bash reads two commands),
		// so it must split like `;`/`|` — never be absorbed into the current segment.
		if (ch === "\n" || ch === "\r") { segments.push(current); current = ""; continue; }
		if (ch === "$" && next === "(") return null; // $(...) outside quotes
		if (ch === "`") return null; // backtick command substitution
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "|") { segments.push(current); current = ""; continue; }
		current += ch;
	}
	segments.push(current);
	return segments;
}

/** Strip transparent wrapper prefixes from a segment (repeatable, so nested
 * wrappers peel left-to-right): `timeout <dur>`, `command`, and `env` followed
 * by simple `VAR=val` assignments (simple values only — anything quoting,
 * redirecting or substituting is left in place and thus fails the allowlist).
 * `xargs` is deliberately NOT transparent: it executes arbitrary arguments. */
function stripWrappers(segment: string): string {
	let rest = segment;
	for (;;) {
		const t = rest.trimStart();
		if (t === "") return rest;
		const lead = rest.slice(0, rest.length - t.length);
		const timeout = t.match(/^timeout\s+\S+\s*/);
		if (timeout) { rest = lead + t.slice(timeout[0].length); continue; }
		const command = t.match(/^command\b\s*/);
		if (command) { rest = lead + t.slice(command[0].length); continue; }
		const env = t.match(/^env\b\s*/);
		if (env) {
			rest = lead + t.slice(env[0].length);
			for (;;) {
				const s = rest.trimStart();
				const lead2 = rest.slice(0, rest.length - s.length);
				const assign = s.match(/^[A-Za-z_][A-Za-z0-9_]*=[^\s'"&<>;|()$`]*(?:\s|$)/);
				if (!assign) break;
				rest = lead2 + s.slice(assign[0].length);
			}
			continue;
		}
		return rest;
	}
}

/** True when the command may run unchanged during plan mode — every compound
 * segment must be allowlisted, not just the first one. */
export function isReadOnlyCommand(command: string): boolean {
	const normalized = normalize(command);
	// 1) Destructive patterns on the WHOLE string first — catches destructive
	//    fragments hidden inside any segment.
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	// 2) Command substitution we cannot analyze ($(...) / backticks) → block.
	const segments = splitSegments(normalized);
	if (segments === null) return false;
	// 3) EVERY segment (after peeling wrappers) must match a SAFE pattern.
	for (const segment of segments) {
		const cleaned = stripWrappers(segment);
		if (cleaned.trim() === "") continue; // empty segment → ignore
		if (/^\s*cd\b/.test(cleaned)) continue; // `cd <path>` alone is read-only
		if (!SAFE_PATTERNS.some((pattern) => pattern.test(cleaned))) return false;
		// A SAFE_PATTERN match only allowlists the command NAME — awk/sed/sort
		// still need their program/flag text vetted (see INTERPRETER_GUARDS).
		if (INTERPRETER_GUARDS.some((guard) => guard.safe.test(cleaned) && guard.dangerous(cleaned))) return false;
	}
	return true;
}
