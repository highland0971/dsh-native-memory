# dsh-native-memory

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打造的**原生、按工作区隔离的长期记忆**：事实与档案存放在 harness 自带的 storage-domain 上，跨会话回忆走 session-query 全文检索，**写入必须经人工审批**，且每条记忆都带来源引用——不需要外部服务器，不引入额外运行时依赖。

> ⚠️ 安装插件即在本机以你的权限运行第三方代码。安装前请审阅源码（[`src/`](src)）与[安全模型](docs/security.md)。

## 与其他方案的对比

| | dsh-hermes-memory | dsh-native-memory |
|---|---|---|
| 存储 | `~/.dsh/settings.yaml` 命名空间 | 独立 storage-domain 单元（`~/.dsh/storages/dsh_memory.json`） |
| 作用域 | 用户全局、跨项目混用 | **按工作区隔离**（精确 cwd 授权） |
| 写入安全 | 模型静默写入 | **人工审批门 + 会话日志审计** |
| 回忆方式 | 全部常驻注入（硬上限） | 有界常驻档案 **加** 按需召回 + 历史会话全文检索 |
| 依赖 | 需把文件塞进 harness checkout 用相对导入 | 仅 zod + harness 本身 |

完整架构与竞品分析见 [docs/design.md](docs/design.md)。

## 安装

```sh
dsh plugin --profile web add dsh-native-memory   # 发布后从 npm 安装
dsh plugin --profile web add /path/to/this/repo  # 从本地检出安装
```

重启 `dsh web`。插件会开启 session-query 全文检索，并为所有会话注册记忆工具。配置方法见 [docs/install.md](docs/install.md)。

## 工具

| 工具 | 类型 | 审批 |
|---|---|---|
| `memory_remember` | 在本工作区新增/更新一条事实（默认拒存密钥形态文本） | 需要 |
| `memory_edit` | 替换一条事实 | 需要 |
| `memory_forget` | 归档一条事实（软删除） | 需要 |
| `memory_recall` | 确定性三档关键词扫描（标签 > 文本 > 模糊；档内按新鲜度/访问频次决胜） | 不需要 |
| `memory_search` | 全文检索本工作区的历史会话（排除当前会话） | 不需要 |
| `memory_expand` | 把事实引用展开回原始日志摘录 | 不需要 |
| `memory_consolidate` | 近重复合并建议 + 容量预算 | 不需要 |
| `memory_import` | 从历史会话日志导入候选事实 | 需要（逐条） |
| `memory_profile` | 读取常驻注入的工作区档案 | 不需要 |

每条事实都记录来源 `(sessionId, seq)`——记忆始终可从无损会话日志还原。

写入默认拒绝密钥形态文本（token / 密钥 / 密码）；bundle patch 里 `secretPolicy: "mask" | "off"`
可放宽。凭据赋值检测可能误伤 ≥16 字符的良性 `token: …` 值。注入与工具输出恒打码。

浏览器只读页面（设置 → 记忆）列出所有工作区的事实（密钥已打码）；删除会复制为一条
`memory_forget` 指令，在对话中经审批门执行。

可选会话末提议（`proposeOnSessionEnd: true`）：一次廉价 LLM 调用把结束的会话蒸馏为候选事实，
在后续会话中展示；只有经审批门 `memory_remember` 才会成为事实。

压缩漂移护栏（`compactionGuard: true`，默认开启）：压缩摘要丢掉的字面锚点会在后续会话中
作为待核实数据浮现——确定性、零 LLM。

## 开发

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

新贡献者从 [docs/handoff.md](docs/handoff.md) 与 [docs/contributing.md](docs/contributing.md) 开始。

## 许可证

[MIT](LICENSE)
