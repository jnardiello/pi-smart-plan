# Plan: ask-briefing

## Scope

Right column of `ask_smart_plan` becomes a human briefing pane, not a leftover preview scrap.

- Per question: required-in-skill field `detail` — plain-language paragraph(s): why this decision, what is already true, what is at stake. No jargon without a one-line gloss. No assumed context from earlier turns.
- Per selected option: a block under that briefing from `preview` (fallback: `description`) — consequences of *this* choice.
- If the combined text is taller than the pane, it scrolls (PgUp/PgDn or J/K). Arrow keys stay on the option list.
- No markdown rendering. Wrapped text only.
- Skill updated so the model must fill `detail` and per-option `preview` before calling the tool.

## Non-goals

- No rich markdown (bold/lists/code/tables).
- No change to the left list layout (tabs, highlight, inline editor stay).
- No LuoAndOrder code.

## DoD

tsc -p /tmp/plan-guard-tsconfig/tsconfig-smart-plan.json
cd /Users/jnardiello/workspace/jacopo/pi-smart-plan && npm pack --dry-run
rg -n 'detail' skills/plan/SKILL.md src/ask-form.ts index.ts

Manual after /reload: one ask_smart_plan with a long `detail` — pane readable, scrolls, option block updates on ↑↓.

## Tasks

- [x] T1: briefing pane + scroll in src/ask-form.ts
  deps: []
  owns: [src/ask-form.ts]
  done: detail+option block rendered; J/K or PgUp/PgDn scroll; tsc exit 0
- [x] T2: schema detail on questions in index.ts
  deps: [T1]
  owns: [index.ts]
  done: Type.Optional detail on question; passed through to runAskForm; tsc exit 0
- [x] T3: skill + README — model must write detail/preview for humans
  deps: []
  owns: [skills/plan/SKILL.md, README.md]
  done: rg detail in SKILL.md ≥1; README mentions briefing pane
- [x] T4: root DoD
  deps: [T1, T2, T3]
  owns: []
  done: three DoD commands green

## Review — waves (derived)

Wave 1: T1 + T3
Wave 2: T2
Wave 3: T4
