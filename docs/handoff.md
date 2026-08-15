# Handoff — start the development flow here

Prepared 2026-08-15 for a fresh session in this workspace. Read
`docs/design.md` first, then work this list top to bottom.

## What is already done

- Repo scaffolded at this directory, git initialized on `main` (no commits
  yet — make the first commit after step 1).
- Architecture approved and documented: planes, data model, tools, caps,
  security, verified API contracts (each with `file:line` into
  `/opt/dsh-src`), competitive positioning, contribution roadmap.
- Skeleton sources under `src/` with TODO(implement) markers.
- Bundle patch `cordis.patch.yml` written (NOT yet applied to this running
  deployment — see step 6).

## Development order

1. **Lock the toolchain.** `pnpm install` in this repo; confirm `@deepseek-ai/cordis`
   resolves from the npm registry (the peer dep). If the registry does not
   carry it yet, fall back: declare it as a devDependency from
   `github:deepseek-ai/deepseek-harness` or drop the type import and use
   plain JS (hermes precedent). Decide before writing more code.
2. **Implement the domain** (`src/domain.ts`): DomainSpec via `defineDomain` +
   `domainTable`, lazy `open()`, typed wrappers (`remember`, `listActive`,
   `recall`, `archive`, `getProfile`, `putProfile`), exact-cwd authorization
   helper, and the caps from config. Tests first: `tests/domain.spec.ts`
   against an in-memory storage backend (see dsh's own
   `packages/storage/storage-domain/tests/helpers/memory-backend.ts` for the
   pattern).
3. **Implement tools** (`src/tools.ts` + `src/approval.ts`): five tools per
   design §5; the write path routes through the approval gate. Resolve the
   caller agent from `ToolRunContext.exec.agent`. Tests: approval mocked,
   assert ask/apply and fail-closed.
4. **Implement the prompt section** (`src/prompt.ts`): order 88, provider
   form, exact-cwd profile lookup, "untrusted persisted notes" framing.
5. **Build + package check**: `pnpm build`, verify `lib/index.js` and
   `cordis.patch.yml` are in the published file set (`npm pack --dry-run`).
6. **Local verification on this machine** (the deployment at `/opt/dsh-src`,
   web profile, DSH_HOME=/home/dsh/.dsh):
   - `cd /opt/dsh-src && pnpm --dir /home/dsh/.dsh/profiles/web add /home/dsh/projects/dsh-native-memory` — wait: the profile package is managed by
     `dsh plugin add`. Prefer: `node --import tsx/esm apps/cli/src/bin.ts plugin
     --profile web add /home/dsh/projects/dsh-native-memory` from `/opt/dsh-src`
     (path spec installs without publishing).
   - Restart dsh web, start a session, confirm the tool list contains the
     memory tools, then exercise the full loop: remember (approve in UI),
     recall, forget, profile injection visible in a new step.
   - Check `~/.dsh/storages/dsh_memory.json` and
     `~/.dsh/storages/session-search.sqlite` appear.
   - Cross-session test: second session in the same workspace recalls the
     first session's fact; a session in a DIFFERENT workspace must not.
7. **Negative tests**: disable approval answerers (or reject) → write fails
   closed; temporarily set `openAt: never` → `memory_search` reports
   SESSION_QUERY_SEARCH_DISABLED; caps (300 facts, 2000 chars, 8×240)
   enforced with the tool's consolidation guidance.
8. **Docs pass**: README.md / README.zh.md (install, usage, security warning,
   comparison table), CHANGELOG, docs/security.md, docs/contributing.md.
9. **Release**: initial commit, CI green, `npm publish` (access public),
   `dsh-plugin` topic, awesome-dsh-plugin PR (README.md + README.zh.md).

## Environment facts (verified today)

- Harness checkout: `/opt/dsh-src` (deepseek-harness 0.1.0-rc.5 @ 47f9438,
  tsx dev-mode, no dist).
- Web GUI: http://127.0.0.1:3080 — healthy.
- Profile: `web` (bundles: dsh-base + dsh-web-app); storage backend `json`,
  root `~/.dsh/storages`; session-query-sqlite currently
  `path: ':memory:', openAt: never`.
- Sandbox: `workspace-write`, workspace `/home/dsh/projects`; approval: ask.
- Useful references inside the checkout: `packages/storage/storage-domain`,
  `packages/session-query/{session-query-sqlite,tool-session-query}`,
  `packages/interaction/user-approval`, `packages/core/{tools,system-prompt}`,
  `packages/bundle/base/cordis.patch.yml`.

## Definition of done

All of: unit tests green; the 5-step local verification passes on this
machine; both READMEs and security doc complete; npm pack contains the
patch + lib; first git tag v0.1.0.
