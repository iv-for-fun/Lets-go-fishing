# Let's Go Fishing

Kid-friendly fishing spot finder — mobile-first, client-side web app (HTML/Tailwind/vanilla JS), hosted on GitHub Pages. See README.md for setup and architecture.

Full product requirements:

@PRD.md

## Keeping docs & issues in sync

- **Docs:** when app behavior changes, update `PRD.md` (and `README.md` if affected) in the *same* change — never defer. `PRD.md` is the living spec of current behavior; `CLAUDE.md` imports it. Design/migration docs under `docs/` are point-in-time records — carry a status header and retire them (mark Completed / move to `docs/archive/`) once their change has shipped.
- **Issues:** keep GitHub issues current — update status and details as work progresses, note decisions in comments, and close issues when the work is done or superseded (link the superseding issue). Don't let stale or contradictory issues accumulate.
