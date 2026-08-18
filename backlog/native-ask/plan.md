# Plan: native-ask

## Scope

Add a first-party `ask` tool to `pi-smart-plan` so the package has zero third-party extension dependencies. Sequential native dialogs (`ctx.ui.select` + `ctx.ui.input`): 1–4 questions per call, 2–4 options, descriptions inlined in the option label, optional Other, multi-select as repeated pick until "Done". Escape/cancel returns `declined` and does not abort the turn. Update the bundled skill and README to use `ask` instead of `ask_user_question`. LuoAndOrder stays installed locally (no uninstall).

## Non-goals

- No timeout, overlay, per-question notes, remote options, date picker, side preview.
- No copy from LuoAndOrder source.
- No tool named `ask_user_question` (no collision).
- No extra npm dependencies.
- No uninstall of LuoAndOrder.

## DoD

tsc -p /tmp/plan-guard-tsconfig/tsconfig-smart-plan.json   # exit 0
cd /Users/jnardiello/workspace/jacopo/pi-smart-plan && npm pack --dry-run   # includes index.ts + skills/plan/SKILL.md
rg -n 'ask_user_question' skills/plan/SKILL.md              # no matches

Manual (user, after /reload): an `ask` call; Escape declines without killing the turn.

## Tasks

- [ ] T1: register `ask` in index.ts
  deps: []
  owns: [index.ts]
  done: tsc -p /tmp/plan-guard-tsconfig/tsconfig-smart-plan.json → exit 0
- [ ] T2: point the plan skill at `ask`
  deps: []
  owns: [skills/plan/SKILL.md]
  done: rg -n 'ask_user_question' skills/plan/SKILL.md → no matches
- [ ] T3: document `ask` in README
  deps: []
  owns: [README.md]
  done: rg -n '`ask`' README.md → ≥1
- [ ] T4: root verification of DoD commands
  deps: [T1, T2, T3]
  owns: []
  done: the three DoD commands above all green

### `ask` contract (source of truth for T1–T3)

```
parameters:
  questions: 1–4 of {
    question: string
    header?: string
    multiSelect?: boolean
    options: 2–4 of { label: string, description?: string }
  }

execute:
  if !ctx.hasUI → text "No interactive UI; ask in prose." + details: { ui: false }
  for each question:
    labels = "label — description" (skip suffix if no description)
    single: select([labels..., "Other…"]); Other → input; cancel → stop
    multi: loop select([unpicked..., "Other…", "Done"]); Done ends the question
    cancel/undefined → return declined, do not ctx.abort()
  return content "Q: …\nA: …" per answer
          details: { answers: { [question]: string | string[] }, declined?: true }
```

## Review — waves (derived)

Wave 1: T1 + T2 + T3 (parallel, disjoint owns)
Wave 2: T4 (root)
