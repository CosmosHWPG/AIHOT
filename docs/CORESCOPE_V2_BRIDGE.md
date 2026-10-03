# CoreScope 的 V2 只读桥和信源融合

CoreScope 是独立站。V2 继续采集；这个桥只以 `mode=ro` 和 `PRAGMA query_only=ON` 读取它的 SQLite，在有界读事务内导出原始素材。只写 CoreScope PostgreSQL 和本项目 `.data/v2-bridge/`；不导入 V2 的运行模块，不修改 V2 代码或数据库，不启停 V2 服务。

## 融合后的信源目录

`industry/sources.json` 是可直接 seed 的配置，`docs/corescope-v2-sources.json` 保留全部原始 source ID 与别名去重理由。`docs/corescope-upstream-sources.json` 保存本 fork 上游公开的 18 条示范配置，供重复生成使用。

本次只读快照：V2 共 436 个来源。排除 5 个 AIHOT 输出回环来源，合并 15 个完全相同订阅地址的 V2 别名；上游 18 个示范源中 9 个与 V2 同 feed，映射到 V2 canonical ID。最终 425 个 canonical 来源，其中 174 个启用：161 个 V2 external 桥入口和 13 个原生 RSS。9 个同 feed 上游别名中，4 个对应 V2 尚未接入的候选，因此保留 V2 ID、采用上游 RSS 原生路线；其余使用已接入 V2 采集的素材。

- 去重比较完整 feed 的协议、主机、路径和 query；只统一主机大小写、末尾 `/` 和 fragment。不同路径、不同 query 过滤仍保留。
- 不按域名删除来源。官网新闻、工程博客、研究博客等可各有自己的内容入口；在热点计数时用 `signal_group_id` 把已识别的同一出版商合并成独立参与主体。
- `P0/P1` 是 V2 的路由/优先级，不直接映射为一手来源。已识别官网域名及上游明确标注的官方来源才标 T1，其余保守 T2。
- V2 非“已接入”来源保持停用。native RSS 替代路线单独启用；同时不会从 V2 bridge 导入同一入口。
- URL 用户名、密码和凭据参数不会写入公开配置；需要凭据的采集留给 V2。
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

更新本项目来源配置时：

```powershell
python scripts/corescope-v2-export.py --db <数据库路径> --sources-only --source-pack industry/sources.json --source-map docs/corescope-v2-sources.json
node --env-file=.env scripts/seed.ts
```

桥会补齐上游 seed 尚未支持的 `signal_group_id`；已存在的管理员显式分组及停用状态不被覆盖。

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
