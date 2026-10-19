# Contributing

Thanks for helping. Bug reports, fixes and focused features are welcome. For anything large, open an issue first so we can agree on the approach.

## Set up

Requires **Node 22.14+** (`node:sqlite` is used by the tests).

```sh
npm ci
npm run setup   # local D1 migrations + fictional demo data
npm run dev     # http://localhost:8787, no login on localhost
```

## Before you open a pull request

- Run `npm run check` (typecheck + lint + tests). CI runs the same thing and must pass.
- Route changes need a case in `tests/worker.test.ts` covering the happy path **and** a request from another workspace that must 404.
- Keep the PR to one change, and describe what it does and how you tested it.

## Rules the code relies on

[AGENTS.md](AGENTS.md) lists the project's invariants; please read it before changing the API. The short version:

- **Tenant isolation.** Every query touching client data filters on the actor's `org_id`. Load clients through `client(env, actor, id)`.
- **Authorization first.** Call `scope(actor, ...)` or `admin(actor)` at the top of every handler. The author of a change is always the authenticated actor.
- **Validate input with zod** (`.strict()` for writes) and use only bound SQL parameters; no string-built SQL.
- **Idempotent writes.** Writes accept `Idempotency-Key`, and retries (including Queue retries) must not duplicate rows.
- **Auth.** Humans are identified only by a verified Cloudflare Access JWT, or by loopback requests in local mode. Never trust unverified identity headers.
- **Google access is read-only** through the service-account secret. No new scopes or OAuth flows without discussion first.

## Database migrations

Schema changes go in a **new** file in `migrations/` (`NNNN_short_name.sql`). Never edit a migration that has been merged: deployed notebooks have already applied it. Update `fixtures/seed.sql` if the demo data needs the new columns.

## Fixtures and examples

Use fictional names and `example.com`-style domains (`.example`) in tests, fixtures and docs. Never commit real client data, credentials, `.dev.vars`, `.env*` or `wrangler.production.toml`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
