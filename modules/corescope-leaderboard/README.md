# CoreScope model leaderboard

This optional module preserves CoreScope's published model rankings while using the
upstream module registry and responsive shell. It registers the existing
`/leaderboard` pages, `/api/site/leaderboard/*` reads, evaluator/provider marks,
sitemap entries, and `leaderboard.round` schedule. The ranking method and saved
run identities are unchanged.

The site enables it in all three registries in `site/modules/`: `index.ts`,
`server.ts`, and `web.ts`. Remove all three entries to hide and stop this feature;
keep its saved tables and publications for later re-enablement. Do not apply a
framework migration that drops the preserved `lb_*` tables or `fx_rates`.

The existing refresh times are 02:05, 08:05, 14:05 and 20:05 in the worker's
configured timezone. Only `COLLECT_ENABLED=true` permits upstream fetches; with
collection off, a round uses the already saved snapshots. The module does not
register Codex reset monitoring or invoke editorial models.

The web process reads the API over HTTP and never reads the database. Reader
components live under `web/`; the existing backend and DTOs remain at
`packages/backend/src/leaderboard/` and `packages/contracts/src/leaderboard.ts`
to keep CoreScope's existing operational scripts and imports compatible.

From the repository root, `npm run build -w @aihot/web` and `npm run test:web`
include the synthetic-HTTP continuity checks in
`apps/web/tests/corescope-continuity.test.ts`. Those checks launch only ephemeral
test servers, cover public page addresses, preserved ranks after filters, and
CoreScope's cross-perspective mobile search, and require Playwright Chromium.
