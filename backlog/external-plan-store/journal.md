# Journal: external-plan-store

2026-08-19 — Goal opened. Driver: worker wedge del 2026-08-18 (permission ask su /tmp da worker headless) + volontà di zero footprint nel repo. Decisione chiave: storage esterno `~/.pi/agent/smart-plan/<repo-slug>/<goal>/` con I/O solo via tool dedicati dell'estensione, così nessuna permission extension vede i write del piano. Guard ridotto a blocco secco edit/write. Rehydration esplicita via plan_recall. Ultimo goal pianificato in backlog/ in-repo (convenzione morente con questo redesign).
