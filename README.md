# pi-smart-plan

Plan mode with a mechanical write guard, plus a goal-scoped workflow that executes plans via parallel subagents — for the pi coding agent.

## What it is

`pi-smart-plan` turns plan mode into a real state machine: while you design, the agent is mechanically read-only; the plan itself is structured data the extension validates rather than prose it eyeballs.

A goal moves through six phases with exactly two owner decision points. Everything between them the agent drives itself, and the guard drops only on your word — normally the "start implementation" click.

## Base concepts

**Owner-only mechanical guard.** Plan mode is engaged exclusively by you — `shift+tab`, `/plan`, `/plan-guard on`, or `pi --plan` at launch. The model has no tool to activate it and no unilateral way out: `plan_exit` always requires an affirmative user confirmation. Enforcement is mechanical (tools removed from the active set, re-blocked at call time as a backstop), not a promise in a prompt.

**Machine-owned phase state.** The current phase lives in a `phase.txt` the model never reads or writes directly. It changes only through `plan_advance` (self-advance, allowed once the phase's deliverable mechanically validates) or your answer at one of the two gates. `phase.txt` stays authoritative even when the guard is toggled, which is why re-engaging the guard mid-`execute` keeps you in `execute` rather than regressing to planning.

**Owner-confirmed objective.** Discovery closes its first checkpoint through `plan_intent`: the agent restates your goal as a kebab-case slug plus a one-line statement and opens a **Confirm / Keep chatting** form. When decisions are still open the agent declares them in the same call, and the form resolves those forks first before closing on a **Confirm / Reword** page — so one call both settles the forks and confirms. Only a Confirm answer writes `intent.txt`. Until it exists, `plan_save` mechanically refuses to write any content for that goal — no plan ever exists without a confirmed objective next to it.

**Choices are forms.** While plan mode is active, a decision put to you arrives as a form, never as a paragraph of options. This is backed mechanically: a planning-phase turn that closes in prose while offering you alternatives is regenerated toward an `ask_smart_plan` form. The detector is deliberately conservative — see [Plan mode behavior](#plan-mode-behavior) for its exact scope and declared limits.

**Default-deny while planning.** Only reading (`read`/`grep`/`find`/`ls`), an allowlisted read-only bash, web research, subagent spawning, and the planning-store tools run. Everything else — write built-ins, chrome, unknown or future third-party tools — is blocked. Spawned children inherit the guard via `PI_SMART_PLAN=1` and are exploration-only: no phase machine, no store tools. The only writes go into the plans folder.

**DAG-as-data.** The plan's `## Tasks` section is a graph: `id` / `deps` / `owns` / `done` per task. `plan_save` rejects duplicate IDs, unknown deps, cycles, `owns` that overlap within a wave, and missing `done:` checks, then regenerates the derived waves section server-side. `plan_next` returns the ready frontier computed from the graph, never guessed.

**Ephemeral store, durable approved copy.** Plans, journals and phase state live outside the repo, in a per-user directory under the system temp dir — wiped on reboot by design, zero footprint in your working tree. Once a plan clears Gate 2 a durable copy is written under pi's agent directory; that copy is the only part that survives a reboot.

**Session ownership.** Each pi session claims at most one goal, and ownership comes only from confirming an objective via `plan_intent` or from restoring the session's own claim on reload — never from adopting whatever the repo-wide pointer happens to reference. A session that owns no goal is a new session, driven as `discovery`. Concurrent plan-mode sessions in the same repo are supported: destructive paths act only on the goal the session owns.

## Quickstart

```
pi install npm:@jnardiello/pi-smart-plan
# or from git:
pi install git:github.com/jnardiello/pi-smart-plan
```

Then run `/reload` to pick up the extension.

**Free the `shift+tab` key first.** pi's built-in `app.thinking.cycle` also defaults to `shift+tab` — out of the box the two collide and the plan-mode toggle silently loses. Remap it in `~/.pi/agent/keybindings.json`:

```json
{
  "app.thinking.cycle": "ctrl+q"
}
```

Any free chord works — pi has no two-key chord support, so pick a modifier combo your terminal doesn't intercept (enable the Kitty keyboard protocol if it does). `/plan <goal>` and the `--plan` launch flag are unaffected by the collision and always work if you'd rather not touch your keybindings.

A first session, end to end:

1. Activate plan mode (`shift+tab`, `/plan <goal>`, or launch with `pi --plan`).
2. Describe what you want to build; the agent explores the codebase and asks questions.
3. Answer any open decisions the agent forms, then confirm the restated objective on the confirmation page.
4. **Gate 1** — approve or reject the trimmed high-level design.
5. **Gate 2** — pick "Start implementation" on the full plan.
6. The guard releases in that same click and the agent implements, verifying each task as it closes.

## The six phases

Every turn injects only the current phase's instructions, so the agent always sees the contract of the moment. The widget's heat bar shows where you are.

```
discovery → simplify → review_hld → decompose → review_final → execute
 (chat,      (auto        (Gate 1:      (auto DAG   (Gate 2:       (guard
  save HLD)   trim +       present +     owns/deps/  summary +      released)
              cut log)     approve)      done)       yes/no form)
```

> **True in every phase before `execute`:** default-deny tool policy, writes only into the plans folder, owner-only activation. Discovery is prose-first; the two gates are harness-composed forms with fixed labels the model cannot rephrase, and Esc/decline is their only postpone path (they carry no "None of the above"). **Exiting plan mode while a goal is still mid-planning tombstones it and discards it after a 10-second grace** — re-engaging plan mode within the window keeps it, with a "plan kept" notification. Goals in `execute` are exempt.

### 1. `discovery` — prose co-design, produces the HLD

- **Entered by**: activating plan mode.
- **What happens**: free-form conversation in which the agent proactively launches read-only exploration subagents and web research, folding findings back in to ground its questions. Open decisions always reach you as forms, never buried in prose: the agent calls `plan_intent` carrying them, and the same call resolves those forks before closing on the objective confirmation — **Confirm / Reword** when questions rode along, plain **Confirm / Keep chatting** when none did. Reword and Esc write nothing and send the agent back to reformulate the objective from your answers. After confirmation it may run an unbounded grilling round, then co-designs the HLD and writes it with one `plan_save` using the canonical English headings (`## HLD`, `## Scope`, `## Non-goals`, `## Decisions`, `## DoD`, with at least one executable DoD line). Body text can be in any language — only the heading names are checked.
- **You'll see**: conversation with evidence folded in, the objective-confirmation form, occasional question forms, zero code changes.
- **Expected from you**: state the goal, confirm the restated objective (or keep chatting to revise it), answer as you go.
- **Exits when**: the saved HLD is complete — the agent calls `plan_advance` itself.

### 2. `simplify` — automatic ablation pass

- **Entered by**: discovery's `plan_advance`.
- **What happens**: fully automatic, no owner questions. The agent re-reads the HLD as its harshest reviewer, cuts nice-to-haves and over-engineering, journals every cut (or one line explaining why nothing could be cut), and resaves if anything was trimmed. Plans under 60 lines skip the ceremony: the phase auto-passes and the harness journals an `auto-pass` line itself, so it never vanishes from the record.
- **You'll see**: a 1–3 line chat update on what was cut, or nothing at all on a small plan.
- **Expected from you**: nothing.
- **Exits when**: a cut log exists for this phase — or the plan is under the auto-pass threshold. The agent calls `plan_advance` itself.

### 3. `review_hld` — Gate 1

- **Entered by**: simplify's `plan_advance`, which opens the gate in the same call: the harness renders the plan panel (HLD, scope, non-goals, DoD), headed by an `OBJECTIVE:` line carrying your confirmed statement, together with the form.
- **What happens**: a fixed two-option decision — **Approve / Reject**.
- **You'll see**: panel and form appear together, opened automatically.
- **Expected from you**: pick one.
- **Exits when**: **Approve** → `decompose`. **Reject** → back to `discovery`, your optional note journaled and addressed before the next save. Esc/decline postpones: the phase holds until a later `plan_advance` re-opens the gate.

### 4. `decompose` — automatic DAG build

- **Entered by**: Gate 1's Approve.
- **What happens**: fully automatic. The approved HLD becomes a `## Tasks` DAG, validated mechanically on save; waves are derived server-side.
- **You'll see**: the widget on decompose, and precise errors in chat if the DAG is invalid.
- **Expected from you**: nothing.
- **Exits when**: the DAG passes validation — the agent calls `plan_advance` itself.

### 5. `review_final` — Gate 2

- **Entered by**: decompose's `plan_advance`, after the agent writes a short summary of what ships. The call opens the gate itself: full plan panel (objective, waves, deps, live checklist) plus the form, **Start implementation / Stay in planning**.
- **Staged-files preflight**: before opening the form the harness checks for files already staged in git, since pi-subagents' worker acceptance rejects write-workers while anything is staged. If any are found the form lists them and grows a third option — **Unstage & start implementation** (runs `git restore --staged` on exactly those paths, index only, worktree content untouched, re-verified and journaled) / **Start anyway** (proceeds, journals that staged entries remain) / **Stay in planning**.
- **You'll see**: summary, plan panel and form together.
- **Expected from you**: pick one.
- **Exits when**: **Start implementation** — the plan is copied to the durable approved store, the phase flips to `execute`, and the guard releases in the same click. The authorization then lands on the first real turn that follows, with the execute tool surface guaranteed active on that same turn — including when you type before the agent moves. An authorization that has gone stale (goal completed, phase no longer `execute`, guard re-engaged, claim moved) is never injected. **Stay in planning** or Esc/decline holds the phase until a later `plan_advance` re-opens the gate.

### 6. `execute` — implementation

- **Entered by**: Gate 2's release — the only transition into `execute`.
- **What happens**: the ready frontier comes from `plan_next`; parallel workers take tasks with disjoint `owns`, one writer per checkout. Every task is verified in the root — its own `done` check plus a git-backed `owns` delta check — before being marked done. Events are journaled; scope or DoD changes are put to you as a form.
- **You'll see**: per-task progress in the widget, worker activity, journal entries, and the full task checklist reprinted every time a task closes.
- **Expected from you**: answers to re-entry questions, final review.
- **Exits when**: all DoD commands pass via `plan_verify`, then `plan_complete`, then exactly one delivery commit — only if you asked for one.

> **Re-engaging the guard mid-`execute` stays in `execute`.** Toggling `shift+tab` back on during implementation gives you read-only supervision; it never regresses the session to planning.

## Tool & command reference

| Tool | What it does |
| --- | --- |
| `ask_smart_plan` | The everyday question form: one tab per open decision, briefing pane plus per-option consequences, auto-paged past 4 questions. Ordinary forms end with a built-in "None of the above"; Escape declines. |
| `plan_intent` | Discovery's objective checkpoint — Confirm creates `intent.txt` and unblocks `plan_save`; Keep chatting (and Esc) rejects it. `openQuestions` carries still-open decisions: the harness forms them first, then closes the same call on a Confirm/Reword page, so a resolved set confirms without a second call. |
| `plan_save` | Writes (overwrites) a goal's plan. Validates the canonical headings and, once `## Tasks` exists, the DAG. Refuses until the objective is confirmed. |
| `plan_advance` | The single self-advance tool. Moves to the next phase when the deliverable validates, and opens the gate form itself when it lands in a review phase. |
| `plan_exit` | Requests guard release; always gated by a user confirmation dialog. There is no `plan_enter` — activation is owner-only. |
| `plan_next` | The mechanically computed ready frontier: pending tasks whose deps are all done. |
| `plan_verify` | Runs every DoD command and reports pass/fail — the mechanical delivery gate. |
| `plan_task_update` | Sets a task's status (`pending`/`in_progress`/`blocked`/`done`); claiming snapshots dirty files, closing verifies the delta against `owns` and dependency order. Closing to `done` renders the whole task checklist; other states stay one-liners. |
| `plan_complete` | Moves a goal into the store's `done/` area; call it once its DoD passes. |
| `plan_recall` | Searches this repo's plans. Explicit-only: run it when asked about prior work. Returns content, never paths. |
| `journal_append` | Appends timestamped lines to a goal's journal (append-only). Requires an existing goal. |

| Command | What it does |
| --- | --- |
| `/plan <goal>` | Starts the goal workflow with the guard engaged. |
| `/plan-guard status\|on\|off` | Controls the read-only guard outside a plan. |
| `/plan-status` | Zero-token dump of active goals, phases and ready frontier. |
| `pi --plan` | Launches with the guard already engaged. |
| `shift+tab` | Toggles read-only plan mode. Activation only notifies you — no LLM turn. |

This package is a pi extension, not a skill, and needs no third-party extension for its forms.

## Artifacts layout & concurrency

Plans, journals and phase state live in an ephemeral extension-owned store under the system temp dir — per-user (`pi-smart-plan-<uid>`, directories created `0700`). The model never handles these paths; all I/O goes through the tools.

```
<tmpdir>/pi-smart-plan-<uid>/<repo>/active.txt          # last goal touched by a write — a hint, not the resume path
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/intent.txt    # owner-confirmed objective (statement + timestamp)
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/plan.md       # WHAT: HLD + Scope + Non-goals + Decisions + DoD + Tasks DAG
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/journal.md    # append-only WHY / how it went
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/phase.txt     # machine-owned current phase
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/claims.json   # per-task dirty-file baselines for the owns delta check
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/abandoned.txt # per-goal tombstone during the abandon grace
<tmpdir>/pi-smart-plan-<uid>/<repo>/done/<goal>/         # completed goals, moved here by plan_complete
<agentDir>/smart-plan/approved/<repo>/<goal>/plan.md     # durable copy, written when Gate 2 authorizes
```

**Resume and ownership.** A session resumes the goal it owns from the claim recorded in its own transcript — restoration, never adoption. A goal that has been completed refuses with a distinct message saying so and naming `plan_save` as the way to reopen it, rather than the message used for a goal the session never owned. `active.txt` is repo-wide and shared, so it cannot answer "which goal does *this* session act on" and is never used to infer ownership; a session whose claim no longer resolves simply owns nothing and is driven as `discovery`. `plan_save`, `plan_task_update`, `plan_verify` and `plan_complete` name their goal as a parameter but act only on the owned goal, and `plan_exit` authorizes release only for it.

**Abandon grace.** Exiting plan mode mid-planning writes `<goal>/abandoned.txt` and arms a 10-second timer: re-engaging within the window restores the goal, letting it lapse purges the directory — `intent.txt` included, so reopening the same slug later means reconfirming the objective. The tombstone is per goal precisely so two sessions on the same repo can abandon independently. Any activity on a tombstoned goal counts as interest: journaling during the grace re-pins the pointer and the goal is kept. A fresh activation sweeps stale leftovers, but only ever the session's *own* goal — it can never discard a plan another session is driving.

**Concurrency.** Concurrent plan-mode sessions in the same repo are supported. Two residual limits: the widget polls the store about every 2 seconds, so another session's changes show up with that lag; and a claim on a goal another session completed or purged leaves that session in `discovery`.

**Migration.** A goal directory without `phase.txt` is pinned to `discovery` on the next write — the phase is never inferred from plan content.

> **Ephemerality:** the working store does not survive a reboot, and macOS may clean untouched `/tmp` files after roughly three days. The durable approved copy is the only persistent part; cross-session history of in-progress goals is intentionally out of scope.

`<tmpdir>` respects `TMPDIR`. `<repo>` derives from the working directory, `<goal>` is the kebab-case slug. Re-opening a completed goal happens automatically on the next `plan_save`. Never read the store with `read` or `bash` — use `plan_recall`. Repos that already use an in-repo `backlog/` directory are not migrated; that directory and its history stay untouched.

## Operational sheet for agents

If you are an agent onboarding your human onto this extension, this is your contract.

| Phase | Your duties | Human touchpoint | Typical mistakes |
| --- | --- | --- | --- |
| `discovery` | Explore proactively with read-only scouts and web research; surface every open decision through a form; confirm the objective via `plan_intent` before any `plan_save`; then co-design and save the HLD. | Objective confirmation, plus any questions you raise — Confirm / Reword when open decisions rode along, Confirm / Keep chatting otherwise. | Confirming the objective in prose; enumerating options in chat instead of a form — the harness now regenerates such a turn; holding questions back for a second `plan_intent` call when they could have ridden in `openQuestions`; calling `plan_save` before `intent.txt` exists. |
| `simplify` | Cut hard, journal every cut, resave if anything changed — unless the plan is under the auto-pass threshold, which needs nothing from you. | None. | Asking the owner what to cut; inventing token cuts on a small plan the threshold already waives. |
| `review_hld` | Call `plan_advance` — it opens Gate 1 itself. Then wait. | Approve / Reject. | Composing your own approval wording; re-opening a gate the owner deliberately postponed. |
| `decompose` | Build the `## Tasks` DAG and fix validation errors until the save passes. | None. | Treating validation failures as advice; hand-deriving waves the server regenerates. |
| `review_final` | Summarize what ships, then `plan_advance` to open Gate 2. | Start implementation / Stay in planning (plus the unstage option when files are staged). | Asking for approval in prose; assuming the guard drops before the owner's click. |
| `execute` | Dispatch off `plan_next`, keep `owns` disjoint, run each task's `done` check in the root before closing it, journal events, `plan_verify` before claiming delivery. | Re-entry questions, final review, explicit request for the delivery commit. | Eyeballing dependencies instead of using `plan_next`; closing a task without running its check; committing without being asked. |

Three rules hold in every phase: never read the store with `read` or `bash` — `plan_recall` is the only sanctioned path; never stop to ask "how should I proceed?" when the phase's deliverable is ready, because `plan_advance` is that answer; and never hand the owner alternatives in prose while planning, which the harness regenerates toward a form. Tool results always carry an informational next-action hint; its imperative form only appears once a second consecutive turn has passed with the deliverable already ready, so an agent that advances promptly never sees it. Note also that "up to 4 parallel workers" is prompt-level guidance in the execute instructions, not a mechanical limiter.

## Plan mode behavior

While the guard is active, `edit`/`write` and interactive chrome tools leave the active tool set, bash runs only allowlisted read-only commands (`ls`, `rg`, `cat`, `git status/diff/log`, …) while interpreters, script runners and package managers — including `npm test`/`npm run`, since scripts can write — are blocked. The allowlist lives in `src/bash-guard.ts`.

A TUI widget shows the phase pipeline as a heat bar, context usage, per-goal progress and the ready frontier, refreshing as the store changes. Tool calls and results render through themed renderers rather than raw tool names, and the plan panel draws the task DAG as a todo tree with wave headers, done/ready glyphs, dependency annotations and a live counter.

Closing a task to `done` prints that same task DAG as a progress checklist — wave headers, `☑`/`☐` glyphs, dependency annotations and an `N/M done · ready now: …` footer — with the task you just finished already ticked. `in_progress` and `blocked` stay single lines. In a parallel wave this means N closes print N panels: deliberate, since collapsing them would cost exactly the sense of progress the checklist exists to give.

**Choices are forms, mechanically.** With plan mode active, a planning-phase turn that closes in prose while offering you alternatives is regenerated toward an `ask_smart_plan` form. The scope is deliberately narrow: only while the guard is on, and only in planning phases — `execute` is exempt, and guard-off sessions are not covered at all, a declared product limit rather than an oversight. It never fires when the turn already opened `ask_smart_plan` or `plan_intent`. The detector requires both an enumeration (or an either-or construction) *and* an actual request for your choice, so recaps of settled decisions, file listings, diagnostic questions and politeness formulas leave it alone; some genuine offers slip through by design, because missing one costs less than force-regenerating a legitimate answer. This is the single place where the extension inspects the *text* of a turn — every other floor rule judges structure alone, namely whether the turn closed with a tool or with prose.

Some tools deliberately work with the guard off: ordinary `ask_smart_plan` forms, `plan_recall` and `journal_append` run in any session so the model can ask, look up prior work, or log a finding without making you engage plan mode. The execute-phase tools stay operational once a goal has cleared Gate 2 — that is the designed flow. Planning-state mutations are the exception: `plan_intent`, and `plan_save`/`plan_advance` on a goal still in a planning phase, refuse with `plan mode is off — activate it first (shift+tab or /plan)` when the guard is down.

If you use `@gotgenes/pi-permission-system`, this extension's enforcement is independent (tool removal plus allowlist), so nothing breaks either way.

## Commit policy

Exactly one agent commit per goal — the final delivery commit, code and repo changes only, since plan and journal live outside the repo. There is no approval commit. Never push, never publish. Users who want different behavior should say so explicitly.

## Permissions

If you use `@gotgenes/pi-permission-system` (default `*` = ask), allow the extension tools or every call pauses on a y/n prompt. The extension cannot flip that policy for you.

```json
"ask_smart_plan": "allow",
"plan_intent": "allow",
"plan_exit": "allow",
"plan_advance": "allow",
"plan_next": "allow",
"plan_save": "allow",
"plan_task_update": "allow",
"plan_verify": "allow",
"journal_append": "allow",
"plan_recall": "allow",
"plan_complete": "allow"
```

## Requirements

- pi 0.84.2+

## License

MIT
