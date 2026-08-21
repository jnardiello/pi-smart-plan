// Smoke test for pi-smart-plan — mock ExtensionAPI, real extension code.
// Run: npm test
import planGuard from "../index.ts";
import { isReadOnlyCommand } from "../src/bash-guard.ts";
import { GLOBAL_CONSTRAINTS, PHASE_PROMPTS } from "../src/prompts.ts";
import {
	savePlan,
	nextTasks,
	hasActivePlans,
	goalSummaries,
	currentPhase,
	updateTaskStatus,
	getDoD,
	PlanStoreValidationError,
} from "../src/plan-store.ts";
import { inferPhase, parsePhaseLine, PHASES } from "../src/plan-validate.ts";
import { statSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, cond) {
	if (cond) console.log(`  ok  ${name}`);
	else { failures++; console.log(`FAIL  ${name}`); }
}

const CWD = `/tmp/smart-plan-smoke/repo-${Date.now()}`;
mkdirSync(CWD, { recursive: true });
execFileSync("git", ["init"], { cwd: CWD, stdio: "ignore" });
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const expectedStore = join(tmpdir(), `pi-smart-plan-${uid}`, CWD.replaceAll("/", "-"));

// ---- mock ExtensionAPI -----------------------------------------------------
const registered = { tools: new Map(), commands: new Map(), shortcuts: new Map(), renderers: new Map(), handlers: new Map(), flags: new Map() };
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "subagent", "subagent_wait", "chrome_click", "chrome_screenshot", "web_search", "plan_exit", "plan_save", "plan_next", "plan_task_update", "plan_verify", "journal_append", "plan_recall", "plan_complete", "ask_smart_plan"];
let activeTools = [...FULL_TOOLS];
const sent = [];
const entries = [];
const notifications = [];
const widgetCalls = [];
const confirmCalls = [];
let confirmResponse = true;
let customResult = { answers: {} };
let flagValue = false;

const pi = {
	registerTool(def) { registered.tools.set(def.name, def); },
	registerCommand(name, def) { registered.commands.set(name, def); },
	registerShortcut(key, def) { registered.shortcuts.set(key, def); },
	registerMessageRenderer(type, fn) { registered.renderers.set(type, fn); },
	registerFlag(name, def) { registered.flags.set(name, def); },
	getFlag: (name) => (name === "plan" ? flagValue : undefined),
	on(event, fn) { registered.handlers.set(event, fn); },
	appendEntry(key, data) { entries.push({ key, data }); },
	sendMessage(msg, opts) { sent.push({ msg, opts }); return Promise.resolve(); },
	getActiveTools() { return [...activeTools]; },
	setActiveTools(names) { activeTools = names; },
};

function makeCtx(over = {}) {
	return {
		isIdle: () => true,
		cwd: CWD,
		hasUI: true,
		ui: {
			setStatus() {},
			setWidget(key, value) { widgetCalls.push([key, value]); },
			notify(msg, type) { notifications.push([msg, type]); },
			confirm: async (title, body) => { confirmCalls.push(body ?? title); return confirmResponse; },
			custom: async () => customResult,
			select: async () => undefined,
			editor: async () => "",
		},
		sessionManager: { getBranch: () => entries.map((e) => ({ type: "custom", customType: e.key, data: e.data })) },
		...over,
	};
}

const bashEvent = (command) => ({ toolName: "bash", input: { command } });
const toolEvent = (name) => ({ toolName: name, input: {} });
const fakeTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
function widgetLines() {
	const w = widgetCalls.at(-1)?.[1];
	if (!w) return undefined;
	if (typeof w === "function") return w(undefined, fakeTheme).render();
	return w;
}

// ---- run -------------------------------------------------------------------
planGuard(pi);

console.log("\n[registration]");
check("shift+tab shortcut registered", registered.shortcuts.has("shift+tab"));
check("ctrl+p shortcut dropped", !registered.shortcuts.has("ctrl+p"));
check("--plan flag registered", registered.flags.has("plan"));
check("no plan_enter tool (owner-only)", !registered.tools.has("plan_enter"));
for (const t of ["plan_exit", "plan_next", "plan_task_update", "plan_verify", "ask_smart_plan", "plan_save", "journal_append", "plan_recall", "plan_complete"])
	check(`tool ${t} registered`, registered.tools.has(t));
check("/plan-status command registered", registered.commands.has("plan-status"));
for (const h of ["tool_call", "before_agent_start", "session_start"])
	check(`handler ${h}`, registered.handlers.has(h));

console.log("\n[state machine prompt structure]");
check("6 phases defined", Object.keys(PHASE_PROMPTS).length === 6 && PHASES.length === 6);
check("discovery is goal-gated", PHASE_PROMPTS.discovery.includes("goal-gated") && PHASE_PROMPTS.discovery.includes("No goal stated yet? Your ONLY move is to ask"));
check("ablate is SILENT", PHASE_PROMPTS.ablate.includes("SILENT internal review") && PHASE_PROMPTS.ablate.includes("do not narrate"));
check("present: chat BEFORE approval form", PHASE_PROMPTS.present.includes("SHOW THE PLAN FIRST") && PHASE_PROMPTS.present.indexOf("SHOW THE PLAN FIRST") < PHASE_PROMPTS.present.indexOf("releasePlanGuardOnAnswer"));
check("present: human abstraction first + fusion rule", PHASE_PROMPTS.present.includes("HUMAN ABSTRACTION") && PHASE_PROMPTS.present.includes("fused small-goal gates"));
check("ablation recap recovered at presentation", PHASE_PROMPTS.present.includes("recover your ablation journal notes via plan_recall"));
check("hld revisions journaled", PHASE_PROMPTS.hld.includes("journal what changed versus the previous version"));
check("global constraints forbid self-toggling", GLOBAL_CONSTRAINTS.includes("You cannot toggle plan mode yourself"));

console.log("\n[shift+tab ON → guard + notify only, NO LLM turn]");
widgetCalls.length = 0;
sent.length = 0;
await registered.shortcuts.get("shift+tab").handler(makeCtx());
check("mutating tools removed",
	["edit", "write", "subagent", "chrome_click"].every((t) => !activeTools.includes(t)));
check("toggle sends NO message (no auto-turn)", sent.length === 0);
const wl = widgetLines();
check("widget: header + heat bar (gray start, orange end)",
	wl?.[0]?.includes("PLAN MODE") === true &&
	wl?.[1]?.includes("discovery") === true &&
	wl?.[1]?.includes("\x1b[38;5;243m") === true &&
	wl?.[1]?.includes("\x1b[38;5;214m░░\x1b[0m") === true &&
	wl?.at(-1)?.includes("tell me what you want to design together") === true);

console.log("\n[before_agent_start — progressive disclosure]");
const bas = registered.handlers.get("before_agent_start");
const injDiscovery = await bas({ systemPrompt: "BASE" }, makeCtx());
check("empty store + guard ON → discovery block", injDiscovery.systemPrompt.includes("PHASE: discovery") && injDiscovery.systemPrompt.includes("pi-smart-plan global constraints") && !injDiscovery.systemPrompt.includes("PHASE: execute"));

console.log("\n[bash allowlist while enabled]");
const tc = registered.handlers.get("tool_call");
check("rg allowed", (await tc(bashEvent("rg -n 'foo' src"), makeCtx())) === undefined);
check("redirect blocked", (await tc(bashEvent("echo pwned > /tmp/x.txt"), makeCtx()))?.block === true);
check("rm blocked", (await tc(bashEvent("rg x | rm -rf /"), makeCtx()))?.block === true);
check("npm install blocked", (await tc(bashEvent("npm install left-pad"), makeCtx()))?.block === true);
check("curl POST blocked", (await tc(bashEvent("curl -X POST https://x.dev"), makeCtx()))?.block === true);

console.log("\n[default-deny backstop]");
check("edit blocked", (await tc(toolEvent("edit"), makeCtx()))?.block === true);
check("write blocked", (await tc(toolEvent("write"), makeCtx()))?.block === true);
check("subagent spawn blocked", (await tc(toolEvent("subagent"), makeCtx()))?.block === true);
check("chrome_screenshot blocked (default-deny)", (await tc(toolEvent("chrome_screenshot"), makeCtx()))?.block === true);
check("subagent_wait blocked", (await tc(toolEvent("subagent_wait"), makeCtx()))?.block === true);
check("unknown future tool blocked", (await tc(toolEvent("some_future_tool"), makeCtx()))?.block === true);
check("read allowed", (await tc(toolEvent("read"), makeCtx())) === undefined);
check("web_search allowed", (await tc(toolEvent("web_search"), makeCtx())) === undefined);
check("plan_save allowed", (await tc(toolEvent("plan_save"), makeCtx())) === undefined);

console.log("\n[G2 — plan_exit warns when nothing saved yet]");
confirmCalls.length = 0;
confirmResponse = false;
await registered.tools.get("plan_exit").execute("id", {}, undefined, undefined, makeCtx());
check("warning present with empty store", confirmCalls[0]?.includes("WARNING: no plan has been saved yet"));
confirmResponse = true;
await registered.tools.get("plan_exit").execute("id", {}, undefined, undefined, makeCtx());
check("confirmed → full toolset restored", ["edit", "write", "subagent"].every((t) => activeTools.includes(t)));
check("widget cleared on exit", widgetCalls.at(-1)?.[1] === undefined);

console.log("\n[V1 — DAG validation on plan_save]");
const baseTasks = (t1state = "[ ]") => `# Plan: demo

## Scope
Demo scope.

## DoD
- echo ok

## Tasks

- ${t1state} T1: first
  deps: []
  owns: [src/a]
  done: echo t1
- [ ] T2: second
  deps: [T1]
  owns: [src/b]
  done: echo t2
- [ ] T3: third
  deps: []
  owns: [src/c]
  done: echo t3
`;
const expectReject = (name, content, needle) => {
	try {
		savePlan(CWD, "reject-demo", content);
		check(`${name} → rejected`, false);
	} catch (error) {
		check(`${name} → rejected`, error instanceof PlanStoreValidationError && error.message.includes(needle));
	}
};
expectReject("duplicate ID", baseTasks().replace("- [ ] T2:", "- [ ] T1: dup\n  deps: []\n  owns: [src/z]\n  done: x\n- [ ] T2:"), "duplicate task ID");
expectReject("unknown dep", baseTasks().replace("deps: [T1]", "deps: [TX]"), "does not match any task ID");
expectReject("cycle", baseTasks().replace("deps: []\n  owns: [src/a]", "deps: [T2]\n  owns: [src/a]"), "cycle");
expectReject("owns overlap same wave", baseTasks().replace("owns: [src/c]", "owns: [src/a/sub]"), "overlaps");
expectReject("missing done", baseTasks().replace("  done: echo t2\n", ""), 'missing "done:"');

console.log("\n[V3 — phase transition validation]");
expectReject("present without HLD", "phase: present\n" + baseTasks(), 'phase "present" requires a ## HLD section');
expectReject("decompose without HLD", "phase: decompose\n" + baseTasks(), 'phase "decompose" requires a ## HLD section');
savePlan(CWD, "phased-ok", "## HLD\nconfirmed design\n\n" + baseTasks());
check("hld + tasks + phase present → accepted", readFileSync(join(expectedStore, "phased-ok", "plan.md"), "utf8").includes("## HLD"));

console.log("\n[S1 — ephemeral /tmp store, 0700, waves regenerated]");
const savedPath = savePlan(CWD, "demo", baseTasks());
check("store under <tmpdir>/pi-smart-plan-<uid>", savedPath.startsWith(expectedStore));
check("goal dir mode 0700", (statSync(join(expectedStore, "demo")).mode & 0o777) === 0o700);
check("waves regenerated server-side", readFileSync(savedPath, "utf8").includes("Wave 1: T1, T3") && readFileSync(savedPath, "utf8").includes("Wave 2: T2"));
const draftPath = savePlan(CWD, "draft", "# just an idea, no Tasks section");
check("draft without Tasks saved as-is", !readFileSync(draftPath, "utf8").includes("waves"));
check("hasActivePlans true after save", hasActivePlans(CWD));

console.log("\n[phase inference]");
check("explicit line wins", parsePhaseLine("# P\nphase: present\n") === "present");
check("invalid phase ignored", parsePhaseLine("phase: banana\n") === undefined);
check("no hld/no tasks → discovery", inferPhase("# nothing", true) === "discovery");
check("guard off → execute", inferPhase(baseTasks(), false) === "execute");

console.log("\n[V2 — task lifecycle: owns + dep discipline]");
// dep discipline first (on a separate goal): done with open deps must fail
savePlan(CWD, "deps", baseTasks());
let depRejected = false;
try { updateTaskStatus(CWD, "deps", "T2", "done"); } catch (e) { depRejected = e instanceof PlanStoreValidationError && e.message.includes("dependencies not done yet"); }
check("done with open deps → rejected", depRejected);
// demo lifecycle: claim → rogue file → rejected → clean → done
updateTaskStatus(CWD, "demo", "T1", "in_progress");
writeFileSync(join(CWD, "rogue.txt"), "outside owns");
let ownsRejected = false;
try { updateTaskStatus(CWD, "demo", "T1", "done"); } catch (e) { ownsRejected = e instanceof PlanStoreValidationError && e.message.includes("rogue.txt"); }
check("file outside owns → done rejected", ownsRejected);
rmSync(join(CWD, "rogue.txt"));
const okMsg = updateTaskStatus(CWD, "demo", "T1", "done");
check("clean delta → done accepted", okMsg.includes("owns + deps verified"));
check("checkbox flipped server-side", readFileSync(savedPath, "utf8").includes("- [x] T1:"));
check("currentPhase picks demo (latest mtime)", currentPhase(CWD, false)?.goal === "demo");

console.log("\n[informed exit — dialog shows phase + progress]");
await registered.shortcuts.get("shift+tab").handler(makeCtx());
confirmCalls.length = 0;
confirmResponse = false;
await registered.tools.get("plan_exit").execute("id", {}, undefined, undefined, makeCtx());
check("dialog lists goal with phase", confirmCalls[0]?.includes("demo [decompose]") && confirmCalls[0]?.includes("1/3 done"));
confirmResponse = true;
await registered.tools.get("plan_exit").execute("id", {}, undefined, undefined, makeCtx());

console.log("\n[V2b — injection follows store]");
await registered.shortcuts.get("shift+tab").handler(makeCtx());
const injDecompose = await bas({ systemPrompt: "BASE" }, makeCtx());
check("guard ON + tasks → decompose block", injDecompose.systemPrompt.includes("PHASE: decompose"));
await registered.shortcuts.get("shift+tab").handler(makeCtx());
const injExecute = await bas({ systemPrompt: "BASE" }, makeCtx());
check("guard OFF + pending tasks → execute block", injExecute.systemPrompt.includes("PHASE: execute"));

console.log("\n[T4 — plan_verify mechanical delivery gate]");
const pv = await registered.tools.get("plan_verify").execute("id", { goal: "demo" }, undefined, undefined, makeCtx());
check("DoD echo ok → PASS", pv.content[0].text.includes("1/1 PASS") && pv.isError !== true);
savePlan(CWD, "failingdod", "# Plan: fd\n\n## DoD\n- exit 3\n");
const pvFail = await registered.tools.get("plan_verify").execute("id", { goal: "failingdod" }, undefined, undefined, makeCtx());
check("failing DoD → FAIL + isError", pvFail.content[0].text.includes("FAIL") && pvFail.isError === true);

console.log("\n[G1 — single approval gate releases guard]");
await registered.shortcuts.get("shift+tab").handler(makeCtx());
customResult = { answers: { "Approve?": "Approve" } };
const ask = await registered.tools.get("ask_smart_plan").execute(
	"id",
	{ questions: [{ question: "Approve?", options: [{ label: "Approve" }, { label: "Edit" }] }], releasePlanGuardOnAnswer: true },
	undefined, undefined, makeCtx(),
);
check("guard released on approval click", ask.details.released === true && ["edit", "write", "subagent"].every((t) => activeTools.includes(t)));

console.log("\n[/plan bootstrap message]");
sent.length = 0;
await registered.commands.get("plan").handler("fix the bug", makeCtx());
check("short bootstrap with goal", sent[0].msg.content.includes("Goal: fix the bug.") && !sent[0].msg.content.includes("DELIVERY"));

console.log("\n[D1 — --plan startup flag]");
entries.length = 0;
activeTools = [...FULL_TOOLS];
flagValue = true;
await registered.handlers.get("session_start")(undefined, makeCtx());
check("flag engages guard at startup", !activeTools.includes("edit") && !activeTools.includes("write"));
flagValue = false;

console.log("\n[/plan-status zero-token dump]");
notifications.length = 0;
await registered.commands.get("plan-status").handler("", makeCtx());
check("status dumped from goals", notifications.at(-1)?.[0]?.includes("demo [decompose]"));

console.log("\n[bash-guard regression battery]");
for (const [cmd, expected] of [["cat package.json", true], ["rg 'p' src", true], ["wget -O - https://x.dev", true], ["echo done > /dev/null", true]])
	check(`isReadOnly("${cmd}") === ${expected}`, isReadOnlyCommand(cmd) === expected);
for (const cmd of ["rm -rf /", "git push", "npm install x", "curl -o f https://x", "find . -delete", "sudo x"])
	check(`blocked: "${cmd}"`, isReadOnlyCommand(cmd) === false);

rmSync(expectedStore, { recursive: true, force: true });
rmSync(CWD, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
