---
name: dsh-plugin-release
description: Publish a DeepSeek Harness plugin to npm and GitHub, then list it in awesome-dsh-plugin — token setup, repo creation, push/tag/CI, npm publish, and the PR, including the pitfalls that actually bite.
whenToUse: Releasing any dsh plugin (first publish or a new version), opening or updating an awesome-dsh-plugin PR, or debugging npm/GitHub token authentication during a release.
---

# dsh-plugin-release — 发布 DeepSeek Harness 插件

Distilled from the real v0.1.0 release of `dsh-native-memory` (2026-08-15): every
step below ran in a DSH sandbox (workspace-write file policy, ask approval,
ephemeral /tmp per shell) against live npm + GitHub. Follow in order.

## 0. Preconditions — collect from the user first

- **npm**: account username; whether the package name is free (`npm view <name>`
  → E404 means free).
- **GitHub**: repo owner (org or username), visibility, whether the repo
  already exists.
- **Credentials**: ask the user to put tokens in files OUTSIDE the session log,
  e.g. `~/.dsh/release/{npm-token,gh-token}`, `chmod 600`, owned by the session
  user. Never ask for tokens in chat; never `cat` them into the transcript;
  when debugging, print only lengths/hashes/character classes.
- **Repository field**: fix `package.json` → `repository.url` to the REAL
  target repo and re-tag (`git tag -f v0.1.0`) BEFORE pushing — the tag must
  point at the final state.

## 1. Token facts (as of 2026-08)

- **npm: only Granular tokens exist** (Legacy/Automation removed 2025-11).
  For first publish of a NEW package name, a token scoped to that package
  cannot work (the package does not exist yet) — use a token with
  "All packages", Read and write, optionally Bypass 2FA. Bypass-2FA tokens
  still work for direct publishing, not for account-identity actions.
- **GitHub: classic PAT** (`ghp_…`, 40 chars) with `repo` scope covers
  create-repo, push, topics, fork, PR. Fine-grained `github_pat_…` (~93 chars)
  works too but needs repo-scoped permissions.
- Verify both BEFORE using: `curl -H "Authorization: Bearer <gh>" api.github.com/user`
  must return the login JSON; npm: `npm whoami --userconfig <file>` must print
  the username.
- **Stale-copy trap**: a token that fails 401/Bad credentials/ENEEDAUTH while
  its twin copy works elsewhere usually means the local copy is outdated —
  re-copy and compare `md5sum` before blaming the token type.

## 2. GitHub repo + push + tag

```sh
# create public repo (retry up to 3x — GitHub intermittently answers
# 401 "Bad credentials" to valid tokens; a retry succeeds)
GH_TOKEN="$(cat ~/.dsh/release/gh-token)"
curl -X POST https://api.github.com/user/repos \
  -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"name":"<repo>","description":"…","homepage":"https://www.npmjs.com/package/<pkg>","public":true}'
```

Push WITHOUT putting the token in argv, the remote URL, or .git/config — an
askpass helper reads it per prompt:

```sh
# .tmp/gh-askpass.sh  (gitignored; delete afterwards)
#   #!/bin/sh
#   case "$1" in Username*) echo "<user>";; Password*) cat ~/.dsh/release/gh-token;; esac
git remote add origin https://github.com/<owner>/<repo>.git
GIT_ASKPASS=$PWD/.tmp/gh-askpass.sh GIT_TERMINAL_PROMPT=0 git push -u origin main --tags
```

- Topics: `PUT /repos/<owner>/<repo>/topics` with `{"names":["dsh-plugin", …]}`.
- CI: poll `GET /repos/<owner>/<repo>/actions/runs` until `status: completed`
  and `conclusion: success` before publishing.
- **Fallback when git push hangs** (flaky egress): drive the GitHub API
  instead — create branch via `POST /repos/…/git/refs` (refs/heads/x → main
  sha), commit files via `PUT /repos/…/contents/<file>` (Contents API, body
  written to a file or python-urllib — inline `-d` hits "Argument list too
  long" for 100KB payloads).

## 3. npm publish

- `prepublishOnly` should run build+tests (the harness pattern).
- **Auth channel that actually works**: a userconfig FILE, not env vars.
  npm (9.x) ignores `npm_config_//registry.npmjs.org/:_authToken` entirely,
  and `npm whoami` can LIE via a warm cache — validate with a fresh cache
  (`--cache /tmp/fresh`) or `npm config get '//registry.npmjs.org/:_authToken'`.
  If publish says ENEEDAUTH while whoami "works", the cache is the illusion.

```sh
umask 077
printf '//registry.npmjs.org/:_authToken=%s\n' "$(cat ~/.dsh/release/npm-token)" > .tmp/release-npmrc
npm publish --access public --userconfig ./.tmp/release-npmrc
rm .tmp/release-npmrc   # immediately
```

- Verify: `npm view <pkg> name version dist-tags` and a clean-room install:
  `dsh plugin --profile scratch add <pkg>` in a throwaway `DSH_HOME`.

## 4. awesome-dsh-plugin PR

Repo: `awesome-dsh-plugin/awesome-dsh-plugin` (branch `main`). One line under
the matching category in BOTH `README.md` and `README.zh.md`, format
`- [owner/repo](link) — one-line description`. Your repo must carry the
`dsh-plugin` topic first.

```sh
# fork:  POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks
# clone the fork, add the two lines at the END of the category section,
# commit on branch add-<pkg>; push (askpass) — or Contents API fallback:
#   POST /repos/<you>/awesome-dsh-plugin/git/refs        (create branch)
#   PUT  /repos/<you>/awesome-dsh-plugin/contents/<file> (README.md, README.zh.md)
# open PR: POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls
#   {"title":"Add <pkg> to <Category>","head":"<you>:add-<pkg>","base":"main","body":"…"}
```

Check the PR diff (`pulls/<n>/files`) that both entries land in the right
section with the right format.

## 5. DSH-sandbox survival notes

- Package managers need workspace-local stores:
  `--store-dir ./.pnpm-store --cache-dir ./.pnpm-cache` (pnpm) /
  `--cache ./.npm-cache` (npm).
- Writes to `~/.dsh` are denied by the workspace-write policy — the sanctioned
  path is ONE retry with `sandbox_permissions: danger-full-access` +
  a one-sentence justification (user approves).
- `/tmp` is ephemeral BETWEEN bash tool calls — never stage files there across
  calls; stage in the workspace under a gitignored `.tmp/`.
- Network to github.com/npmjs is intermittently flaky: wrap every remote
  mutation in a small retry loop (3 attempts, 3–5s backoff) and never treat a
  single 401/timeout as conclusive.
- Secret hygiene: tokens only in `~/.dsh/release/` (600) + transient
  gitignored helper files; delete every helper at the end; advise the user to
  revoke the npm token after publish.

## 6. Done-when checklist

1. `npm view <pkg>` shows the version + `latest` tag; clean-room `dsh plugin add <pkg>` succeeds.
2. GitHub: repo public, `main` + version tag pushed, CI green, topics set.
3. awesome PR open with verified diff in both READMEs.
4. No token-bearing temp files remain; `git status` clean.
