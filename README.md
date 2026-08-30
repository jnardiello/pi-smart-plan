# pi-smart-plan

Plan mode with a mechanical write guard, plus a goal-scoped workflow that executes plans via parallel subagents — for the pi coding agent.

## What it is

`pi-smart-plan` gives pi a goal-scoped planning workflow:

- **Owner-only plan mode** couples a mechanical write guard to the plan lifecycle. It can be engaged exclusively by the user (`shift+tab`, `/plan`, `/plan-guard on`, or `pi --plan` at launch) — the model has no tool to activate it, and no unilateral way out: `plan_exit` always requires an affirmative user confirmation.
- **True read-only** while planning — **default-deny**: only reading (`read`/`grep`/`find`/`ls`), bash restricted to read-only commands, web research, subagent spawning (children inherit the guard and are exploration-only) and the planning-store tools run while planning; everything else (write built-ins, chrome, unknown or future third-party tools) is blocked. The only writes go into the plans folder via the store tools (`plan_save`, `journal_append`, `plan_complete`).
- **Goal-scoped workflow** writes a DAG-as-data plan into an ephemeral extension-owned store under the system temp dir, derives execution waves, runs up to 4 parallel subagents per wave with disjoint `owns` and one writer per checkout, then a single delivery commit. One active goal per session, zero footprint in the repo.
- **Canonical-headings contract**: every `plan_save` must carry `## HLD`, `## Scope`, `## Non-goals`, `## Decisions`, `## DoD` (plus `## Tasks` once `decompose` starts) using those exact English heading names, with at least one executable `## DoD` line. Body text under those headings can be written in any language — only the headings are checked. A save that violates this is rejected immediately, listing exactly which headings are missing and which ones were actually found.
- **Mechanical DAG validation**: `plan_save` rejects plans with duplicate task IDs, unknown deps, dependency cycles, overlapping `owns` within the same wave, or missing `done:` checks — and regenerates the derived waves section server-side. `plan_next` returns the ready frontier (tasks dispatchable now) computed from the graph, never eyeballed.
- **A six-phase plan state machine with exactly two owner touchpoints (0.10.0)**: `discovery` (prose co-design, HLD saved with canonical headings) → `simplify` (automatic ablation pass, journaled cut log) → `review_hld` (**Gate 1** — owner approves or rejects the trimmed HLD) → `decompose` (automatic DAG build, mechanically validated) → `review_final` (**Gate 2** — owner's start-implementation yes/no) → `execute`. Every other transition is the model's own job: once a phase's deliverable is mechanically ready it self-advances via the formless `plan_advance` tool — it never stops to ask the owner how to proceed.
- **Owner-confirmed objective, mechanically enforced (0.10.0)**: discovery opens with proactive, evidence-backed chat and closes its first checkpoint through `plan_intent` — a Confirm/Correct form that reformulates the owner's objective. Only Confirm creates the confirmed objective; `plan_save` refuses any content for the goal until it exists, and the confirmed statement reappears as an `OBJECTIVE:` line in both owner gates.
- **Progressive disclosure**: instead of one giant workflow prompt, each turn injects only the current phase's instructions plus global constraints — the model always sees the contract of the moment.

## Lifecycle: the six phases

Plan mode runs as a small state machine. Every turn injects only the instructions of the current phase, so the agent always knows exactly what it should be doing. The widget's heat bar shows where you are; the phase itself lives in a machine-owned `phase.txt` file the model never reads or writes directly — it changes only via `plan_advance` (self-advance) or an owner's gate answer.

```
discovery → simplify → review_hld → decompose → review_final → execute
 (chat,      (auto        (Gate 1:      (auto DAG   (Gate 2:       (guard
  save HLD)   trim +       present +     owns/deps/  summary +      released)
              cut log)     approve)      done)       yes/no form)
```

> **True in every phase**: default-deny tool policy (only reading, planning tools, web research and exploration-only subagents); writes only into the plans folder; activation is owner-only; the guard releases only through your Gate 2 answer on a fully visible plan. Discovery is prose-first — plain-language back-and-forth is the default, with `ask_smart_plan` forms offered whenever they converge faster; the two gates are harness-composed forms with fixed labels the model can't rephrase. **Exiting plan mode while a goal is still in any of these five phases discards it after a 10-second grace** — re-enabling plan mode within the window keeps it; `execute` (below) is exempt.

### 1. `discovery` — prose co-design (produces the HLD)

- **Entered by**: activating plan mode (`shift+tab`, `/plan`, `/plan-guard on`, `--plan`).
- **What happens**, in four moments:
  1. **Free-form chat with proactive discovery** — the agent talks through the goal in plain prose and, rather than waiting to be asked, proactively launches read-only exploration subagents on the codebase and web research on whatever you're discussing, folding the findings back into the conversation to ground its questions and suggestions in evidence. At the end of every turn it self-assesses whether enough is known to state a goal.
  2. **Objective confirmation** — as soon as it can, the agent restates the goal (kebab-case slug + one-line statement) and opens a `plan_intent` form: **Confirm / Correct**. Only Confirm creates the confirmed objective (`intent.txt`); nothing else in discovery substitutes for it, and `plan_save` mechanically rejects any content for the goal until it exists.
  3. **Optional post-confirmation grilling** — once confirmed, the agent may open an unbounded round of questions (`ask_smart_plan` forms and/or prose) to fully clarify the goal, still backed by scouts and web research; key clarifications are journaled, and if the objective materially changes the agent re-runs `plan_intent` to re-confirm it.
  4. **Refined brief, then HLD** — the agent presents the fully refined brief in prose, co-designs the HLD with you, and writes it in one `plan_save` using the canonical English headings; body text can be in any language.
- **You'll see**: the widget on discovery, free-form conversation with proactive findings folded in, the objective-confirmation form, occasional forms during grilling, zero code changes.
- **Expected from you**: state the goal, confirm (or correct) the restated objective, answer as you go.
- **Exits when**: the saved HLD is complete — the agent calls `plan_advance` itself.

### 2. `simplify` — automatic ablation pass

- **Entered by**: discovery's `plan_advance`.
- **What happens**: fully automatic, no owner questions. The agent re-reads the HLD as its harshest reviewer — cuts nice-to-haves, collapses over-engineering, merges elegance-only ideas — and journals every cut (or a single entry explaining why nothing could be cut). If anything was trimmed it resaves the HLD; canonical headings are re-validated.
- **You'll see**: a brief 1–3 line chat update on what was cut, then the widget moves on.
- **Expected from you**: nothing.
- **Exits when**: at least one journal entry for this phase exists — the agent calls `plan_advance` itself.

### 3. `review_hld` — Gate 1

- **Entered by**: simplify's `plan_advance`.
- **What happens**: calling `plan_advance` auto-opens Gate 1 in the same step — the harness renders the HLD + cut log panel, headed by an `OBJECTIVE:` line carrying the owner-confirmed statement, and the form together. The form is harness-composed — the agent can't invent its own wording: **Approve / Reject**.
- **You'll see**: the plan panel and the fixed-label form appear together, opened automatically.
- **Expected from you**: pick one of the two.
- **Exits when**: **Approve** → `decompose`. **Reject** → back to `discovery` with your optional note journaled (the agent addresses it before the next `plan_save`). "None of the above" → postpones: stays in `review_hld` until a later `plan_advance` re-opens the gate.

### 4. `decompose` — automatic DAG build

- **Entered by**: Gate 1's Approve.
- **What happens**: fully automatic. The agent turns the approved HLD into a `## Tasks` DAG (`id` / `deps` / `owns` / `done` per task) and saves it; `plan_save` validates mechanically — unique IDs, resolvable acyclic deps, disjoint `owns` within a wave, `done:` checks present — and regenerates the derived waves section server-side.
- **You'll see**: the widget on decompose; precise errors in chat if the DAG is invalid.
- **Expected from you**: nothing.
- **Exits when**: the DAG passes validation — the agent calls `plan_advance` itself.

### 5. `review_final` — Gate 2

- **Entered by**: decompose's `plan_advance`.
- **What happens**: the agent writes a concise summary of what ships in chat, then calls `plan_advance`, which auto-opens Gate 2 in the same step — the harness renders the full plan panel (`OBJECTIVE:` line, waves, deps, live checklist) and the form together, harness-composed: **Start implementation / Stay in planning**.
- **You'll see**: the chat summary and the full plan panel appear together with the decision form, opened automatically.
- **Expected from you**: pick one of the two.
- **Exits when**: **Start implementation** — the plan is persisted to the durable approved store, the phase flips to `execute`, the guard releases in the same click, and the authorization briefing is queued to land on a FRESH turn so the agent starts implementing with its full tool surface already active. **Stay in planning** (or "None of the above") → stays in `review_final` until a later `plan_advance` re-opens the gate.

### 6. `execute` — implementation

- **Entered by**: Gate 2's "Start implementation" — the only thing that ever releases the guard.
- **What happens**: the ready frontier comes from `plan_next`; up to 4 parallel workers per wave with disjoint `owns`; every task is verified in the root (its own `done` check plus the git-backed `owns` delta check) before being marked done; journal entries per event; the agent asks via a form when scope/DoD must change.
- **You'll see**: per-task progress in the widget, worker activity, journal entries.
- **Expected from you**: answers to re-entry questions, final review.
- **Exits when**: all DoD commands pass via `plan_verify`, then `plan_complete`, then exactly ONE delivery commit (only if you asked for it).

> **Re-engaging the guard mid-execute stays in execute.** `phase.txt` is authoritative over guard state: toggling `shift+tab` back on during implementation does not regress the session to planning — it stays in `execute` (read-only supervision only), and the widget and tool surface reflect that.

## Install

```
pi install npm:@jnardiello/pi-smart-plan
# or from git:
pi install git:github.com/jnardiello/pi-smart-plan
```

Then run `/reload` to pick up the extension.

## Usage

- `/plan <goal>` — start the goal workflow (scoping, plan, approval, execution, delivery).
- `/plan-guard status|on|off` — control the read-only guard outside a plan.
- `plan_exit` tool — request to release the guard; always gated by a user confirmation dialog. There is **no** `plan_enter` tool: activation is owner-only.
- `plan_advance` tool — the single self-advance tool for every phase. In `discovery`/`simplify`/`decompose` it moves to the next phase once that phase's deliverable is mechanically ready (the same validators `plan_save` uses), refusing with an error (phase untouched) when it isn't. Called out of `simplify`/`decompose` it lands in the next review phase and opens that phase's Gate form in the SAME call — panel and form together, nothing to call separately. Called again while already in `review_hld`/`review_final` it re-opens a gate the owner postponed.
- `plan_save` — write (overwrite) the plan for a goal in the external store. Validates the canonical-headings contract (see above) and, once a `## Tasks` section exists, the task DAG — rejecting the save immediately with a precise list of what's wrong. Also mechanically rejected until the goal's objective has been confirmed via `plan_intent` (below) — no `plan.md` ever exists without a confirmed `intent.txt` next to it.
- `plan_intent` tool — discovery's owner-backed objective checkpoint: the agent reformulates the goal as a kebab-case slug plus a one-line statement and opens a **Confirm / Correct** form. Only Confirm writes the confirmed objective (`intent.txt` — statement + timestamp) and unblocks `plan_save`; Correct collects an optional note and creates nothing. Re-runnable in discovery to re-confirm a refined statement (e.g. after a grilling round or a Gate 1 rejection); locked once discovery ends.
- `journal_append` — append timestamped lines to the goal journal (append-only).
- `plan_recall` — search the store for this repo's plans. Explicit-only: run it when the user asks about prior work on a topic. Returns content (plan + journal tail), never paths.
- `plan_next` — mechanically computed ready frontier for a goal: pending tasks whose deps are all done. Use it during execution instead of eyeballing deps.
- `plan_complete` — move a goal to the `done/` portion of the store after its DoD passes.
- `plan_task_update` — set a task's status (`pending | in_progress | blocked | done`). Claiming snapshots dirty files; closing verifies the delta stayed inside the task's `owns` (git-backed) and that dependencies are closed. Checkbox flipped server-side.
- `plan_verify` — run every DoD command of a goal's plan and report pass/fail. The mechanical delivery gate: no delivery claim without a green `plan_verify`.
- `/plan-status` — zero-token dump of active goals, phases and ready frontier.
- `shift+tab` — toggle read-only plan mode. Activation only notifies you (no LLM turn): describe what you want to design and the discovery-phase instructions take over. **This binding collides with pi's default `app.thinking.cycle` shortcut out of the box — see the note right below.**
- `ask_smart_plan` tool — the everyday question form. In `review_hld`/`review_final` the Gate form itself opens automatically the moment `plan_advance` reaches (or re-enters) that phase — the extension supplies the fixed labels (Approve / Reject, or Start implementation / Stay in planning) and the real plan contract in the briefing pane; the agent calls `ask_smart_plan` with `phaseGate: true` itself only to re-open a gate the owner postponed. Elsewhere it's an ordinary question form: one tab per open decision (never structural categories like "Scope" or "DoD" — the agent drafts that contract itself), a human briefing pane (`detail`) plus consequences of the highlighted option (`preview`). Options may be plain strings or `{label, description, preview}` objects. Long text scrolls with J/K or PgUp/PgDn. Every form ends with a built-in **"None of the above"** option — selecting it opens an OPTIONAL note (submit empty to accept as-is); in multi-select it is exclusive. Escape declines the form. Question sets over 4 are auto-paged into sequential forms. Goals with no real fork skip the form entirely. No third-party extension required.

`/plan` injects the workflow into the session. This package is a pi extension, not a skill. Start with the guard already engaged via `pi --plan`.

### IMPORTANT: shift+tab collides with pi's default thinking-cycle binding

pi's built-in `app.thinking.cycle` also defaults to `shift+tab` — out of the box the two collide and the plan-mode toggle silently loses. Remap it in `~/.pi/agent/keybindings.json` to free the key:

```json
{
  "app.thinking.cycle": "ctrl+q"
}
```

(Any free chord works — pi has no two-key chord support, so pick a modifier combo your terminal doesn't intercept itself; enable the Kitty keyboard protocol if it does.)

Without that remap, `shift+tab` is unreliable. `/plan <goal>` and the `--plan` launch flag are unaffected by this collision and always work — use them if you'd rather not touch your keybindings.

## Artifacts layout

Plans, journals and phase state live in an EPHEMERAL extension-owned store under the system temp dir — per-user (`pi-smart-plan-<uid>`, dirs created `0700`) and wiped on reboot by design; the model never handles those paths, all I/O goes through the dedicated tools:

```
<tmpdir>/pi-smart-plan-<uid>/<repo>/active.txt           # pointer: last goal touched by a write (drives per-turn phase injection) — the ONLY resume path
<tmpdir>/pi-smart-plan-<uid>/<repo>/abandoned.txt        # tombstone for a goal mid-abandon-grace after exiting plan mode mid-planning
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/intent.txt     # owner-confirmed objective (statement + timestamp), written by plan_intent's Confirm — plan_save refuses to write plan.md without it
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/plan.md       # WHAT: HLD + Scope + Non-goals + Decisions + DoD + Tasks DAG — never carries a phase marker
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/journal.md    # append-only WHY/HOW IT WENT (via journal_append)
<tmpdir>/pi-smart-plan-<uid>/<repo>/<goal>/phase.txt     # machine-owned current phase — the model never reads or writes it directly
<tmpdir>/pi-smart-plan-<uid>/<repo>/done/<goal>/         # completed goals, moved here by plan_complete
```

`phase.txt` is the single source of truth for a goal's phase — it changes only through `plan_advance` or an owner's gate answer, never through plan content, and it stays authoritative even while the read-only guard is off or re-engaged (this is what keeps a goal re-guarded mid-`execute` staying in `execute`). Pre-0.10 goals without a `phase.txt` are migrated once, on the next write, inferring their phase from the existing plan content; pure reads never write to disk. Legacy phase names still on disk from earlier versions are mapped to their current equivalents on read without rewriting the file.

`intent.txt` is the owner-confirmed objective — created only by a Confirm answer on the `plan_intent` form, never by plan content or a self-advance. A goal directory can exist with `intent.txt` but no `plan.md` yet (discovery in progress); it can never have `plan.md` without `intent.txt`. Abandoning a goal purges `intent.txt` along with the rest of its directory, so reopening the same slug later requires reconfirming the objective from scratch.

**Exiting plan mode while the pointed goal is still mid-planning** (anywhere before `execute`) tombstones it rather than deleting it outright: `active.txt` is renamed to `abandoned.txt`, which stops the pointer from resolving immediately, and a 10-second in-process grace timer arms. Re-engaging plan mode within the window cancels the timer, restores the pointer and notifies you the plan was kept; letting the timer lapse purges the goal directory and the tombstone for good. Goals in `execute` are exempt — Gate 2's release moves the phase to `execute` before the guard drops, and re-engaging the guard mid-`execute` for supervision never tombstones anything.

A fresh plan-mode activation (`shift+tab` / `/plan` / `/plan-guard on` / `--plan`, with no grace already pending) always starts clean: any tombstone left behind by a killed process is purged unconditionally, and if `active.txt` itself still points at a goal stuck mid-planning with no tombstone at all — killed before a grace was ever armed — that goal is discarded too. `active.txt` is the only resume path: the old newest-mtime fallback is gone, so a purged or orphaned goal directory is inert (it's still listed by `plan_recall`/`goalSummaries`/`plan_exit`'s dialog, but nothing resumes it). Durable approved copies are never touched by any of this.

> **Caveat:** two concurrent pi sessions planning in the same repo share this store — the fresh-activation sweep in one session can discard the other session's still-in-planning goal. Out of scope for now; avoid running two concurrent plan-mode sessions against the same repo.

Once a plan clears Gate 2 (`review_final`'s "Start implementation"), a durable copy is written outside the ephemeral store too, under pi's agent directory: `smart-plan/approved/<repo>/<goal>/plan.md` — it survives reboots, unlike the working copy above.

`<tmpdir>` respects `TMPDIR` (`/tmp` on macOS/Linux); `<repo>` is derived from the working directory, `<goal>` is the kebab-case slug. `plan_recall` lists exactly the active + done goals. Re-opening a completed goal happens automatically on the next `plan_save`, which moves it back to active. Never read the store with `read`/`bash` — use `plan_recall`.

> **Ephemerality:** the working store (plan/journal/phase.txt) does not survive a reboot (and macOS may clean untouched /tmp files after ~3 days). The durable approved copy under pi's agent dir is the only part that persists. Cross-session history of in-progress goals is intentionally out of scope.

> **Legacy note:** repos that already use an in-repo `backlog/` directory are not migrated; that directory and its history stay untouched.

## Plan mode behavior

While the guard is active:

- `edit`/`write` and interactive chrome tools are removed from the active tool set (and re-blocked at call time as a backstop). `subagent`/`subagent_wait` ARE allowed but are exploration-only: spawned children inherit the guard via `PI_SMART_PLAN=1` in their env and self-restrict to reading, read-only bash, web research and nested subagent spawn — no phase machine, no planning-store tools.
- bash runs only allowlisted read-only commands (`ls`, `rg`, `cat`, `git status/diff/log`, …). Anything unknown — interpreters, script runners, package managers, `npm test`/`npm run` (scripts can write) — is blocked; harmless noise redirects (`2>&1`, `>/dev/null`) are still accepted. The allowlist lives in `src/bash-guard.ts`.
- A TUI widget shows the phase pipeline (gray → orange heat bar), context-usage percentage, each goal's progress and ready frontier while planning/executing.
- Closing a task mechanically verifies changed files against its `owns` and enforces dependency order — violations reject the close and land in the journal.
- Only `review_hld` and `review_final` open an owner-facing gate — the harness opens it automatically the instant `plan_advance` reaches (or re-enters) that phase; the agent never invents its own approval wording or opens the form itself. Only `review_final`'s "Start implementation" releases the guard, in the same click — no second dialog — and queues the authorization briefing for a fresh turn. Every other transition is a self-advance the agent drives itself.
- Exiting outside the gate flow requires a user-confirmed `plan_exit` dialog — which shows the active plans (or warns when none was saved) so the decision is informed — or `/plan-guard off`, or toggling `shift+tab` again.
- **Exiting mid-planning discards the plan after a 10-second grace, not immediately**: toggling off (`shift+tab`, `/plan-guard off`, `plan_exit`) while the active goal is still anywhere before `execute` tombstones it and warns you in chat that it will be discarded; re-enabling plan mode within the grace restores it (with a "plan kept" notify). Goals already in `execute` are exempt — Gate 2's release and any later guard re-engagement for supervision never discard anything. A fresh plan-mode activation always starts clean, purging any leftover tombstone or stale mid-planning pointer first — see [Artifacts layout](#artifacts-layout).

### Combining with pi-permission-system

If you use `@gotgenes/pi-permission-system`, this extension's enforcement is independent (tool removal + allowlist), so nothing breaks either way. For extra depth you can manually keep restrictive rules in its config during planning; automatic policy flipping is not possible without an upstream API.

## Commit policy (default)

Exactly one agent commit per goal — the final delivery commit (code + repo changes only, since plan/journal live outside the repo). There is **no approval commit**. Never push, never publish. Users who want different behavior should say so explicitly.

## Permissions

If you use `@gotgenes/pi-permission-system` (default `*` = ask), allow the extension tools or every call pauses on a y/n prompt:

```json
"ask_smart_plan": "allow",
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

The extension cannot flip that policy for you.

## Requirements

- pi 0.84.2+

## License

MIT
