# CoreScope 升级演练后端回归审计

本轮使用隔离工作树和 PostgreSQL 5549。以下逐项对应上轮全量日志的 93 个失败和 6 个取消。日志位置为演练目录 `.data/rehearsal/repair-full-backend-final.log` 的行号。表中测试文件行号取自当轮执行，经过本轮编辑的文件会有行号移动。分类描述用例暴露的证据。功能缺口和混合待复核项保留具体适用范围。

测试夹具 4，架构边界 2，架构与留存 1，架构配置 1，架构时间 1，架构样式 2，架构交互 2，本轮已修复 16，夹具与兼容 1，功能回归 13，规则差异 19，功能缺口 8，测试传输 6，Windows 测试已修 11，Windows 夹具波动 1，混合待复核 5，测试夹具已修 4，功能问题 2。

本轮后端全量为 1,641 项，1,570 通过、70 失败、0 取消、1 跳过。三项功能修复对应的旧失败均转为通过。Windows 测试库重名和旧翻译停机超时均未再出现。当前日志为 `.data/rehearsal/closeout-backend.log`。

| 本轮的额外或变化结果 | 分类 | 核查结论 | 当前日志行 |
| --- | --- | --- | ---: |
| Windows Scheduler heartbeat outlives last private kill-on-close Job handle | Windows 夹具波动 | 心跳在独立 Job 关闭后仍推进，同 Job 对照进程退出。全套失败在清理空临时目录的有界重试耗尽，结束全套后隔离重跑通过。 | 3422 |
| a later verified publisher repairs source and author | 规则差异 | 临时库重名解决后该用例可以执行。原身份和文章修订仍在，失败项是夹具只设 T1 却断言第一方为 true。 | 3709 |
| a daily with nothing judged in its window is refused | 演练环境波动 | 实际错误是演练库的连接超时，未触发日报的空窗口业务判断。结束全套后隔离重跑通过。 | 3768 |

## 上轮逐项归因

| 序号 | 测试位置 | 用例 | 分类 | 核查结论 | 上轮日志行 |
| ---: | --- | --- | --- | --- | ---: |
| 1 | tests/architecture.test.ts:16 | test fixtures and identities do not depend on the wall clock | 测试夹具 | 墙钟与随机身份静态检查报出 52 项测试写法。存在可重复性债务，未由此证明页面或处理链失败。 | 2325 |
| 2 | tests/architecture.test.ts:86 | public routes read content only through the public read layer | 架构边界 | 模型榜 API 直接读 backend/leaderboard/read。查询验证已发布状态，仍缺统一 publication 读取入口。 | 2452 |
| 3 | tests/architecture.test.ts:151 | WeChat post identity is decoded only by lib/url.ts | 架构边界 | Dajiala 直接解析公众号 __biz 以核验账号和返回来源。需要共用解析器，当前证据没有显示文章跨账号串线。 | 2478 |
| 4 | tests/architecture.test.ts:170 | every table and column is used by the code that reads and writes the database | 架构与留存 | 20 个库字段或表未被静态应用扫描识别。桥接账本及迁移保留账本有 CLI 消费者，部分老字段依兼容迁移保留。逐字段核对后才能删除。 | 2504 |
| 5 | tests/architecture.test.ts:202 | every environment variable the code reads is listed in a template, and every listed one is read | 架构配置 | 模板缺 FETCH_CONCURRENCY、ANALYZE_CONCURRENCY 和 Windows 凭据回退变量的对应声明。现有默认值仍生效。 | 2545 |
| 6 | tests/architecture.test.ts:232 | Beijing time is converted only in contracts/time.ts | 架构时间 | 监测器、公众号、探针和榜单另有北京时间换算。静态命中说明实现分散，未观察到数据偏移。 | 2575 |
| 7 | tests/architecture.test.ts:281 | corners use the radius scale | 架构样式 | 资源页有未使用统一令牌的圆角。 | 2606 |
| 8 | tests/architecture.test.ts:303 | scripts read the reduced-motion preference only through lib/motion.ts | 架构交互 | 模型榜表重复直接读取 reduced-motion。应统一入口，当前没有证据显示用户设置失效。 | 2632 |
| 9 | tests/architecture.test.ts:322 | pages are prefetched only through IntentLink | 架构交互 | 视角和模型榜存在绕开 IntentLink 的直接预取。额外流量尚未实测。 | 2658 |
| 10 | tests/architecture.test.ts:345 | web font sizes use the design scale | 架构样式 | 字号扫描报出 199 个非统一规格用法，涉及应用和模型榜。 | 2687 |
| 11 | tests/article-cover.test.ts:95 | body extraction keeps the page's cover apart from the body, and not the site's own picture | 本轮已修复 | 审计正文成功路径缺少原有封面过滤。现复用按来源区分的站点通用图识别，保留文章专属图。 | 3110 |
| 12 | tests/category-corrections.test.ts:27 | category corrections revise every standard report atomically without selecting, rewriting or notifying | 夹具与兼容 | 第一项沿用旧分类中文名。当前 taxonomy 的分类键不变，标题已变。旧报告分组兼容另见下一项。 | 3130 |
| 13 | tests/category-corrections.test.ts:83 | a correction keeps the introduction of the section it moves into | 功能回归 | 历史报告缺少分类键时，旧产品分组名未映射到新版名称。旧导读留在独立分组，移动后的新分组拿不到该导读。 | 3160 |
| 14 | tests/collection.test.ts:93 | finishing an in-flight collection cannot overwrite a source's paused state | 规则差异 | 采集期间来源被暂停后 CAS 返回 skipped，原断言预期 ok。新旧 CoreScope 保护暂停状态的行为一致。 | 3183 |
| 15 | tests/content-publication.test.ts:69 | source tier and event ownership are separate; mentions of an entity do not establish authority | 功能缺口 | 当前实体词表缺少部分厂商及其别名，权威归属无法给这些自有称呼加上原有代表优先级。未放宽旁及提及的规则。 | 3201 |
| 16 | tests/content-publication.test.ts:93 | mentions cannot choose a timeline origin, anchor, representative, or a latest-progress link | 规则差异 | 第一方信息由 sources.first_party 决定。夹具只设 T1，未按新契约显式标记。 | 3221 |
| 17 | tests/core-body-release-recovery.test.ts:68 | release resumes analyzed/unconfirmed and failed/pending bodies through extract, preserving the evaluation and attempts | 本轮已修复 | 修复 body_fallback 路由后，已放行的分析中或失败文章进入正常正文队列，保留版本和尝试记录。 | 3239 |
| 18 | tests/core-body-release-recovery.test.ts:111 | outside2000 is paused while the current fixed recovery member returns to the extract queue | 本轮已修复 | 固定恢复许可内可继续正文接续，正常 48 小时及上限 2,000 条范围外仍受原限制。 | 3257 |
| 19 | tests/core-body-release-recovery.test.ts:126 | a durable old false release is handed off once without another release or provider attempt | 本轮已修复 | 已经记录放行且漏入队的旧回执只补交一次，无第二次放行或请求。 | 3275 |
| 20 | tests/core-body-release-recovery.test.ts:156 | a handoff audit failure rolls the resumed body and queue back without consuming the old release | 本轮已修复 | 入队与审计同事务，审计失败时正文状态和队列一起回滚。 | 3293 |
| 21 | tests/core-body-release-recovery.test.ts:171 | 200 nonfetchable old releases cannot starve a later fetchable body handoff | 本轮已修复 | 候选筛选先验证可抓取和 URL 证据，保证前置不符合条件的回执不会挤掉有效项。 | 3308 |
| 22 | tests/core-jina-body-fallback.test.ts:307 | an exact YouTube consent title and cookies with both buttons reject youtube.com's interstitial | 规则差异 | YouTube 播放页在正文链路被新版策略提前排除。夹具期望 Reader 参与并识别同意页面，无法触达该分支。 | 3326 |
| 23 | tests/core-jina-body-fallback.test.ts:307 | an exact YouTube consent title and cookies with both buttons reject www.youtube.com's interstitial | 规则差异 | YouTube 播放页在正文链路被新版策略提前排除。夹具期望 Reader 参与并识别同意页面，无法触达该分支。 | 3348 |
| 24 | tests/core-jina-body-fallback.test.ts:307 | an exact YouTube consent title and cookies with both buttons reject m.youtube.com's interstitial | 规则差异 | YouTube 播放页在正文链路被新版策略提前排除。夹具期望 Reader 参与并识别同意页面，无法触达该分支。 | 3370 |
| 25 | tests/core-jina-body-fallback.test.ts:307 | an exact YouTube consent title and cookies with both buttons reject youtu.be's interstitial | 规则差异 | YouTube 播放页在正文链路被新版策略提前排除。夹具期望 Reader 参与并识别同意页面，无法触达该分支。 | 3392 |
| 26 | tests/core-jina-body-fallback.test.ts:324 | a real YouTube video description discussing cookie choices keeps its normal title and body | 规则差异 | 夹具期待普通 YouTube 播放页视频描述作为正文，新版策略将该地址排除。 | 3414 |
| 27 | tests/core-jina-body-fallback.test.ts:335 | the exact YouTube title without all consent markers is accepted: cookies and Accept all | 规则差异 | 夹具期待按关键词进一步判断播放页，实际在发请求前已按视频地址类型排除。 | 3436 |
| 28 | tests/core-jina-body-fallback.test.ts:335 | the exact YouTube title without all consent markers is accepted: cookies and Reject all | 规则差异 | 夹具期待按关键词进一步判断播放页，实际在发请求前已按视频地址类型排除。 | 3458 |
| 29 | tests/core-jina-body-fallback.test.ts:335 | the exact YouTube title without all consent markers is accepted: Accept all and Reject all | 规则差异 | 夹具期待按关键词进一步判断播放页，实际在发请求前已按视频地址类型排除。 | 3480 |
| 30 | tests/core-jina-body-fallback.test.ts:355 | YouTube consent markers quoted beyond the bounded beginning do not reject substantive content | 规则差异 | 晚出现的同意词应否接受仅在正文路径有意义，播放页按策略不进入该路径。 | 3502 |
| 31 | tests/core-jina-body-fallback.test.ts:365 | a previously completed identical YouTube consent answer is removed once without purchasing a new answer | 功能回归 | 历史已保存的 YouTube 同意页脏正文仍在。当前视频地址提前返回，未走原先的凭精确回执证据清理路径。 | 3524 |
| 32 | tests/core-jina-body-fallback.test.ts:396 | a previously stored identical Reader target-error page is removed in one audited revision using its existing receipt | 测试夹具 | 种植旧目标错误页回执时未传 acceptUnavailable，Reader 在种植阶段抛错。原文清理断言没有执行。 | 3546 |
| 33 | tests/core-jina-body-fallback.test.ts:396 | a previously stored identical Reader verification page is removed in one audited revision using its existing receipt | 测试夹具 | 种植旧验证页回执时未传 acceptUnavailable，Reader 在种植阶段抛错。原文清理断言没有执行。 | 3555 |
| 34 | tests/core-jina-text-storage.test.ts:75 | Jina nul text persists safely, retains exact UTF-16 evidence and reuses one paid answer for the body | 功能回归 | 共享文本解码在保存 Reader 原始证据之前已将 NUL 换成 U+FFFD，导致原始 UTF-16 证据无法精确复原。 | 3565 |
| 35 | tests/core-rss-body-recovery.test.ts:175 | official content:encoded extraction creates one revision while preserving identity, permissions and paid identity | 测试传输 | 固定目录采用的本地代理夹具不处理新版 DNS-over-HTTPS 和 IP 钉扎的 CONNECT，content:encoded 未送达。 | 3580 |
| 36 | tests/core-rss-body-recovery.test.ts:175 | official description extraction creates one revision while preserving identity, permissions and paid identity | 测试传输 | 同一代理夹具不处理 DoH 和 IP 钉扎，description 未送达。 | 3600 |
| 37 | tests/core-rss-body-recovery.test.ts:214 | a config change while the feed is in flight prevents a stale body write | 测试传输 | 本地代理拒绝新版 DoH 通路，配置改动测试由 5 秒兜底放行，未验证实际在途响应与 CAS 的交错。 | 3620 |
| 38 | tests/core-rss-body-recovery.test.ts:214 | a revision change while the feed is in flight prevents a stale body write | 测试传输 | 本地代理拒绝新版 DoH 通路，版本改动测试由 5 秒兜底放行，未验证实际在途响应与 CAS 的交错。 | 3640 |
| 39 | tests/core-rss-body-recovery.test.ts:214 | a url change while the feed is in flight prevents a stale body write | 测试传输 | 本地代理拒绝新版 DoH 通路，URL改动测试由 5 秒兜底放行，未验证实际在途响应与 CAS 的交错。 | 3660 |
| 40 | tests/core-rss-body-recovery.test.ts:214 | a revoke change while the feed is in flight prevents a stale body write | 测试传输 | 本地代理拒绝新版 DoH 通路，许可撤销改动测试由 5 秒兜底放行，未验证实际在途响应与 CAS 的交错。 | 3680 |
| 41 | tests/core-source-promotion.test.ts:93 | promoting a settled auto-created source resumes normal editorial extraction | 本轮已修复 | 切换模式后，通过原事务把分析遗漏的已跳过文章排入正文队列。 | 3700 |
| 42 | tests/core-source-promotion.test.ts:115 | resumed extraction and analysis publish the fetched body at its current revision | 本轮已修复 | 正文提取走正常处理和发布路径，publications 与 revision 对齐。 | 3720 |
| 43 | tests/core-source-promotion.test.ts:139 | hot-signal promotion analyzes a ready body without fetching and retains relevance filtering | 本轮已修复 | 已有可用正文的热度来源进入分析队列，现有相关性过滤继续生效。 | 3740 |
| 44 | tests/core-source-promotion.test.ts:159 | promotion preserves history, material identity and manual editorial/grouping overrides | 本轮已修复 | 保存版本、分析和手工覆盖。旧归档评论按新版允许结算但不生成事件。 | 3758 |
| 45 | tests/core-source-promotion.test.ts:190 | only skipped articles without a current-revision analysis resume | 本轮已修复 | 只恢复无现行 revision 分析的 skipped 材料。 | 3782 |
| 46 | tests/core-source-promotion.test.ts:223 | unrelated, no-op and reverse changes do not restart work; promotion remains idempotent | 本轮已修复 | 无关编辑、不变操作和反向切换均不重复启动。 | 3800 |
| 47 | tests/core-source-promotion.test.ts:252 | promotion retains paused state and a late non-editorial completion cannot skip resumed work | 本轮已修复 | 来源暂停和慢到的旧回调仍受原事务锁和状态保护。 | 3808 |
| 48 | tests/core-source-promotion.test.ts:267 | large promotion resets every eligible item, queues the newest 500, and sweep recovers the rest | 本轮已修复 | 大来源完成状态恢复，立即入队范围限制为 500，其余由正常 sweep 接续。 | 3826 |
| 49 | tests/core-source-promotion.test.ts:296 | failure after processing job insertion rolls back source, article reset and queued jobs together | 本轮已修复 | 创建任务失败触发统一回滚，来源版本、材料状态、入队保持一致。 | 3850 |
| 50 | tests/core-source-promotion.test.ts:332 | overlapping promotion and old settlement leave the unscheduled tail recoverable | 本轮已修复 | 重叠结算不抹掉恢复状态，剩余材料仍可由 sweep 接续。 | 3880 |
| 51 | tests/corescope-runtime-job.test.ts:77 | Windows Scheduler heartbeat outlives last private kill-on-close Job handle; its same-Job controls die | Windows 夹具波动 | 独立 Scheduler/Job 断言及心跳已通过。失败在本机临时目录 EBUSY。加入有界重试后定向用例通过，全套清理仍复现。 | 3898 |
| 52 | tests/corescope-source-upgrade.test.ts:220 | non-article isolation hides public scope immediately and queues normal republishing without changing evidence | 功能回归 | 来源隔离后文章已隐藏，原故事的派生摘要未被事务失效。公开摘要与综述有二次证据检查，存留故事标题和内部派生状态仍需回归。 | 3911 |
| 53 | tests/dajiala.test.ts:1 | tests\dajiala.test.ts | Windows 测试已修 | 用例文件起动前临时库重名 42P04。独立补跑 2/2，当前运行器为副本加随机后缀。 | 3931 |
| 54 | tests/detail-publication-date.test.ts:69 | bounded detail-only dates advance over later rounds and survive authoritative repeat listings | 混合待复核 | 夹具时间和日期游标与现有初始化时间减 48 小时及 detailAfter/detailRules 契约不同。当前用例未验证正式来源的重复列表和滚动详情行为。 | 3935 |
| 55 | tests/detail-publication-date.test.ts:83 | unfetched and still-undated candidates are withheld and can acquire a source date later | 混合待复核 | 日期候选的准入窗口不同，空候选未测试到预期二次补日期。需要对齐时间和游标后重验。 | 3959 |
| 56 | tests/detail-publication-date.test.ts:97 | a globally known undated article can be checked without duplicating or revising its original owner | 功能回归 | 已有身份但属其他来源时，详情补查被提前跳过，缺少将已核实的日期用于发现证据的路径。未改写于原所有者的约束需保存。 | 3982 |
| 57 | tests/detail-publication-date.test.ts:129 | permanently undated and failing details cannot starve later dated articles or a new listing head | 混合待复核 | 旧夹具断言 detailDateAfterIdentity，当前使用 detailAfter。失败不足以证明实际候选饥饿，需用当前游标重验。 | 4000 |
| 58 | tests/detail-publication-date.test.ts:151 | a changed listing that drops the saved detail position restarts safely at its head | 混合待复核 | 夹具预置旧游标且受时间范围影响，未确认列表换头行为。 | 4020 |
| 59 | tests/detail-publication-date.test.ts:159 | a failed material commit preserves the detail position and storage keeps original listing order | 混合待复核 | 日期范围与旧游标使预期的提交故障点未触发，事务和保序断言没有被按原输入覆盖。 | 4043 |
| 60 | tests/error-page-extraction.test.ts:91 | a missing target stays unconfirmed and its paid response is reused, not bought again | 功能回归 | 审计 Reader 接受软 404 标题且没有 HTTP 错误提示的返回，正文可能误标 ok。 | 4061 |
| 61 | tests/error-page-extraction.test.ts:106 | a body read through the reader leaves out the page's consent banner | 功能回归 | 审计 Reader 请求缺少原有 removeSelector，合法正文中可能保留同意横幅等页面结构。 | 4081 |
| 62 | tests/extraction-consistency.test.ts:83 | a stale page empty response cannot change newer material | 测试夹具已修 | 空网页夹具仍允许不必要的 Jina 兜底，撞上本地测试关闭额度。该纯原站并发用例显式关闭兜底后通过。 | 4099 |
| 63 | tests/extraction-consistency.test.ts:83 | a stale X Article successful response cannot change newer material | 测试夹具已修 | 旧 X 样本未给 provider，应用不会隐式请求 SocialData。补充明确提供商身份后实际模拟请求及并发断言通过。 | 4116 |
| 64 | tests/extraction-consistency.test.ts:83 | a stale X Article empty response cannot change newer material | 测试夹具已修 | 同上。明确 provider 后验证晚到的空 X 正文不会改动新 revision。 | 4120 |
| 65 | tests/extraction-consistency.test.ts:176 | an obsolete extraction failure cannot penalize a newer complete report | 测试夹具已修 | 队列测试补齐提供商身份，并有界等待请求触发。旧错误不会写入新版文章的重试状态。 | 4124 |
| 66 | tests/jina-listing.test.ts:67 | a listing read whose outcome is unknown is not sent again; each later fetch is a paid read of its own | 规则差异 | 列表待处理游标持有未确认 round，新版不在每次轮询重新购买。旧用例要求每次抓取用新回执。 | 4128 |
| 67 | tests/jina-listing.test.ts:139 | a listing page received before a storage failure stays on its receipt | 规则差异 | 入库失败后同轮复用已收到的内容，旧用例按四次提供商调用计数，实际为三次。 | 4146 |
| 68 | tests/jina-listing.test.ts:160 | each admin preview is a paid read of its own, even at the same clock reading | 功能缺口 | 后台预览复用采集器的待处理游标，可能被未确认回执阻挡。列表功能与其计费策略未改动。 | 4164 |
| 69 | tests/listings.test.ts:1 | tests\listings.test.ts | Windows 测试已修 | 临时库重名 42P04。独立补跑 4/4。 | 4179 |
| 70 | tests/mentions.test.ts:59 | an event page is sent the pages its overview names | 功能缺口 | 模型页链接正常。事件页的谷歌中文别名没被主题自动链接规则识别。 | 4183 |
| 71 | tests/mentions.test.ts:71 | a report is sent the pages its lead and summaries name | 功能缺口 | 报告里的英伟达中文名未作为可单独匹配的实体别名，缺少已有主题链接。 | 4205 |
| 72 | tests/provenance.test.ts:1 | tests\provenance.test.ts | Windows 测试已修 | 初次因临时库重名未执行。独立补跑 10/11，余一项夹具假定 T1 自动等于第一方。 | 4227 |
| 73 | tests/related-evidence.test.ts:1 | tests\related-evidence.test.ts | Windows 测试已修 | 临时库重名 42P04。独立补跑 9/9。 | 4231 |
| 74 | tests/report-recovery.test.ts:72 | report publication and its receipt commit together and recovery reuses the response | 功能回归 | 周期报告模板缺少新 prompt 变量，写作前已降级为纯文本，未产生本该受事务保护的模型回执。应先对齐模板再重验回执回滚。 | 4235 |
| 75 | tests/report-shutdown.test.ts:31 | a weekly writer refused after the stop began leaves catch-up without a failure and the issue unpublished | 功能回归 | 同一周期报告 prompt 缺变量，writer 还未发送便走降级。不是 Windows 停机信号导致的断言失败。 | 4250 |
| 76 | tests/reports.test.ts:41 | a weekly that froze no summaries shows the articles' public summaries | 规则差异 | 报告读端从当前显式 first_party 字段确认一方出处，旧用例只设 T1，没有实际设置一方出处。 | 4266 |
| 77 | tests/rss-conditional.test.ts:1 | tests\rss-conditional.test.ts | Windows 测试已修 | 临时库重名 42P04。独立补跑 2/2。 | 4284 |
| 78 | tests/schedule-retirement.test.ts:15 | retired schedules leave the current overview and execution queues while live jobs and history remain | 规则差异 | CoreScope 保留退役调度的任务队列和历史，仅取消调度。上游测试要求删除队列，不能用该断言自动删除旧任务证据。 | 4288 |
| 79 | tests/signals-rematch-window.test.ts:78 | an 18-hour earlier discussion gets the ordinary judge when the delayed report arrives | 规则差异 | 信号已正确挂到事件。新版结果多 rematched 字段，旧整体对象断言因结果形状不同失败。 | 4333 |
| 80 | tests/signals-rematch-window.test.ts:94 | a kept report rematches discussion imported after it first founded its fact | 功能回归 | 已归组的同一事实命中 kept 时未触发即时重匹配。原周期 sweep 仍在，不能证明晚到的讨论会立刻结算。 | 4356 |
| 81 | tests/signals-rematch-window.test.ts:104 | repeated UNRELATED matching reuses a decision and never spends or appends another decision | 功能回归 | 答过的事实过滤掉重复模型调用，仍附加空的 unmatched 记录，决议行数量不符合幂等目标。 | 4374 |
| 82 | tests/signals-rematch-window.test.ts:123 | revision-only changes reuse the receipt; changed model input is judged once | 功能回归 | 已答事实在输入指纹校验前被过滤掉。仅修订版本的复用和正文变化后的重新判断未走同一决议。 | 4392 |
| 83 | tests/signals-rematch-window.test.ts:149 | changed candidate facts are judged once, while their unchanged negative is reused | 测试夹具 | 模型 stub 缺新版 selection 字段，提前校验失败。候选事实变化后的实际判断仍需重验。 | 4410 |
| 84 | tests/source-collector-replacement.test.ts:1 | tests\source-collector-replacement.test.ts | Windows 测试已修 | 临时库重名 42P04。独立补跑 3/3。 | 4434 |
| 85 | tests/topic-membership.test.ts:1 | tests\topic-membership.test.ts | Windows 测试已修 | 临时库重名 42P04。独立补跑 2/2。 | 4438 |
| 86 | tests/topics-withdrawal.test.ts:1 | tests\topics-withdrawal.test.ts | Windows 测试已修 | 临时库重名 42P04。独立补跑 2/2。 | 4442 |
| 87 | tests/translate.test.ts:611 | SIGTERM finishes the sent normal batch and resumes from its receipt | Windows 测试已修 | Windows 的子进程 kill(SIGTERM) 不走 fixture 的停止 ACK。使用同样的子进程停止处理器和 Windows IPC 复验正常批。 | 4446 |
| 88 | tests/translate.test.ts:611 | SIGTERM finishes the sent misaligned batch and resumes from its receipt | Windows 测试已修 | Windows 通过 IPC 触发同一停止处理器，复验不对齐批可恢复。 | 4450 |
| 89 | tests/translate.test.ts:642 | a batch the provider refuses after SIGTERM is an interruption, not a translation attempt | Windows 测试已修 | Windows 通过 IPC 触发同一停止处理器，服务端拒绝仍保留中断语义。 | 4454 |
| 90 | tests/x-article.test.ts:116 | a post a module reads (sources.uses) has its X Article fetched while it is news; one nobody reads whole is grouped as it is | 功能缺口 | 非编辑来源已有模块索取全文时，队列仍走仅事件分支。新版适配漏了全量正文分支，现装模块未提供同类使用证据。 | 4458 |
| 91 | tests/x-fulltext-license.test.ts:234 | R08: an unlicensed quote-only X structure does not restore content | 规则差异 | 未许可的纯引用样本首先被 CoreScope 摘要门槛挡住，测试在准备步骤中断。此结果不能用来证明引用泄露，也不能代替该场景的公开读端检查。 | 4478 |
| 92 | tests/x-original-posts.test.ts:48 | empty and link-only posts preserve originals without calling either writer, even above the selection threshold | 规则差异 | 空帖和仅链接的样本未满足 CoreScope 既有摘要门槛，仍保存原材料但不进入公开池。 | 4497 |
| 93 | tests/x-original-posts.test.ts:74 | rebuilding an image-only post replaces historical model replies across public outputs and preserves its image and address | 规则差异 | 仅图帖的原图及材料仍可留存。夹具期望无摘要也显示，和现行公开门槛冲突。 | 4515 |
| 94 | tests/x-shards.test.ts:90 | one search reads a shard; each account gets its own posts, run and watermark | 功能缺口 | SocialData 共用批次水位，各账号记录同一个最大 ID。Xquik 和 Bird 路线有各自水位，其他路线的晚到数据有遗漏风险。 | 4530 |
| 95 | tests/x-shards.test.ts:108 | a page failing after the first keeps what was read and goes on from there next run | 功能缺口 | 分页部分失败后，静默账号仍推进到共享水位。原 SocialData 实现已采用共享策略，需按账号验证晚到恢复。 | 4555 |
| 96 | tests/x-shards.test.ts:133 | posts of an account regrouped elsewhere since a stretch was left over still reach it | 功能问题 | 旧共享批次续页返回已迁走账号帖子，分发只含当前分组成员。测试中该帖未入库，旧回执仍可能结算。 | 4576 |
| 97 | tests/x-shards.test.ts:156 | a post in the ten minutes before a check leaves the next search those ten minutes back | 功能缺口 | 静默账号的十分钟回看仍按共享结果推进。未证明当前 Bird 路线受影响。 | 4594 |
| 98 | tests/x-shards.test.ts:201 | verified publishers include self-thread announcements in both single and shared searches | 功能回归 | 分组计划考虑已核实账号的 thread 条件，实际共享搜索未带该规则。单源已有相应规则。 | 4614 |
| 99 | tests/x-shards.test.ts:289 | a lost commit answer never rolls a completed collection or source back | 功能问题 | 共享抓取失去已完成事务的 ACK 后，异常分支可以覆盖已完成运行记录和健康状态。测试证实实际记录不一致。 | 4629 |
