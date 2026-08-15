# dsh-memory 生态全景分析 — 28 个社区候选 vs dsh-native-memory

> 分析日期:2026-08。数据来源:awesome-dsh-plugin README Memory 分类(2026-08-15 抓取)+ 5 个独立
> 子代理逐仓库源码级核查(GitHub API 取源码,非 README 转述;无法代码级验证的宣称已标 UNVERIFIED)。
> 结论催生了 v0.3.0 milestone(#2)的 issue #20–#26,映射关系见文末。

## 0. 结论速览

- 生态已分层:全自动 + 语义召回 + UI 是主流(约 2/3 候选),「审批门 + 零 LLM + harness 原生」是少数派。
  28 个候选中,**只有 dsh-memento 与本仓库同守「人工审批写入」**,**只有 flymysql/dsh-memory 与本仓库同用
  storage-domain 存储**;二者不兼得。本仓库的生态位 = 原生接缝 + 审批门 + 零成本确定性,独树一帜且被侧面验证。
- 最被认可的差异化:审批门(几乎独有)、零 LLM(约半数候选烧 LLM)、无外部服务(6 家依赖外部后端)、
  per-workspace 隔离(多数候选是全局甚至明文文件)。
- 本仓库缺、社区普遍有的缺口(按价值排序):① 引用→原文无损升级;② 召回新鲜度/访问频次信号;
  ③ secret 红action;④ 只读 UI;⑤ 会话末自动沉淀(提议式);⑥ compaction 漂移护栏;⑦ 人工可读导出镜像。
- 明确不学:外部服务/CLI 硬依赖、云 embedding 密钥、每轮 LLM 成本、无门控全自动写、全局明文文件
  (部分候选连默认路径都是 Windows 硬编码)。

## 1. 全景矩阵(28 候选 + 本仓库 × 8 轴)

图例 — 存储: SD=harness storage-domain · SQLite=自建 · FTS=复用官方会话 FTS5 · JSON · MD · EXT=外部服务 · —=无
门控: A=人工审批 · D=直写/自动 · R=只读 · U=使用门控
召回: T3=三档评分 · SUB=子串 · FTS5 · BM25 · EMB=向量 · LLM · LEX=字典序 · 锚点=检测
注入: SP=systemPrompt 段 · PS=agent/pre-step · FUM=首条用户消息 · —=无(pull)
自动化: — · TE=turn-end · SE=session-end · CON=consolidate/蒸馏 · FL=反馈学习 · REF=反思 · EV=事件钩子
LLM: 0=零 · 1=低频 · H=高频 · S=成本外移服务端
作用域: S=单会话 · W=workspace · P=project/分支 · G=全局 · X=跨 agent 共享

| 组件 | 存储 | 门控 | 召回 | 注入 | 自动化 | LLM | UI | 作用域 |
|---|---|---|---|---|---|---|---|---|
| **dsh-native-memory(本仓库)** | **SD** | **A** | **T3+CJK bigram** | **SP 88 常驻 profile** | **—(刻意 defer)** | **0** | **—** | **W** |
| omdsh-dev/dsh-mnemon | EXT(Go CLI) | D | LLM+EMB | SP 145/150 | 后台 review | H | 侧栏 | X |
| jiayan-xu/dsh-memoria | EXT(Rust :9003) | D | EMB+图(服务端) | — | TE·observe | S | — | G |
| jiayan-xu/dsh-memoria-extra | EXT(同 memoria) | R | 图/实体 | — | — | S | — | G |
| freehul/sgme | EXT(Py+SQLite) | D | EMB+RRF | PS(占位未接) | TE→L0→L2 蒸馏 | H | — | X |
| Yiipu/dsh-agentmemory | EXT(Node :3111) | D | BM25+向量+图 | PS 6k/3k | 会话镜像+压缩前重注入 | S | — | G |
| nowledge-mem | EXT(nmem+MCP) | D | 服务端 | PS 12k/8k | TE 导入 | S | — | G/X |
| modusensus/dsh-mneme | SQLite+MD 镜像 | D | SUB+可选 EMB | SP 90/85 | autoDream+摘要 | H | 面板 | G |
| PerryLink/dsh-memento | SQLite(node:) | **A** | SUB+recall_count | SP -50 冻结快照 | 压缩→proposal 待批 | 0 | 抽屉(只读) | W/G 双轨 |
| GIT121995/dsh-memory-gate | SQLite+FTS5 | D/U | FTS5+置信度 | PS 3 条/1200 字 | 提取+反馈学习 | 0 | — | G/W |
| truelove-dreamer/dsh-plugin-recall | —(官方 FTS5) | R | FTS5 字面短语 | — | — | 0 | — | G |
| forge-memory | JSON | R | BM25+fresh | — | — | 0 | — | G |
| yangyongzhen/dsh-memory | JSON | D | SUB AND | PS 4k 字节 | — | 0 | — | W+G |
| Jesse-njx/dsh-memory | MD | D | LEX(索引名) | SP 60(800tok) | SE 蒸馏 | 1 | CLI+/memory | P+_user |
| flymysql/dsh-memory | **SD(同本仓库)** | D | tag×2/SUB×1 | SP 90(最近 8 条) | — | 0 | 设置页 | W |
| ICCuse/dsh-file-memory | MD(.dsh-notes) | D | SUB 过滤 | — | — | 0 | — | S |
| ICCuse/dsh-knowledge | MD(全局 KB) | D | title×3/tag×2 | — | — | 0 | — | G/X |
| ICCuse/dsh-premise-guard | — | R | 锚点检测 | PS 一次性 | EV | 0 | — | S |
| Phant0Meow/dsh-memory-meow | MD(PROJECT.md) | D | 全文件注入 | FUM | REF | 1 | — | P |
| FleetingEcho/dsh-handoff | MD(~/.agent) | D | 全文件注入 | SP -200 冻结 | LLM 折叠+跨分支 | 1 | — | P(分支) |
| Noelune/unified-agent-memory | Vault+SQLiteFTS | D | FTS | —(pull) | 90 天遗忘 | 1 | 侧栏(只读) | X |
| akslcw/dsh-negative-ledger | SQLite(native) | D | 指纹拦截 | 告警/拦截 | EV 自愈 | 0 | — | G |
| ljsysfurryACE/dsh-memory-director | JSON(~/.dsh) | D | Jaccard | PS ≤4 条 | 每轮写/忘 | 1 | — | G |
| ljsysfurryACE/dsh-compaction | — | — | — | 表层替换 | 压力触发 | 0 | — | S |
| Aik358/dsh-auto-memory | MD 三层 | D | 关键词+AI 扩词 | SP 10000+PS | 沉淀/反思/日历 | H | 侧栏+设置+日历 | G/X |
| LoserFox/distill | SKILL.md | D | — | — | 每 3 轮反思 | 1 | — | P |
| aerince/dsh-active-context-pruning | — | — | SUB(双层) | SP/context 80 | nudge | 0 | — | S |
| Xplore-LAB/dsh-plugin-asmemory | SQLite(Py MCP) | D | 时序数学 | — | — | 0 | — | G |
| FuRongJun-1999/dsh-memory | SQLite+外部 aeis | D | 外部(未验证) | 工具+钩子 | EV 自动记 | S | — | X |

注:Memory 分类之外还有若干边界相邻组件(dsh-recall-plugin 会话回滚、dsh-rule-evolve 规则自演化、
dsh-codebase-memory / knowlp-rag 代码知识图谱、dsh-task-planner 经验肌肉记忆、DSH-EvoResearch 研究记忆、
dsh-ops-kit 只读记忆搜索、dsh-weekly-digest 读取记忆条目)——与本仓库问题域相邻但非直接竞品,本文不深入。

## 2. 分组逐个分析

### A. 外部后端组(6)— 全部依赖外部服务,与本仓库「零外部服务」根本对立

- **dsh-mnemon**:最成熟的「三层记忆+跨 agent」方案(Go CLI)。亮点:LLM 子代理管语义决策、Host 硬保证
  路径/权限/容量/锁;侧栏工作台;确定性活动打分后台维护。风险:写/召回都走 LLM 子代理(成本高);
  依赖 Go CLI 二进制;无审批门。它有跨 agent 与 UI,本仓库有零成本确定性与审批门。
- **dsh-memoria**:插件只是 Rust 服务的 MCP 前端。亮点:用户肯定反馈→importance5 自动高优记忆(轻量启发式);
  namespace 强隔离;多信号召回。风险:自建 Rust 服务重;无注入层;无审批;召回语义在服务端 UNVERIFIED。
- **dsh-memoria-extra**:memoria 只读配套(画像/决策/health/图/实体)。亮点:图谱采样+真实统计、一键 context 块。
  风险:admin key 从 ~/agent-core/.env 回退(密钥落盘);默认 namespace 硬编码。
- **sgme**:最激进的全自动记忆引擎(L0→L1→L2 三阶段蒸馏+矛盾检测+主动关怀信号 claim/ack 原子认领)。
  风险:Python 服务+云 embedding 密钥;DSH 桥的注入只是 logger 占位、未真正接入模型 inbox——
  宣称与实际差距最大的一家。
- **dsh-agentmemory**:会话生命周期全量镜像到本地 daemon。亮点:hookType 标准化保压缩质量;
  压缩前重注入;事件级 dedup;注入预算 6k/3k 字。风险:daemon 硬依赖(load 时 livez 探测);
  无审批;默认无 agentId 隔离。
- **nowledge-mem**:Context Bundle 快照一次注入(12k)+ 关键词触发召回(8k)+ turn-end 转录导入。
  亮点:注入预算纪律好;MCP 工具面。风险:nmem CLI 依赖;历史会话不回填;DSH 侧只桥 tools 不桥 resources。

### B. 本地 SQLite 组(6)— 审批门分水岭;仅 memento 与本仓库同阵营

- **dsh-mneme**(modusensus):功能最全的本地方案。亮点:autoDream「决策清单」式自动整理+幂等审计 receipt;
  MD 镜像人工优先双向合并;离线 ONNX 向量+rerank(可选)。风险:全局单库;无审批;autoDream/摘要烧 LLM;
  transformers 依赖重。它证明「自动整理」可以做到幂等可回放——这是借鉴要点。
- **dsh-memento**(PerryLink):与本仓库哲学最近的方案,也是**全生态唯一把审批门内建进 service 层**的。
  亮点:typed ctx.memory 服务接缝;双轨(用户/agent)×双层(全局/工作区)×per-agent 作用域;
  冻结快照+逐层字符预算;audit+proposals 双账本。风险:自定义 SQLite(非 harness 原生);
  ask 模式无 answerer 时 fail-closed。借鉴:proposal 流与预算头。
- **dsh-memory-gate**:回答「记忆记住了,然后呢」——使用门控(use/verify/ignore)+Beta 置信度反馈学习
  +secret 拒写+三运行模式。亮点:使用前裁决可解释;反馈学习触发词;健康自降级。风险:写入仍无审批;
  召回词法级;mine 命令未源码级验证。借鉴:置信度反馈与 secret 红action。
- **dsh-plugin-recall**(truelove-dreamer):几乎是我们 memory_search 的只读子集(官方 FTS5)。
  亮点:字面短语防 FTS 语法注入。风险:**未排除当前会话**(我们排了)。它验证了 memory_search 选型的正确性。
- **forge-memory**:BM25(k1=1.2, b=0.75)+新鲜度三态+中文字符级分词,只读。亮点:freshness 衰减的纯客户端实现。
  风险:数据源耦合外部 Go 系统;Windows 路径硬编码。
- **yangyongzhen/dsh-memory**:形状与本仓库最近的 JSON 方案。亮点:global/project 双作用域自动分桶;
  PS 首步注入+字节预算贪心(4k/512);内容寻址 digest 防 resume 重复注入。风险:无审批;朴素子串 AND 召回;
  无 caps。它验证了「per-project 分桶 + 字节预算注入」是社区共识做法。

### C. 会话日志/文件组(5)— 唯一自动记忆者是 Jesse;五个均无审批门

- **Jesse-njx/dsh-memory**:会话末蒸馏到 md+引用。亮点:**citation→memory_expand 无损升级**
  (「摘要是索引不是真相」);contradiction/rev 版本;每事实一文件可 git diff;索引 800 token 硬上限。
  风险:蒸馏无审批;召回按名字典序(本组最弱);每会话一次 LLM。这是「引用→原文」与「会话末自动提议」的最佳范本。
- **flymysql/dsh-memory**:与本仓库同 storage-domain 机制(唯一一家,验证了本仓库的存储选型)。
  亮点:浏览器设置页(本组唯一 UI);被动注入最近 8 条。风险:无审批、无去重、schema 无 per-workspace 字段;召回朴素。
- **ICCuse/dsh-file-memory**:verbatim 逐字节前提行,单会话文件,反 compaction。亮点:无损往返;依赖极简。
  风险:单会话不跨会话;无注入;完全靠模型自觉调用。
- **ICCuse/dsh-knowledge**:全局 Markdown KB 与 Codex kb.cmd 字节兼容。亮点:frontmatter 复刻+typed 分类+时间线。
  风险:默认 D:\knowledge 硬编码;无注入;搜索朴素。
- **ICCuse/dsh-premise-guard**:压缩后漂移护栏(确定性锚点+一次性 PS 告警)。亮点:把 compaction 变成
  「被检查的交接」;agent/pre-step 注入面新颖;零存储零 LLM。风险:启发式误报;一次性告警可被忽略。与本仓库互补。

### D. 项目/handoff/可移植组(4)

- **dsh-memory-meow**:PROJECT.md 全量注入首条用户消息(FUM,缓存友好)+ReAct 后反思。
  亮点:FUM 注入面;每项目独立文件。风险:无审批/caps/dedup;无召回;反思有 LLM 成本。
- **dsh-handoff**:分支级 handoff.md,pi-handoff 字节兼容,LLM 折叠+跨分支项目知识提取+secrets 红action。
  亮点:变更门控冻结快照(-200);三层(分支/项目/pin)+重 caps。风险:LLM 折叠成本;无审批(项目评审自动接受)。
- **unified-agent-memory**:Obsidian vault+Python 核心+SQLite FTS;submit→promote→adjudicate→90 天遗忘。
  亮点:遗忘衰减;<memory-data> 防 prompt 注入;credential 红action。风险:无自动注入(靠 AGENTS.md 布线);
  跨 agent 共享=单库风险。
- **dsh-negative-ledger**:负面知识账本(命令失败/文件缺失+证据见证+指纹拦截+证据变化自动失效)。
  亮点:真正解决「重复踩坑」;拦截而非建议。风险:better-sqlite3 native 依赖;与事实记忆正交——
  **最值得另立山头的方向**。

### E. LLM/自动/分析组(7)— 全自动化与本仓库哲学根本对立;抓到 3 处宣称不实

- **dsh-memory-director**:每轮 LLM 决定写/忘。亮点:importance+accessCount 字段;Jaccard>0.8 去重。
  风险:全局单文件;无审批无 cap;**「重要度衰减」README 宣称但代码未实现**;每轮烧 LLM。
- **dsh-compaction**(ljsysfurryACE):确定性正则「语义」压缩。**README 宣称 28.4x 物理 INT4/MLA 压缩,
  代码中完全不存在(vaporware)**。教训:README 宣称必须源码级核验。
- **dsh-auto-memory**(Aik358, 9★):最完整的产品化方案:三层 markdown+每轮 subagent 自动沉淀+日历四象限
  +设置页+跨 AI 工具记忆继承。亮点:注入预算纪律(2400/1400 字);失败重试+心跳。风险:LLM 成本最高
  (每轮沉淀+智能检索+问候);无审批;明文文件。它是「如果要全自动,应该做成什么样」的参照系。
- **distill**(LoserFox, 18★):工作流蒸馏为 SKILL.md(所有权标记防覆盖)。亮点:log-only 事件可重建模型可见输入。
  与本仓库正交(技能 vs 事实)——提示:技能记忆与事实记忆可以分层互补。
- **active-context-pruning**:模型自写检查点+表层隐藏+可逆只读还原。正交(上下文管理)。亮点:官方事务复用。
- **asmemory**:状态/动作时序+趋势/异常/因果(纯 Python stdlib)。正交(数值时序)。亮点:因果前后对照。
- **FuRongJun-1999/dsh-memory**:灵枢引擎桥。风险:核心在仓库外 aeis 包(34 工具/图/重要性全部 UNVERIFIED);
  多实例共享=无隔离;仓库含重复 src/src 打包瑕疵。

## 3. 与本仓库逐轴对比(8 轴)

1. **存储层**:本仓库 = storage-domain JSON(原生,无外部服务);生态 = 自建 SQLite×4、MD 文件×7+、JSON×3、
   外部服务×6、无存储×5。判断:原生接缝是护城河,坚持;但「人工可读/git 可 diff」是社区共识需求 → 只读导出镜像。
2. **写入门控**:本仓库 = 审批门+caps 预检(全生态仅 memento 同阵营);其余直写/自动/只读。
   判断:坚持并把审批门延伸到 UI 删除与自动提议。
3. **召回**:本仓库 = 三档评分(tag 精确>子串>模糊)+CJK bigram+短语 boost,零成本——生态内排序最细的确定性方案之一;
   但缺新鲜度/访问频次信号、无语义。forge(freshness)/memento(recall_count)/gate(置信度反馈)提供了低成本补丁;
   语义(EMB)是生态最大增量区 → 评估可选 tier,默认不做。
4. **注入**:本仓库 = SP order 88 常驻 profile(8×240 caps);生态 = SP 与 PS 两派,预算纪律普遍(条数/字节/char)。
   可补:opt-in 的 PS 单次召回注入通道 + 压缩前重注入。
5. **自动化**:本仓库 = 刻意 defer;生态 = TE/SE 自动沉淀是最大公约数(10+ 家)。
   研判:以「提议」形态兑现自动化(LLM 提议→审批→落库),保留半自动内核——解锁此前推迟的「主动提议记忆」,
   但必须 opt-in、默认关、每会话至多一次 LLM。
6. **成本**:本仓库 = 0;生态约半数烧 LLM(每轮/每会话/服务端转移)。判断:0 成本是差异点,保留为核心默认;
   自动化提议作为 opt-in 付费路径。
7. **UI**:本仓库 = 无;生态 = 设置页/侧栏/日历是标配(mnemon/auto-memory/fly/memento/uam)。
   判断:补只读浏览器设置页,写删仍走审批。
8. **作用域**:本仓库 = per-workspace;生态 = 全局/明文占多数,跨 agent 共享是另一大卖点(mnemon/sgme/frj/uam)。
   判断:per-workspace 隔离是优势,保持;跨 agent 共享与本仓库定位冲突,不做(除非用户明确要)。

## 4. 落地映射(v0.3.0 milestone #2)

| 优先级 | Issue | 方向 | 主要来源组件 |
|---|---|---|---|
| P0 | #20 | memory_expand 引用→原文无损升级 | Jesse-dsh-memory |
| P0 | #21 | 召回新鲜度衰减 + 访问频次加权 | forge / memento / memory-director |
| P0 | #22 | 写入与注入前 secret 红action | memory-gate / handoff / uam |
| P0 | #23 | 只读事实浏览设置页(UI) | flymysql / mnemon / memento |
| P1 | #24 | 会话末记忆提议(opt-in,审批门保底) | Jesse + mnemon(加审批门) |
| P1 | #25 | compaction 漂移护栏 | premise-guard / agentmemory |
| P1 | #26 | Markdown 只读导出镜像 | mneme / Jesse / auto-memory |
| — | #19 | 测试 mock 保真度 backlog(遗留) | — |
