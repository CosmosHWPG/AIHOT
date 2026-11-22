# 2026-11-22 CoreScope 增补四个 X 来源

按用户确认的账号和参与方式，使用 CoreScope 现有 Bird `user_tweets` 采集。配置保存在[全量信源](../industry/sources.json)及[X 补充包](../industry/corescope-online-x-supplement.json)，随默认 seed 和后续目录合并保留。

| 账号 | CoreScope 来源 ID | 参与方式 | 身份证据 |
|---|---|---|---|
| `@KateClarkTweets` | `corescope-x-kateclarktweets` | `editorial` | [AIHOT 条目与原帖](https://aihot.news/items/hzlbq0fxcls8sxek76qoq63v8) |
| `@edbayes` | `corescope-x-edbayes` | `editorial` | [AIHOT 条目与原帖](https://aihot.news/items/czp2y4hzb8bf1qhwlqzvw7a7g) |
| `@mark_k` | `corescope-x-mark-k` | `hot_signal` | [AIHOT 公开统计样本](https://aihot.news/api/site/stats) |
| `@levelsio` | `corescope-x-levelsio` | `hot_signal` | [AIHOT 公开统计样本](https://aihot.news/api/site/stats) |

每个作者使用独立信号组。首次查最近 48 小时，每轮一页，常规采集间隔 24 小时。续页由现有调度处理。Editorial 沿用相关性、评分、公开及精选规则。热度材料进入事件匹配，匹配到的证据按独立参与者和现有衰减公式计入热度。仅匹配到公开事件的信号可能影响热点榜。全文公开和联合发布均关闭。

## 正式运行库

北京时间 12:24 使用独立 CoreScope 数据库的身份锁和审计事务追加这四项。原有 731 项的配置逐项比较一致，预算配置逐行一致。运行库共 735 个来源，其中 719 个启用、174 个为启用的 Bird X 来源。现有 Windows worker 承接首轮与续页。

## 在线验收

北京时间 12:40 快照。四个首轮均由常驻 worker 执行。`@mark_k` 单源核对一次已到期续页，`@levelsio` 核对两次。续页通过既有 Bird 运维命令使用现有作者游标、账户互斥和回执。

| 账号 | 成功轮次与已结算 Bird 回执 | 新增入库 | 可公开展示或热度结果 |
|---|---|---:|---|
| `@KateClarkTweets` | 1 次，435521 | 0 | 首次 48 小时覆盖完成。原回执中窗口内的条目经作者与去转发筛选后没有可入库帖，本轮没有公开样本。 |
| `@edbayes` | 1 次，435511 | 1 | 首次 48 小时覆盖完成。公开「全部动态」X 栏目、详情页和 API 均查到该帖。详情页及 API 返回 200 并保留原帖链接。 |
| `@mark_k` | 2 次，435526、435566 | 26 | 首次 48 小时覆盖完成。7 条匹配到 7 个事件，计入正常热度计算，另外 19 条未匹配现有事件。 |
| `@levelsio` | 3 次，435522、435565、435588 | 5 | 5 条已完成热度匹配检查，均未关联事件，当前无热度增量。两次续页无新增，48 小时覆盖状态仍为 `partial`，剩余分页由常驻 worker 处理。 |

- [Ed Bayes 的 CoreScope 展示](http://127.0.0.1:8780/items/p65l9mlp6ohme8rswh99sjij8)和[X 原帖](https://x.com/edbayes/status/2123853665266200773)可核对当前公开样本。
- 两个热度来源的入库材料公开数量均为零。公开详情 API 和 HTML 逐源抽查均返回 404。使用同一生产热度函数核对 `@mark_k` 的事件关联，命中事件的公开详情 API 返回 200。
- 既有发布门槛继续生效。Kate Clark 的展示要等自然新帖。热度材料是否为事件贡献分值由原有归组规则决定。

## 回归

全项目类型检查、隔离库后端 993 项、前端 40 项、目录导出 26 项、隔离前端生产构建以及运行站点 35 项 smoke 均通过。静态包确认仅增加 4 项，原有 731 项信源对象和 436 项 V2 映射行一致。无须重启 CoreScope。核对期间 CoreScope 与 V2、BirdClaw 监听进程的 PID 保持一致。
