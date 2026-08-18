# Plan: ask-ux

## Scope

Replace the native `ctx.ui.select` / `ctx.ui.editor` flow of `ask_smart_plan` with one custom TUI form: tabs across the 1–4 questions in a single call, per-option label + description, selected-row highlight, a side preview when an option has `preview` (or the description if no preview field), footer with key hints, and “None of these — I'll specify” switching to an inline editor (not the full-screen `ui.editor`). Escape on the list = declined (no abort). Sequential questions are gone: one overlay, Tab/Shift+Tab between questions, Enter confirms the current question, a final submit when all are answered (or submit-as-you-go on last question). Contract of the tool (`questions[]`, `details.answers` / `declined` / `ui:false`) stays.

## Non-goals

- No copy from LuoAndOrder source (write against official `question.ts` / `questionnaire.ts` + pi-tui).
- No restyle of `plan_exit` / `confirm` / `/plan-guard`.
- No new npm dependencies (use `@earendil-works/pi-tui` peer).
- Multi-select stays checkbox-in-list if cheap inside the same component; no separate Done-loop dialog.

## DoD

tsc -p /tmp/plan-guard-tsconfig/tsconfig-smart-plan.json   # update include if src/ is added; exit 0
cd /Users/jnardiello/workspace/jacopo/pi-smart-plan && npm pack --dry-run   # includes the new UI file(s)

Manual (user, after /reload): one `ask_smart_plan` call with 2 questions — tabs work, preview visible, custom note inline, Escape declines without killing the turn.

## Tasks

- [ ] T1: custom form component
  deps: []
  owns: [src/ask-form.ts]
  done: file exports a function `runAskForm(ctx, questions) => Promise<AskResult>` using `ctx.ui.custom`; tsc of that file in the package tsconfig exits 0
- [ ] T2: wire ask_smart_plan + package files
  deps: [T1]
  owns: [index.ts, package.json]
  done: index.ts has no `ui.select` / `ui.editor` in the ask path; package.json `files` includes `src`; tsc whole package exit 0
- [ ] T3: README — describe the form (tabs, preview, inline note)
  deps: []
  owns: [README.md]
  done: rg -n 'tab|preview|inline' README.md → ≥1
- [ ] T4: root DoD
  deps: [T1, T2, T3]
  owns: []
  done: tsc + npm pack --dry-run green

## Review — waves (derived)

Wave 1: T1 + T3 (parallel)
Wave 2: T2 (after T1)
Wave 3: T4 (root)
