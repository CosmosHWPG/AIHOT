# CoreScope 上游迁移兼容与隔离演练（2026-11-22）

本次候选合并固定上游 `aec61a4cca18ff1521f4d32040ba5ee1750d9017`，旧 CoreScope 基线为 `8855b044810ac5ae8dd2411dfc79f18b3d439407`。只在独立候选 worktree 和合成数据库演练；没有迁移、复制或连接生产数据库，没有调用真实 provider，也没有操作 V2/BirdClaw。

## 保留历史与有意兼容选择

旧 CoreScope 的 45 份 SQL 保持原文件名和内容；同号但不同名的上游文件并存，执行身份仍是完整文件名，不改号、不把旧文件重写成新版本。候选共 105 份 SQL（上游 98 + CoreScope 独有 7）。

`scripts/corescope-migration-holds.ts` 为 22 份会删除既有能力、证据或改写运营数据的上游 SQL 保存精确 SHA256、原因与上游 commit。仅 CRLF/LF 传输差异归一化；其它任何 SQL 变化都会在数据库修改前失败。文件保持上游原文，**有意不执行**，单独写入 `schema_migration_holds`，不会冒充 `schema_migrations` 已执行记录。若这些文件已被错误记为执行，runner 停止并要求恢复/核对数据，不自动掩盖。

| 文件 | 保留内容 |
| --- | --- |
| `0044_leaderboard_model_names.sql` | 本地模型名称、provider 所有权，避免上游站点专用 UPDATE 覆盖 |
| `0045_drop_topics.sql` | 旧数据库主题目录；与 `industry/topics.json` 并存 |
| `0049_drop_leaderboard_usd_prices.sql`、`0050_drop_lb_rankings_unused_columns.sql`、`0052_drop_lb_prices_verified_on.sql` | 排行榜价格、置信度、分量与核验时间 |
| `0051_drop_unused_state.sql` | topic/regroup/store 状态，story 状态与上下文，来源溯源，翻译回执，管理员角色，服务价格证据 |
| `0053_drop_leaderboard_monitor.sql` | leaderboard、monitor、汇率表及对应 settings |
| `0146_drop_admin_sessions_auth_claims.sql`、`0147_drop_admin_users_feishu_union_id.sql` | 既有会话证据和管理员身份 |
| `0149_admin_sessions_auth_method_drop_check.sql`、`0150_admin_sessions_auth_method_add_check.sql` | 保持 `0054` 的 password/Feishu 兼容约束；两条成对保留 |
| `0153_drop_sources_first_party.sql` | 独立于 tier 的第一方来源归属 |
| `0154_drop_stories_action.sql`、`0155_drop_stories_frame.sql`、`0156_drop_facts_version.sql` | 既有事件 action/frame 与 fact 版本 |
| `0157_drop_deliveries_origin.sql`、`0158_drop_receipts_origin.sql` | 投递与付费回执溯源 |
| `0162_drop_stories_latest.sql`、`0163_drop_story_digests_latest.sql` | 既有事件与摘要 latest 文本 |
| `0164_drop_reports_model.sql`、`0165_drop_reports_origin.sql` | 报告模型和来源证据 |
| `0169_drop_selected_ledger_visible_at.sql` | 精选历史可见时间与索引 |

已逐份检查混合 SQL：`0051` 仅包含破坏性 DROP，`0053` 的 DROP 与 settings DELETE 都属于保留范围，不含必须补跑的新增 DDL。`0054` 正常执行，保留 password/Feishu 约束；旧保留列具有默认值或允许 NULL，可兼容上游新写入。没有为本次兼容重写 SQL 或另加业务表迁移。

其余 38 份新增迁移正常执行，包括上游新增 uses、发布/展示字段及最新 `0170` 报告期号、`0171` 唯一期号索引、`0172` digest version、`0173` attempt 自动放行标志、`0174` feedback surface、`0184` 原文隐藏约束。保留上游在线 DDL 安全检查、锁/语句超时、并发索引有效性校验与备份等待机制。

## 合成数据演练结果

独立 PG 绑定 `127.0.0.1:5549`，PGDATA 位于候选 `.data/corescope-upgrade-rehearsal/pgdata`，仅以现有 PostgreSQL 二进制作只读程序模板，凭据重新合成，没有复制生产 `.env`。Node 为独立 `v24.22.3`。

| 场景 | 执行记录 | 结果 |
| --- | --- | --- |
| `corescope_upgrade_populated_test` | 先执行旧 45，插入有限合成 fixture，再执行候选新增 38；22 hold | 升级前所有旧表/列/行逐值保留，新增索引均有效；重复运行 0 新执行 |
| `corescope_upgrade_cold_test` | 从空库执行 83；22 hold | 安装成功，索引均有效；重复运行 0 新执行 |

fixture 覆盖 editorial/hot_signal/isolated 来源、已选文章、未确认正文、失败重试、completed/unknown/failed 回执与 attempt、付费 cost/usage、事件/fact/digest、精选账本、第一方归属、排行榜、monitor、旧主题、报告、Feishu 管理员会话、CoreScope bridge、Bird profile、容量延期与正文失败缓存。所有来源暂停；embedding 为直接插入的三维合成向量，没有模型调用。

供隔离 API/SSR 检查的固定键：`upgrade-report`（`https://example.invalid/report`）、`upgrade-signal-item`、`upgrade-unknown`，来源 `upgrade-editorial`，story 内部 `91001` / 公开 `00000000-0000-4000-8000-000000091001`。`upgrade-topic` 仅证明旧 DB 目录保留，不表示当前 `industry/topics.json` 已发布同名主题页面。

安全结果与日志在候选私有目录 `.data/corescope-upgrade-rehearsal/rehearsal-result.json`、`rehearsal.log`。合成连接配置同目录 `synthetic.env`；不得提交凭据文件。实例正被隔离 API/SSR 共用时，不重新初始化或 reset 这两个数据库。

## 可重复检查

双基线历史检查同时校验本地与上游已发布 SQL；仅显式给定的 Git ref 被视为历史，不豁免随意编造的旧编号。Windows CRLF/LF 差异允许归一化，其余内容不可变：

```powershell
node scripts/check-migrations.ts --base 8855b044810ac5ae8dd2411dfc79f18b3d439407 --published-base aec61a4cca18ff1521f4d32040ba5ee1750d9017
```

隔离定向迁移测试（旧数据升级、冷安装、hold 防篡改/幂等、在线 DDL、锁/备份等待、索引恢复、原 checker）20/20 通过；补充双基线 checker 及原 checker 共 3/3 通过，真实合并目录的双基线检查通过。测试文件为 `tests/corescope-upgrade-migrations.test.ts`、`tests/corescope-upgrade-migration-check.standalone.test.ts` 及现有 migration 测试。runner 使用单独 `corescope_upgrade_migration_checks_test`，不会复用 API/SSR fixture 数据库。

这次验证证明有限合成数据下的结构兼容、历史保留与迁移幂等。批量真实数据升级的耗时、锁竞争、空间、生产分布下唯一约束及业务读写仍需另行验证；本结果不表示已部署或完成生产升级。22 份 hold 是 CoreScope 的明确兼容选择，未来上游迁移依赖被保留/删除结构时仍需逐份复核。
