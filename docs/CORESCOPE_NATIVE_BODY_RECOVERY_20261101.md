# MIT17164与Speechhome原站正文恢复

本次只针对两篇既有材料：MIT科技评论17164（`uln8vfg3gg477t9t70y7bzqzy`）及Speechhome Nemotron转写报道（`rzmkm2w7bfoucbuy944rngcoo`）。使用原站匿名公开接口，不调用Jina、不新增付费服务、依赖、列表采集器或worker。来源参与方式、评分、发布及全文许可保持原规则。

## 已核实的正文入口

- MIT页面自身JS使用 `https://apii.web.mittrchina.com/information/details?id=17164`，桌面详情直接渲染 `data.content`。该条返回同ID、同标题，`code=10000/status=1/is_vip=2`；`content_all=null`，summary只有189字符，不能代替正文。清洗后7354字符，正文主题、参考资料及结束部分经过人工核对。
- Speechhome旧 `/post/2116116444335968256` 跳到 `/blogs/id`，新版路由将其误认成列表壳。站点真实详情组件调用 `https://speechhome.com/api/api/post/detail/2116116444335968256`。匿名返回 `status=200/data.isSucceed=true/result.statusCode=0`，字符串ID、标题和正文精确匹配正确公开详情页 `/blogs/all/2116116444335968256` 的Nuxt数据。清洗后8495字符，66段及10个正文标题，尾部无预览截断。接口的 `publishDate=0001-01-01` 是占位值，不覆盖既有发表时间。

只读取页面正常使用的公开 `content`，不带Cookie/认证，不请求会员或隐藏正文。适配器锁定各自域名、路径与ID，校验成功/公开状态、标题、清洗正文SHA256、末200字符SHA256及主题词。认证、错误ID、未知状态、短正文、预告、验证壳或证明不匹配均拒绝，不能转购Jina或拼接其他公告代替。

## 正式处理路径

`content/native-body.ts` 只获取单篇正文，沿用 `guardedFetch` 的DNS/连接/大小/时间/重定向边界和现有HTML清洗。MIT的数字ID必须为安全整数，Speechhome的19位ID始终为字符串。无新包、Key、浏览器运行时或付费依赖。

固定恢复成员新增 `nativeBody`（专用adapter、`allowJina:false`、正文证明），与RSS策略互斥。统一策略读取保留原RSS导出接口和旧manifest digest兼容。两种策略完成或撤销后，仍为同文章原URL保留禁止Jina指令；只有有效固定许可授予正文恢复范围。原有文章级失败缓存和真实新正文的resolution历史继续复用。

两篇在本次执行时已超出滚动48小时。用户点名授权对应的独立两篇计划，仅继承旧已完成正文批次中的精确成员与原窗口：校验父批次完整manifest、digest、真实激活/完成审计、同ID/来源/配置/URL/发表时间和旧当前revision。新计划仍须30分钟内激活，不修改、复活或扩展旧184批次，不更改全局48小时/最新2000。父批次指纹在验收前后比较。

获取后复用唯一既有worker和正式提取事务：来源锁、文章URL/revision锁、批次锁、重新核验策略、正文新修订及历史、正常分析/发布/事件队列。失败决定也按原URL校验，避免请求中URL变化后修改另一地址的状态。保留原标题、作者、日期、来源、许可及attemptTag，不人工设置selected/eligible/visibility。公开仍为摘要与原文链接，不新增全文权限。

## 本机入口

私有请求只含1–3个固定article IDs、原站策略和正文证明，必要时指定已完成原批次 `parentBatchId`。CLI自动冻结父指纹；不接受任意JSON路径、跨站抓取地址或手工新付费身份。

```powershell
node --env-file=.env scripts/corescope-native-body.ts plan --request=<request.json> --out=<plan.json>
node --env-file=.env scripts/corescope-native-body.ts apply --plan=<plan.json>
node --env-file=.env scripts/corescope-native-body.ts enqueue --plan=<plan.json>
node --env-file=.env scripts/corescope-native-body.ts status --id=<batch-id>
node --env-file=.env scripts/corescope-native-body.ts complete --id=<batch-id>
```

只写独立本机CoreScope库。入队有稳定审计身份，拒绝已有活跃任务、deferral及pending/unknown回执，重复交接不重复执行；complete要求正文真实ok且正常下游严格结算。

## 验收记录

执行前基线、原站公开接口及动态页核对、安全正文证明、逐篇CSV/Markdown、正式计划、测试和运行证据保存在私有 `.data/qa/native-body-recovery-20261101/`。不提交原始接口响应、正文、配置密钥或数据库。

2026-11-01 15:59（Asia/Shanghai）完成真实验收：

| 材料 | 正文修订 | 正文字符 | 当前发布版本 | 自然结果 |
|---|---|---:|---:|---|
| MIT科技评论17164 | 1→2 | 7354 | 4 | 正常公开，未入精选 |
| Speechhome Nemotron转写 | 4→5 | 8495 | 5 | 正常公开，按原模型规则自然入选精选 |

两条均复用原文章ID。新正文SHA与执行前原站证明一致；当前revision分析与publication对应，正式取得审计、失败缓存resolution及正常事件归组/摘要结算齐全，公开API和HTML原文链接、当前发布版本逐篇通过。原source/config、标题、作者、日期、全文许可及attemptTag保持，无人工编辑或发布覆盖。公开仍为摘要与原文链接，不授予转载全文权限。Speechhome原文章URL保留用于去重和来源追溯，上述正确详情页另作为原站内容核验证据。

本次两条新增Jina请求均为0。原回执221810/222156的全部回执及attempt元数据相对执行前完全一致，各attempts仍为1；禁止Jina的文章指令在计划complete后仍保留，native策略已不再授予执行范围。没有新增付费服务；新正文的正常模型分析仍使用系统已有服务及回执。

独立计划 `native-two-20261101`（digest `ba452ac903d7ef6ede579005d0fff997ddd99d6cd07ac1cbd3065815ef004cb8`）15:57激活并正式入队两条，15:59严格complete，2/2 settled、无活跃任务/deferral/未结算回执。父批次 `jina-web-body-20261101-02` 保持complete，完整指纹前后一致；未复活旧184批次，未重冻或扩展旧分母。全局48h/最新2000和所有预算设置均保持。

最终类型检查、前端40/40、前端构建和运行站点smoke全部通过。稳定源码全量后端948/948通过；生产Node24.14的正文适配、正式恢复、RSS回归和失败缓存关键65/65通过（其中纯parser14项、native恢复13项）。测试均用隔离测试库、离线stub及既有私有测试运行时，不调用真实外部付费服务；未升级全局Node。早期历史时间测试fixture的digest/微秒格式与预期错误提示断言曾失败，修正fixture后全量及生产版本关键测试均通过，原日志保留。

仅正常重启CoreScope加载代码：15:56:30开始优雅停止，15:57:12原Windows托管入口恢复ready，启动无异常。网页8780、API8781、独立PostgreSQL5448健康，唯一原worker持续运行。V2 PID21268与BirdClaw PID25300及创建时间均与本次基线相同；BirdClaw519个跟踪文件、配置和全局CLI指纹相同。本任务未修改、启停、重配或恢复V2/BirdClaw文件，也未操作其他checkout。24个发布/精选保护文件哈希保持。

交付范围为本次CoreScope源码、测试、操作入口和本文，提交至CosmosHWPG/AIHOT的 `codex/corescope-system` 分支，不合并PR。运行地址为 `http://127.0.0.1:8780/`，逐篇详情为 `/items/<原articleId>`。
