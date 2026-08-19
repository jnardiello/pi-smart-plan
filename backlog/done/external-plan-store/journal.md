# Journal: external-plan-store

2026-08-19 — Goal opened. Driver: worker wedge del 2026-08-18 (permission ask su /tmp da worker headless) + volontà di zero footprint nel repo. Decisione chiave: storage esterno `~/.pi/agent/smart-plan/<repo-slug>/<goal>/` con I/O solo via tool dedicati dell'estensione, così nessuna permission extension vede i write del piano. Guard ridotto a blocco secco edit/write. Rehydration esplicita via plan_recall. Ultimo goal pianificato in backlog/ in-repo (convenzione morente con questo redesign).

2026-08-19 — Delivery. T1–T4 + rework review (reopen su journal_append, slug done riservato, sanitizzazione errori, listing per-entry) + custom message renderer per /plan (solo riga goal in UI) + fix prompt plan_enter ridondante. DoD: 3 build bun verdi, npm pack ok, test manuale utente in sessione. Goal chiuso.
