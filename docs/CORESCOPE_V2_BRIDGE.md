# CoreScope 的 V2 只读桥和信源融合

CoreScope 是独立站。V2 继续采集；这个桥只以 `mode=ro` 和 `PRAGMA query_only=ON` 读取它的 SQLite，在有界读事务内导出原始素材。只写 CoreScope PostgreSQL 和本项目 `.data/v2-bridge/`；不导入 V2 的运行模块，不修改 V2 代码或数据库，不启停 V2 服务。

## 融合后的信源目录

`industry/sources.json` 是可直接 seed 的配置，`docs/corescope-v2-sources.json` 保留全部原始 source ID 与别名去重理由。`docs/corescope-upstream-sources.json` 保存本 fork 上游公开的 18 条示范配置，供重复生成使用。

2026-10-03 的只读目录快照包含 436 个 V2 原始来源。排除 5 个 AIHOT 输出回环来源，合并 15 个完全相同订阅地址的 V2 别名；上游 18 个示范源中 9 个与 V2 同 feed，映射到 V2 canonical ID，最终保留 425 个 canonical 来源。最初交付为 174 个启用：161 个 V2 external 桥入口和 13 个原生 RSS。此数量属于历史交付，不代表迁移后的实时数据库状态。

2026-10-12 接入配置已更新为 **284 个原生路线、125 个桥接路线、14 个原暂停来源和 2 个未接入资源目录**。284 个由 203 个 RSS、15 个网页列表、15 个 JSON 列表、51 个只读公众号缓存入口组成。10 个非文章页单独作为资源目录，其中 8 项有已验证的 `isolated` 适配，另外 2 项保留参考链接与明确限制。原 227 个可恢复资格来源经逐源复核后，146 个采用原生路线、81 个保留受限桥接；不能把“恢复资格”解释成“全部独立采集成功”。

路线依据 `industry/corescope-source-profiles.json`，逐源 HTTP、XML/JSON/HTML 解析、日期、公开文章样例和失败原因见 `docs/corescope-source-admission-audit.json`。这些是配置与源站验证证据；正式库升级及连续运行验收由后续升级回执和运行数据确认。

- 去重比较完整 feed 的协议、主机、路径和 query；只统一主机大小写、末尾 `/` 和 fragment。不同路径、不同 query 过滤仍保留。
- 不按域名删除来源。官网新闻、工程博客、研究博客等可各有自己的内容入口；在热点计数时用 `signal_group_id` 把已识别的同一出版商合并成独立参与主体。
- `P0/P1` 是 V2 的路由/优先级，不直接映射为一手来源。已识别官网域名及上游明确标注的官方来源才标 T1，其余保守 T2。
- `native / bridge / blocked` profile 分别指定原生、桥接或关闭。原生路线会禁止对应 canonical ID 和旧别名再次从桥导入；没有 profile 的来源保持保守的原状态规则。
- 原 14 个暂停来源在顶层 `preserveDisabledSourceIds` 冻结。探测重跑保留旧冻结名单，不能因 V2 状态变化或上游重复示例而自动复活。
- 10 个非文章页必须有专用 profile，并使用 `nonArticle=true`、`participationMode=isolated`。未验证的目录保持关闭，不将目录导航或资源元数据当作新闻。
- URL 用户名、密码、凭据参数和不透明订阅路径不会写入公开配置或审计副本；需要私有入口的采集保留在授权的本机配置或 V2 路线中。
- 默认关闭站内全文与全文转发；能够读取原文不代表拥有公开全文的许可。

排除的 V2 数字 ID：`9285, 9614, 9615, 9616, 9617`。此外排除名称或 URL 包含 AIHOT 的来源、V2 自身地址与配置的 `SITE_URL`，防止 AIHOT → V2 → CoreScope 回流。

## 首次与持续运行

本地 `.env` 中配置 SQLite 的路径，不把它或模型密钥提交 GitHub：

```dotenv
V2_DATABASE=<V2数据库绝对路径>
CORESCOPE_V2_BATCH_LIMIT=6
CORESCOPE_V2_POLL_SECONDS=120
# PYTHON_EXE=<Python绝对路径>  # 不填时使用 python
```

普通首次同步只从当前实时水位开始，不自动重分析几十万历史条目；之后仅消费新发现的素材及已导入素材的更新。

```powershell
node --env-file=.env scripts/corescope-v2-bridge.ts
node --env-file=.env scripts/corescope-v2-bridge.ts --watch
```

历史初始化必须显式选择，最多 60 条。推荐 20–40 条真实样本，保留原始发布时间和发现时间：

```powershell
node --env-file=.env scripts/corescope-v2-bridge.ts --bootstrap --since 2026-09-30T00:00:00+00:00 --limit 40
```

`--bootstrap` 仅限首次、尚无游标时使用，未写 `--since` 则查看最近 3 天。提交后消费游标直接设为该读快照的真实上水位，随后 watch 不继续静默追跑剩余历史。`--article-ids 204245,206668,...` 可进一步限制为人工审阅的素材数字 ID。数据库扫描仍有界，默认最多 5000 行；指定 ID 时直接在 SQLite 查询里筛选，避免跨大量无关历史扫描。

也可拆成只读导出和导入两个步骤，便于检查后再分析：

```powershell
python scripts/corescope-v2-export.py --db <数据库路径> --bootstrap --since 2026-09-30T00:00:00+00:00 --limit 40 --out .data/v2-bridge/review-batch.json
node --env-file=.env scripts/corescope-v2-bridge.ts --file .data/v2-bridge/review-batch.json
```

更新本项目来源配置前，先停止 CoreScope 应用；V2 保持运行且只读。需要本机数据库时可通过 `corescope-runtime.ps1 -Action Database` 仅准备独立 PostgreSQL。以下生成命令只读 V2，profile 默认路径也可显式指定：

```powershell
python scripts/corescope-v2-export.py --db "<V2 SQLite路径>" --sources-only --source-profiles industry/corescope-source-profiles.json --source-pack industry/sources.json --source-map docs/corescope-v2-sources.json
node --env-file=.env scripts/seed.ts
node --env-file=.env scripts/corescope-source-upgrade.ts --dry-run
# 审阅回执中的目标配置、受保护字段与失败项后，再应用
node --env-file=.env scripts/corescope-source-upgrade.ts --apply
```

`seed.ts` 对已存在的 ID 不覆盖，因此单独重跑 seed 不会完成现有 `external` 到原生路线的迁移。`corescope-source-upgrade.ts` 默认只预览，必须显式 `--apply`；它检查本项目数据库边界、profile 验证状态、原暂停名单和管理员受保护字段，并保存迁移结果。是否已成功应用，以正式库升级回执为准，不能从静态 JSON 推断。

桥会补齐上游 seed 尚未支持的 `signal_group_id`；管理员显式分组及受保护配置不被覆盖。完成升级后由一键启动器恢复整套 CoreScope，再检查 source 状态、队列及实际新增；不要在 worker 正在处理请求时手动改路线。

## 只读公众号与受限桥接

51 个公众号采用 `mp_account` 的 `transport=wx_cache`，从私有 `.env` 的 `WX_CACHE_DIRECTORY` 读取已授权本机解密缓存。公开 profile 只记录公众号名称和环境变量名，不记录实际用户目录。精确账号匹配后仅读取公开文章表，保留原始 `pub_time`；消息接收时间不是文章发布日期。CoreScope 不运行 `wx` 命令、不管理 daemon、不写共享缓存、不读私人聊天，也不写 V2。缓存需要已有本机流程持续更新；这条路线不会自行登录微信或从微信服务器刷新资料。

未找到精确账号、近期无文章或缓存过旧的来源保留明确受限状态；后台成功轮询不保证上游有新文章。没有为此次迁移调用 Dajiala、SocialData 或其他付费采集提供商。

桥接 profile 可选 `bridgeIntakeUrlPrefixes`，按公开 URL 的主机和路径边界限制允许导入的原文。缺少该字段表示普通桥接规则，显式空数组表示全部拒收。`v2-source-3335` 的旧中继只有搜索页链接，原文与作者身份未证实，因此使用空数组保留目录并阻止新材料；准确新智元公众号由 `v2-source-6834` 的缓存路线覆盖。Qwen 已改成验证过的官方 JSON 原生路线，原 ifanr feed 不再成为它的原生或桥接输入。

## 原始内容与证据

`title/url/publish_time/crawled_at/summary/raw_content` 直接映射至统一 `upsertMaterial` 入口。V2 `model_summary/model_title/score/admission` 只保存在 `raw.v2.priorAnalysis`，不冒充原始正文，也不当作 CoreScope 精选、热点或日报结论。

`raw_content` 没有经过可复用的全文验证契约，正文一律标 `unconfirmed`。如果它与来源摘要完全相同，记录为 `source_excerpt_only`，正文留空、`body_status=pending`，让原生详情补齐流程工作；论文 abstract 也明确标为摘要。原始字段仍保留在私有 `raw.v2.priorAnalysis.originalRawContent`。没有根据字数断言“全文完整”。`article_source_evidence` 里的 arXiv / 微信父文、原始中英摘要与证据 URL 一并保留于私有原始 metadata 及桥 ledger，不把微信解读等同论文正文。

发布时间和发现时间保留 V2 原值。旧稿依原站统一 timeline/backfill 规则处理；桥不把旧材料改成今天，也不伪造独立主体热度。分析继续走原生 worker、模型回执、预算、Fact/Story 归组与 publication 层；导入材料本身不表示已完成分析。

## 幂等、失败恢复与边界

迁移 `0042_corescope_v2_bridge.sql` 新增独立站的状态与 ledger。一个 PostgreSQL 事务同时写入统一材料、原生队列任务、原始指纹和 `(updated_at,id)` 游标。事务失败不推进消费位置；重复已提交批次 `created=0/revised=0/queued=0`。

每轮重读 15 分钟重叠窗口，用原始内容指纹跳过已确认版本，保留有界扫描位置，避免同一时间戳的大批记录使新素材饿死。V2 评分或写作变化不构成原始内容指纹变化。来源停用时拒绝该批次并保留原游标；恢复后重试。失败信息在 `corescope_bridge_state.last_error`，成功导入回执在 `ingest_events`。

URL identity 继续沿用上游规则：同一原文只留一份素材、多个发现与 ledger 别名。本文不宣称已实现独立的跨 arXiv 版本 abs/pdf canonical 迁移；额外来源证据保留以供后续审阅，不自动变成热度信号。此桥不扫描冷归档。证据表在文章更新时间或有界重叠覆盖时同步；独立发生且不更新文章的更旧证据变化，不属于该增量协议的完整覆盖范围。

## 本地验证

```powershell
python tests/corescope-v2-export.test.py
# DATABASE_URL 必须指向迁移后的 *_test / *_ci 空库
node --test tests/corescope-v2-bridge.test.ts
```

覆盖完整 feed 去重、原始 ID 别名、回环排除、摘要与正文来源、只读文件完整性、等时间戳游标恢复、重复导入、暂停源整批回滚、同 URL 多别名和仅证据变化不新增分析任务。
