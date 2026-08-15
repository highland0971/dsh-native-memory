# AGENTS.md — dsh-native-memory 开发约定

Agent 在本仓库工作时的强制工作流,适用于所有迭代(v0.2.0 起)。

## 1. 一切变更走 GitHub issue/milestone/PR

- 每个改动先有 issue(标题 = 目标,正文 = 问题/方案/验收标准),并挂在当前
  milestone(如 v0.2.0,`/milestones/1`)下;
- 一个 issue = 一条分支(`issue-N-slug`)= 一个 PR = squash 合入 `main`;
- 开工前先把 issue 拖到 In Progress(或直接开分支并在 PR 里写明 `Closes #N`);
- 禁止绕过:直接 push main 的改动必须先补 issue。

## 2. 本地开发循环

```sh
git checkout main && git pull            # 拉最新
git checkout -b issue-N-slug             # 一条分支一个 issue
# 实现 + 测试:
pnpm test && pnpm typecheck && pnpm lint && pnpm build
git commit -m "feat/fix(scope): … (Closes #N)"
git push -u origin issue-N-slug          # 推送(见 §4 凭据)
# 然后开 PR:POST /repos/highland0971/dsh-native-memory/pulls
#   {"title": "...", "head": "issue-N-slug", "base": "main", "body": "Closes #N"}
```

**强制审查门(2026-08-15 起)**:每个 PR 在合入前必须经过两道门,缺一不可:

1. **独立子代理审查** — 派一个全新上下文的 subagent(不得 fork 复用本会话
   记忆),按 `docs/review-prompt.md` 模板审查该 PR:对照真实 harness API
   契约(`/opt/dsh-src` 内 file:line)、跑 `pnpm typecheck && pnpm lint && pnpm test`
   (本地 store)、检查授权/审批/安全逻辑未被削弱,输出
   `APPROVE` 或 `REQUEST_CHANGES`。REQUEST_CHANGES → 同分支修复后**重新审查**,
   不得合入。审查是提交者之外的第二人意见 — 提交者的自述不可替代。
2. **CI 绿** — 与审查并行等待;两门全过才 squash 合入:
   `PATCH /repos/…/pulls/<n>/merge {"merge_method":"squash"}`。

## 3. 环境事实(本机 DSH 沙箱)

- 沙箱 workspace-write:写 `~/.dsh` 需 `danger-full-access` 升级(带一句理由);
- pnpm/npm 用 workspace 本地 store:`--store-dir ./.pnpm-store
  --cache-dir ./.pnpm-cache`(npm 用 `--cache ./.npm-cache`);
- `/tmp` 在两次 bash 调用之间不保留,临时产物放仓库内 `.tmp/`(已 gitignore);
- github.com git 端口会间歇性不可用:push/fetch 加 3 次重试;仍不可用则用
  GitHub Contents API 提交文件(见 dsh-plugin-release 技能 §2);
- GitHub API 会间歇性返回假 401("Bad credentials"),重试即好。

## 4. 凭据与推送

- GitHub token 在 `/home/dsh/.dsh/release/gh-token`(600 权限,勿打印);
- push 用 askpass 注入,不要把 token 放进 argv / remote URL / .git/config:

```sh
printf '#!/bin/sh\ncase "$1" in\n  Username*) echo "highland0971" ;;\n  Password*) cat /home/dsh/.dsh/release/gh-token ;;\nesac\n' > .tmp/gh-askpass.sh
chmod +x .tmp/gh-askpass.sh
GIT_ASKPASS=$PWD/.tmp/gh-askpass.sh GIT_TERMINAL_PROMPT=0 git push -u origin issue-N-slug
rm .tmp/gh-askpass.sh
```

## 5. 发布

- 版本发布走 `dsh-plugin-release` 技能(本仓库 `.dsh/skills/` 与
  `~/.dsh/skills/` 双份);
- 发布前:CHANGELOG 更新 → tag → CI 绿 → npm publish → 更新 awesome 列表
  (v0.2.0 起是既有条目版本号/描述更新,不需新 PR 条目)。
