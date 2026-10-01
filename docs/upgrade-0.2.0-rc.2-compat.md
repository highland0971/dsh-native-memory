# 0.2.0-rc.2 兼容性背景资料：memory_* 工具全线不可用

> 来源：2026-10-02 环境自检发现（环境已由外部 Agent 就地升级到 0.2.0-rc.2）。
> 状态：issue #39 已建，修复在本分支实现（`tools.ts` / `guard.ts` / `propose.ts`
> + 回归用例）。本文档保留为**证据链与契约对照**，供审查对照真实 harness 源码。

## 0. 一句话

插件用 `session.events` 读会话事件，但该访问器在 0.2.0-rc.2（以及 0.1.5-rc.2）的 `Session` 类上**根本不存在** → 所有 `memory_*` 工具在解析调用者上下文时抛 `TypeError`，记忆功能整体停摆。

## 1. 现象与复现

**现象**（实测于 2026-10-02 00:1x，运行版本 0.2.0-rc.2）：

```
memory_recall      → Error: Cannot read properties of undefined (reading 'length')
memory_profile     → Error: Cannot read properties of undefined (reading 'length')
memory_consolidate → Error: Cannot read properties of undefined (reading 'length')
```

九个工具（remember / edit / forget / recall / search / expand / profile / consolidate / import）全部受影响——它们都先经同一个 `callerOf()` 解析调用者。

**最小复现**：在 Web GUI 的任意会话里调用任一 `memory_*` 工具即可，与记忆库内容无关。

**旁证**：`/home/dsh/.dsh/storages/dsh_memory.json` 的最后写入时间是 **2026-08-15 23:29**（facts 表里只有当时写入的条目），此后没有新增——说明写入路径也已失效一段时间。

## 2. 根因（三处调用点）

`Session` 在 0.2.0-rc.2 的公开访问器只有：
`surface` / `header` / `id` / `seq` / `firstLiveSeq` / `firstLifecycleSeq` / `messageProjections` / `inheritedEventCount`
（证据：`/opt/dsh-src/packages/core/session/src/index.ts:424-500, 662, 681, 931`）

`get events` 在该文件中**无任何匹配**。对照旧树 `/opt/dsh-src.old-0.1.5-rc.2` 同样是 `surface` / `header` / `seq`——**即该访问器在 0.1.5-rc.2 时就已移除**；插件是照 0.1.0-rc.5 时代的文档写的（当时 session README 明确记载 “`session.events` is a cached frozen snapshot invalidated by append”）。

| 位置 | 现有代码 | 后果 |
|---|---|---|
| `src/tools.ts:95` | `seq: agent.session.events.length` | **崩溃**：`events` 为 `undefined` → 读 `.length` 抛错 → 所有工具在 `callerOf()` 挂掉 |
| `src/guard.ts:123` | `const shadowedText = (session.events ?? [])…` | 不崩溃，但 `?? []` 兜底成空集 → **压缩漂移告警永不触发**（静默失效） |
| `src/propose.ts:148` | `const events = session.events ?? []` | 不崩溃，兜底成空集 → **会话结束提议永不产出**（静默失效） |

## 3. 修复方案（逐处，含取舍）

### 3.1 `src/tools.ts:95` —— 一行替换，语义 1:1

```ts
// 现在
return { agent, cwd, sessionId: agent.session.id, seq: agent.session.events.length }
// 改为
return { agent, cwd, sessionId: agent.session.id, seq: agent.session.seq }
```

依据：0.2.0 的 `get seq(): SessionLogOffset` 文档原文 —— *“The next event's sequence number — always the log length (the `seq = log.length` contiguity contract)”*（`packages/core/session/src/index.ts:680-682`）。与 `events.length` **完全等价**，且正是注释里写的语义（“Log position the next event (this tool result) lands at”）。

### 3.2 `src/propose.ts:148` —— 建议改用 `session.deriveMessages()`

0.2.0 仍提供 `Session.deriveMessages(): Message[]`（`packages/core/session/src/index.ts:860`），返回**模型可见消息**。

- 推荐：用它替换 `session.events` 循环，`eventText()` 改为从 `Message` 取文（注意 content block 结构差异）。
- 备选（要保持原始事件保真度）：改用异步 `ctx.sessionQuery`（`listEvents(sessionId)` / `readEvent({sessionId, seq})`）——但 `session/disposed` 回调是 fire-and-forget，异步化可行；需注意 disposal 后日志仍可读（走持久化）。
- ⚠️ `SessionSurface` **不能**替代：它只暴露 `nodes` / `replaceGeneration` / `contentGeneration`，**不含事件正文**（`packages/core/session/src/surface.ts:251-258`）。

### 3.3 `src/guard.ts:123` —— 需要“被压缩遮蔽事件的原文”，需设计决策

当前逻辑：从 `compaction/summary` 事件取 `shadowedSeqs`，再按 seq 找回被遮蔽事件的文本，提取锚点（路径/错误码）判断是否在摘要中消失。

0.2.0 下取得遮蔽正文的三条路：
1. **异步补读**：`ctx.sessionQuery.readEvent({ sessionId, seq })` 逐 seq 读（注意并发/预算；监听体本身已是 fire-and-forget async，可在内部 await）。
2. **事件自携带**：先查 0.2.0 的 `compaction/summary` 负载是否已含遮蔽文本（若无则回到 1）。
3. **降级**：拿不到正文时，显式记录一条 warn 日志并跳过本次校验（**不要静默**——静默正是这次缺陷之所以能潜伏的原因）。

## 3.4 实现期间新发现的两点（已并入修复）

**(a) `compaction/summary.summary` 是 `ContentBlock[]`，不是字符串。**
0.1.5-rc.2 与 0.2.0-rc.2 均为 `ContentBlock[]`
（`packages/compaction/compaction/src/types.ts:37`），而守卫按 `typeof summary !== 'string'`
判断后直接 return —— 这是**第二处静默失效**（即使事件数组可用，守卫也不会触发）。
修复：按块展平取文本（`blocksText()`），并保留"无文本则跳过"的语义。

**(b) `tool-result` 内容块类型已被移除。**
0.1.5-rc.2 的 `ContentBlockMap` 含 `'tool-result'`（旧树 `types.ts:118`），0.2.0-rc.2 已删除
（现为 text / reasoning / image / file / tool-call / tool-addition / tool-removal，
`packages/llm/llm/src/types.ts:137-145`），且会话格式 v4 **硬拒绝**该包装
（`packages/session/session-format-v3-to-v4/src/retired-syntax.ts:6-9`）。
修复：删掉守卫里针对嵌套 `tool-result` 的下降分支（在 v4 下不可达），
测试 mock 同步改为 `tool` 角色消息 + 扁平文本块。

## 4. 已核验为「兼容、无需改动」的邻近契约

修这个 bug 时不必四处改；以下都已逐条对过 0.2.0-rc.2 源码：

| 契约 | 0.2.0 证据 |
|---|---|
| `session/event` 事件（guard 的触发源） | `packages/core/session/src/index.ts:405`（观察者仍以 `(session, event)` 调用） |
| `session/disposed` 事件（propose 的触发源） | 同上 `:65`，发出点 `:1174` |
| `compaction/summary.shadowedSeqs` 字段 | `packages/compaction/compaction/src/invariant.ts:66` |
| `ctx.tools.register` | `ToolDefinition` 仅新增可选 `projectContent`（向后兼容） |
| `ctx.systemPrompt.section` | 未变（`text` 仍支持 provider 函数） |
| `ctx.approval.request` | 未变 |
| `ctx.storageDomain` / storage-domain 包 | 与 0.1.5-rc.2 逐字节 0 差异 |
| `ctx.sessionQuery.searchSessions` 请求体 | `query` / `sessionFilters` / `limit` 全在（`packages/session-query/session-query/src/types.ts:251`） |
| `ctx.llm.prepareCall` + `LlmCallConfig` | `packages/llm/llm/src/call-config.ts:23`（provider/model/maxTokens/temperature 均在） |
| 本 bundle 的 `session-query-sqlite` 覆盖 | 组合中已生效：`openAt: first-search` + 持久索引路径 |

## 5. 影响面小结

- 九个工具全部不可用（读与写都不可用）→ 记忆功能完全停摆。
- 压缩漂移守卫（compactionGuard）与会话结束提议（proposeOnSessionEnd）**静默失效**——比崩溃更危险，建议修复时一并加“能力不可用”的显式日志或自检。
- 已落库的历史 facts 未损坏（`dsh_memory.json` 完好，unit `dsh_memory` v1）。

## 6. 验证方案（修完怎么证明）

```sh
# 1. 静态与单元
cd /home/dsh/projects/dsh-native-memory
pnpm test && pnpm typecheck && pnpm lint && pnpm build \
  # 本机需用仓库本地 store（AGENTS.md §3）：
  #   pnpm --store-dir ./.pnpm-store --cache-dir ./.pnpm-cache <cmd>

# 2. 新增回归用例（建议）
#    - callerOf() 返回的 seq 等于 session.seq
#    - guard/propose 在“对象无 events 访问器”时不抛错，且行为可观测（有日志或明确降级）

# 3. 生效路径：插件以 link: 装入 profile
node -e "console.log(require('/home/dsh/.dsh/profiles/web/package.json').dependencies)"
#    → {"dsh-native-memory": "link:/home/dsh/projects/dsh-native-memory"}
#    构建产物 lib/ 即被引用；重载： sudo systemctl restart dsh-web

# 4. 端到端（本机 0.2.0-rc.2）
#    在 Web GUI 会话里：memory_remember 写一条 → memory_recall 读回 → memory_profile 出档案
#    再触发一次压缩（长会话或 /compact）验证 guard 不再静默

# 5. 组合未漂移
cd /opt/dsh-src && DSH_HOME=/home/dsh/.dsh \
  node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config | grep -A 3 dsh-native-memory
```

## 7. 建议的 issue 草案（符合仓库 AGENTS.md §1 流程）

**标题**：`fix: port session event access to the 0.2.0 API — memory_* tools throw on every call`

**正文要点**：
- 现象：九个 `memory_*` 工具在 0.2.0-rc.2 上全部抛 `Cannot read properties of undefined (reading 'length')`（附三处调用点与实测记录）。
- 根因：`session.events` 访问器不存在（0.1.5-rc.2 起已移除），插件按 0.1.0-rc.5 时代的文档实现；`tools.ts` 未做空值防护导致崩溃，`guard.ts` / `propose.ts` 用 `?? []` 兜底导致静默失效。
- 证据：本文件第 2、4 节的 `file:line` 对照（`/opt/dsh-src` = 0.2.0-rc.2）。
- 方案：`tools.ts` → `session.seq`；`propose.ts` → `session.deriveMessages()`；`guard.ts` → 异步 `sessionQuery` 或显式降级 + 日志。

**验收标准**：
- [ ] 九个工具在 0.2.0-rc.2 实测可用（读+写各一次真实调用）
- [ ] 不再引用已移除的 `session.events`（全仓 grep 0 匹配）
- [ ] guard / propose 若无法取得事件正文，必须留下可观测日志，不得静默
- [ ] `pnpm typecheck && pnpm lint && pnpm test` 绿，CI 绿
- [ ] CHANGELOG 记录“0.2.0-rc.2 兼容性修复”
- [ ] 独立子代理审查输出 `APPROVE`（AGENTS.md §2 门 1）

## 8. 环境与操作事实（本机）

| 项目 | 值 |
|---|---|
| 运行版本 | 0.2.0-rc.2，`/opt/dsh-src`（就地升级，2026-10-02 00:05 重启） |
| 旧版对照树 | `/opt/dsh-src.old-0.1.5-rc.2`（完整可启动，用于比对旧行为/回滚） |
| 服务 | `dsh-web.service`，`DSH_HOME=/home/dsh/.dsh` |
| 重启 | `sudo -n systemctl restart dsh-web`（dsh 已配免密 sudo） |
| 取新 token | `dsh-token`（辅助命令：`dsh-status` / `dsh-logs` / `dsh-version`） |
| 插件安装方式 | profile bundle：`dsh.profile.bundles` 含 `dsh-native-memory`，依赖 `link:/home/dsh/projects/dsh-native-memory` |
| GitHub | `highland0971/dsh-native-memory`，token 在 `/home/dsh/.dsh/release/gh-token` |

## 9. 附：本次自检中的其它观察（与本 issue 无关，供参考）

- 升级后旧实例停止超时被 SIGKILL，其峰值占用 **3.9G 内存 + 1.6G swap**（本机仅 4G 内存）；新实例当前 350MB。长期运行的内存增长值得单独观察。
- 设置迁移已自动完成：`settings.yaml` → `settings.yaml.imported`，可用配置写入 profile patch；`agent-presets` 与 `subagent-model-selection` 两段因改名/移除未导入（原文仍保留在 `.imported`）。
- 自建预设目录已按用户要求删除（备份：`/home/dsh/projects/custom-agent-presets-backup-20261001.tar.gz`）。
