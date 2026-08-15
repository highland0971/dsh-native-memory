# Contributing

DeepSeek Harness currently accepts no external PRs into the core repository —
the sanctioned way to contribute is the ecosystem (see their CONTRIBUTING.md).
For this project that means:

1. **Code contributions**: PRs to this repository. Keep the architecture
   contract in `docs/design.md` truthful: any API dependency must cite its
   `file:line` in a tested deepseek-harness revision.
2. **New capabilities**: follow the existing pattern — typed domain wrapper
   in `src/`, tools registered in `src/tools.ts`, caps in `src/config.ts`,
   tests under `tests/`, docs in `docs/`.
3. **Releases**: bump `CHANGELOG.md`, `npm publish`, then update the
   awesome-dsh-plugin listing (one line in both `README.md` and
   `README.zh.md` of that repo).

## Repo conventions

- Plain TypeScript, ESM, built with tsdown into `lib/` (not committed).
- Zod v4 for all runtime schemas (matches the harness).
- Tests with vitest; the memory backend is mocked with the same in-memory
  pattern the harness itself uses (`packages/storage/storage-domain/tests`).
- Two languages for user-facing docs: English primary, `README.zh.md` mirror.
- MIT license; DCO-free, sign-off style not required.

## Verification checklist before any release

```sh
pnpm install && pnpm build && pnpm typecheck && pnpm test && npm pack --dry-run
```

plus the full local verification loop in `docs/handoff.md` §6 on a real
deployment.
