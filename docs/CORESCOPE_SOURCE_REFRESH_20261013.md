# 2026-10-13 AIHOT 最新公开观察补充

上一次“结合网站刷新再审视”仅生成差异表、显示名称与身份核查，没有修改来源配置或运行库。此前已接入的 191 个入口不包含这次新确认的 20 个入口。本轮落实到配置包、正式 CoreScope 库和实际采集路径；V2 始终只读。

## 当前配置与运行库

2026-10-13 19:52 CST 只读核验：**636 个来源，620 启用，16 停用**。RSS 250、网页列表 43、JSON 20、X 123、公众号 64、外部来源 136（120 启用）。123 个运行 X 来源均使用 Bird；老配置包的 114 个 X 默认仍是 Xquik，运行管理员配置优先。

此数为 CoreScope 真实目录，不是 AIHOT 的完整 878 源名单。当天 `/api/site/stats` 的 180 个样本、最新 309 条素材均不提供私有来源 ID 或完整采集配置。以下入口由公开原始网站与账号证据独立重建。

## 先去重，再增加入口

| 刷新观察 | 既有 CoreScope 来源 | 处理 |
| --- | --- | --- |
| Amazon Science（RSS） | `v2-source-91` | 现有官方 feed 包含同一篇最新原文，复用 |
| IBM Research：AI | `v2-source-73` | 现有官方 feed 包含同一篇最新原文，复用 |
| 公众号：火山引擎 | `corescope-mp-volcengine` | 已配置相同公开 biz，复用 |
| 公众号：生数科技 | `corescope-mp-shengshu` | 已配置相同公开 biz，复用 |
| OpenAI Developers（X） | `corescope-x-openaidevs` | 精确账号 `OpenAIDevs` 已有，复用 |
| Baseten Base Labs | `corescope-web-list-baseten-co-7f6bc157` 为工程博客 | 研究入口不同，新增但共用 `publisher:baseten` |
| Benedict Evans、Mistral、Microsoft AI | 既有发布者路线 | 保留既有来源；统计别名不能证明独立入口相同，未重复新增 |

去重依据为精确 X handle、公众号 biz/ghid、有效 feed 与采集范围、网页入口与解析范围。公司名称相同不足以合并来源。原有 616 个来源 ID、配置、管理员供应商、采集间隔、许可和暂停均未改动。原 AIHOT 自站回流入口继续排除。

## 新增公开入口与真实采集

2026-10-13 19:43 CST，以下 8 个入口均通过正式 `collectSource` 入库。首轮每源最多 2 条；合计 16 条素材，保留原始发布日期并标为首批历史补录，不强制发布到今日热点。

| 来源 | 来源 ID | 原始入口 | 本轮解析 / 入库 | 参与方式 |
| --- | --- | --- | ---: | --- |
| InfoWorld | `corescope-rss-infoworld` | https://www.infoworld.com/feed/ | 20 / 2 | 热度信号 |
| Ben's Bites | `corescope-rss-bensbites` | https://www.bensbites.com/feed | 20 / 2 | 热度信号 |
| BleepingComputer | `corescope-rss-bleepingcomputer` | https://www.bleepingcomputer.com/feed/ | 15 / 2 | 热度信号 |
| Armin Ronacher | `corescope-rss-armin-ronacher` | https://lucumr.pocoo.org/feed.atom | 10 / 2 | 正常筛选；入口为全博客 |
| Berkeley RDI | `corescope-web-berkeley-rdi` | https://rdi.berkeley.edu/blog | 17 / 2 | 正常筛选 |
| Baseten Base Labs | `corescope-web-baseten-base-labs` | https://labs.baseten.co/articles | 6 / 2 | 正常筛选；逐篇读取原始详情日期 |
| Vapi | `corescope-web-vapi-blog` | https://vapi.ai/blog | 80 / 2 | 正常筛选 |
| OpenAI Developers | `corescope-rss-openai-developers-learning` | https://developers.openai.com/rss.xml | 138 / 2 | 独立学习资料，不入新闻筛选 |

OpenAI Developers RSS 最新原始日期为 2026-05-05，内容主要是指南与学习资料，不将抓取日期当成新闻日期。其官方地址已验证，但不能据此断言 AIHOT 私有 RSS 配置也使用这个地址。

## 新增 X 账号及验收边界

| 来源 ID | 精确账号 | 参与方式 | 身份依据 |
| --- | --- | --- | --- |
| `corescope-x-iamneubert` | `iamneubert` | 热度信号 | Nicolas Neubert 官网明确链接 |
| `corescope-x-ericschmidt` | `ericschmidt` | 热度信号 | Eric Schmidt 官网明确链接 |
| `corescope-x-rao2z` | `rao2z` | 热度信号 | ASU 官方个人页面明确链接 |
| `corescope-x-rauchg` | `rauchg` | 热度信号 | Guillermo Rauch 官网明确链接 |
| `corescope-x-lateinteraction` | `lateinteraction` | 热度信号 | Omar Khattab 官网明确链接 |
| `corescope-x-nathanbenaich` | `nathanbenaich` | 热度信号 | Nathan Benaich 官方个人页面明确链接 |
| `corescope-x-soumithchintala` | `soumithchintala` | 热度信号 | Soumith Chintala 官网明确链接 |
| `corescope-x-charlieholtz` | `charlieholtz` | 正常筛选 | 当天公开素材 source 标签与原帖 URL 同时指向账号 |
| `corescope-x-karinanguyen` | `karinanguyen` | 正常筛选 | 当天公开素材 source 标签与原帖 URL 同时指向账号 |

前 7 个账号当天 stats 明确 `heatOnly=true`；后 2 个素材 DTO 不提供上游参与方式，采用 CoreScope 的个人账号筛选规则。后 2 个详情链接早先错误拼为 `/item/`，得到 404；本轮改用实际 `/items/` 路径复查，两个页面均 HTTP 200 且包含精确账号原帖 URL。结构化审计保留旧检查记录，并在 `canonicalXPageCompletion` 给出最终更正证据。

9 个账号均已经写入正式库，路由 Bird `user_tweets`、48 小时初始范围、每轮 1 页、1440 分钟目标间隔，沿用现有每日轮询政策；首批完整单页上限 20。配置重生成保留此上限，非法值提前拒绝，不用 2 条上限推进并丢失已经确认的 Bird 页。

2026-10-13 19:44 CST 的 9 次正式采集入口检查均返回 `Budget for bird exhausted (hour)`，无新增 Bird 请求、无新增 X 素材。现有 worker 按原预算及退避继续调度，不能将已接入称为逐源真实验收通过。Bird 仍为 1 CLI/分钟、10/滚动小时、120/滚动日；模型仍为 20/分钟、180/小时、800/滚动日。本次快照模型日额度已满，采集入库不表示评分或发布已经完成。

另一个会话的 Bird 验收固定 114 个旧来源；本次 9 个新增账号应单独看状态，不扩大旧验收批次的成功数字。

## 新增公众号与实际请求

通过 AIHOT 当前可访问的 `/items/` 详情页，将来源卡片称呼与原始微信文章的精确 `biz` 对应，补入以下 3 个账号。它们与既有配置及已核查缓存账号标识无重复。微信原页有验证码，未验证公众号认证主体，按 T2、`first_party=false` 接入，不推断原 AIHOT 私有采集参数。

| 账号 | 来源 ID | 实际返回列表数 | 列表最新原始日期 | 本轮入库 |
| --- | --- | ---: | --- | ---: |
| DeepSeek | `corescope-mp-deepseek` | 9 | 2026-09-30 | 0 |
| 豆包 | `corescope-mp-doubao` | 8 | 2026-09-30 | 0 |
| 腾讯混元 | `corescope-mp-tencent-hunyuan` | 10 | 2026-09-24 | 0 |

2026-10-13 19:51 CST，3 个正式 `checkMpAccount` 均返回 `ok`，Dajiala 回执 3270、3271、3272 完成。列表文章超出既有首轮最近 7 天窗口，没有伪造当前新闻或扩大回填范围。本轮未请求这批旧文章正文，不能称为正文采集验收。原有 Dajiala 密钥与 5/分钟、60/小时、500/日预算保持，未输出或提交密钥。

## 待确认项与证据

31 个 X 显示名称仍缺精确账号证明；4 个疑似 X 别名未擅自合并。其他公开候选仍有未探测、解析失败、认证限制或采集范围不明的条目。结构化审计保留身份补证前的原始待查记录，后续 `mpIdentityCompletion` 与 `runtimeAcceptance` 才代表本轮最终结论，不能把早期快照当成当前缺口。

完整逐项差异、原始证据链接、核查时间与新增配置见 [结构化审计](corescope-source-refresh-20261013.json)。全量有效配置在 [industry/sources.json](../industry/sources.json)；三个 supplement 文件保留新增项，使 V2 只读刷新后仍可重生成。

接入前备份为 `.data/qa/source-refresh-integration-20261013/corescope-before-refresh.dump`（154,561,577 字节），`pg_restore --list` 验证通过。私有源配置快照、正式采集结果、素材元数据及验证日志留在该目录，不提交 `.data/` 或 `.env`。

从 V2 SQLite `mode=ro`、`PRAGMA query_only=ON` 重生成的 636 个配置与目标配置逐项相同：新增项不会丢失，旧配置不产生变化。最终正式库再核验：原 616 个来源配置逐项不变，新 20 个与配置包相同。

TypeScript 检查、网页生产构建、前端 32/32、独立空 `corescope_test` 后端 706/706、Python exporter 26/26 及正式站点 35 项 smoke 全部通过。测试不使用真实提供商；这些回归不代表受额度延期的 9 个 X 已完成真实采集，也不代表模型分析或公开发布已完成。
