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
 *   matching so common read pipelines keep working.
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
	/\bfind\b[^|;&]*\s-(delete|exec|execdir|fprint\w*)\b/i,
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

/** Strip harmless noise redirects so common read pipelines keep passing
 * (tolerant of optional whitespace around the redirect). */
function normalize(command: string): string {
	return command
		.replaceAll(/\s*2>&1/g, "")
		.replaceAll(/\s*2>\s*\/dev\/null/g, "")
		.replaceAll(/\s*>\s*\/dev\/null/g, "");
}

/** True when the command may run unchanged during plan mode. */
export function isReadOnlyCommand(command: string): boolean {
	const normalized = normalize(command);
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	return SAFE_PATTERNS.some((pattern) => pattern.test(normalized));
}
