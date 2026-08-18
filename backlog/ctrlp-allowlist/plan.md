# Plan: ctrlp-allowlist

## Scope

1. ctrl+p when turning the guard ON behaves like `/plan` with an empty goal: persist PLAN, notify, inject `planUserMessage("")` via `sendUserMessage` (followUp if the agent is busy). Turning OFF only releases the guard (no extra message).
2. This machine: allow `plan_enter`, `plan_exit`, `ask_smart_plan` in `~/.pi/agent/extensions/pi-permission-system/config.json`. README lists those three allows for other permission-system users.

## Non-goals

- No fork/authorizer in the permission-system.
- No push.

## DoD

tsc -p /tmp/plan-guard-tsconfig/tsconfig-smart-plan.json
cd /Users/jnardiello/workspace/jacopo/pi-smart-plan && npm pack --dry-run
rg -n '"plan_enter"|"plan_exit"|"ask_smart_plan"' ~/.pi/agent/extensions/pi-permission-system/config.json
rg -n 'sendUserMessage|planUserMessage' /Users/jnardiello/workspace/jacopo/pi-smart-plan/index.ts

Manual: /reload — ctrl+p starts planning; ask_smart_plan does not prompt y/n.

## Tasks

- [ ] T1: ctrl+p ON injects planUserMessage
  deps: []
  owns: [index.ts]
  done: shortcut ON path calls sendUserMessage(planUserMessage("")); tsc exit 0
- [ ] T2: allowlist + README
  deps: []
  owns: [/Users/jnardiello/.pi/agent/extensions/pi-permission-system/config.json, README.md]
  done: three tools allow; README has the snippet
- [ ] T3: root DoD
  deps: [T1, T2]
  owns: []
  done: DoD commands green

## Review — waves (derived)

Wave 1: T1 + T2
Wave 2: T3
