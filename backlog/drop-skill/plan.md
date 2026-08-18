# Plan: drop-skill

## Scope

pi-smart-plan becomes a pi extension only. The planning workflow text (phases 0–5, DAG, discovery, journal, commit policy) moves from `skills/plan/SKILL.md` into `src/prompts.ts` as a string constant. `/plan` and `plan_enter` inject that text (plus the goal) via `sendUserMessage` — no `/skill:plan`, no `expandPromptTemplates`. Remove `skills/`, `pi.skills`, and README/skill mentions. Workflow semantics stay the same; only the delivery channel changes.

## Non-goals

- No rewrite of phases, DAG, discovery, journal, or commit policy.
- No changes to `ask_smart_plan` / form UI.
- No push or npm publish.

## DoD

tsc -p /tmp/plan-guard-tsconfig/tsconfig-smart-plan.json
cd /Users/jnardiello/workspace/jacopo/pi-smart-plan && npm pack --dry-run
# pack listing must NOT include skills/
rg -n 'skill:plan|pi.skills|SKILL.md' index.ts src package.json README.md
# zero matches (except maybe a one-line "this is not a skill" in README)

Manual: /reload then /plan smoke-goal — the first injected turn contains the workflow text, not a missing-skill stub.

## Tasks

- [ ] T1: src/prompts.ts from current SKILL.md
  deps: []
  owns: [src/prompts.ts]
  done: exports PLAN_WORKFLOW (and maybe planUserMessage(goal)); no YAML frontmatter; wording says extension /plan not /skill:plan
- [ ] T2: inject from /plan and plan_enter; drop skill dispatch
  deps: [T1]
  owns: [index.ts]
  done: no /skill:plan, no expandPromptTemplates; sendUserMessage(planUserMessage(goal)); tsc exit 0
- [ ] T3: package.json + delete skills/
  deps: [T2]
  owns: [package.json, skills/plan/SKILL.md]
  done: no pi.skills; git rm skills/; pack has no skills/
- [ ] T4: README — extension only
  deps: []
  owns: [README.md]
  done: no “bundled plan skill”; install/usage describe /plan only
- [ ] T5: root DoD
  deps: [T1, T2, T3, T4]
  owns: []
  done: three DoD commands green

## Review — waves (derived)

Wave 1: T1 + T4
Wave 2: T2
Wave 3: T3
Wave 4: T5
