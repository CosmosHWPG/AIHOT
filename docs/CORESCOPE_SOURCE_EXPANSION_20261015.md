# 2026-10-15 CoreScope：44项来源补齐与实际采集验收

本次固定的44项已全部进入配置包和独立 CoreScope 正式库。最终只读快照为 **2026-10-15T08:01:08.681Z（北京时间16:01:08）**：**680个来源，664启用、16停用**。原636项配置和管理员暂停逐字段保持，新增44项与配置包完全一致；V2始终只读。

实际验收结论：**39项采集检查成功，其中27项已有材料，12项成功但窗口内暂无可入库材料；5个公众号等待Dajiala充值后复验。** 新增来源已关联280个去重文章ID；这是采集后存储/关联的总量，不将它们全部称为本轮新建新闻，也不代表均已分析或发布。

| 来源类型 | 新增 | 本轮采集检查成功 | 已有去重材料的来源 | 等待验收 |
| --- | ---: | ---: | ---: | ---: |
| RSS | 4 | 4 | 4 | 0 |
| 网页（含METR资料） | 6 | 6 | 6 | 0 |
| X | 29 | 29 | 17 | 0（12个成功空窗口尚未观察到素材） |
| 公众号 | 5 | 0 | 0 | 5：余额不足20001 |
| 合计 | 44 | 39 | 27 | 5 |

当前全量分类：RSS254、网页49、JSON20、X152、公众号69、外部桥接136（其中120启用）。全部44项为36个正常筛选、7个热度信号、1个独立资料。

## 去重与已有来源复用

44项与原636项之间、44项内部均无精确采集身份重复或ID冲突。X按精确handle忽略大小写比较，公众号按biz并结合已验证缓存身份比较；RSS/网页比较实际入口与文章范围。文章层继续使用原始URL/平台文章ID去重，同文多入口只增加发现记录。

| 重复或同名观察 | 实际处理 |
| --- | --- |
| Goodfire Research | 复用 `corescope-web-list-goodfire-com-eca9a77c`，不另建 |
| Cartesia | 复用 `corescope-web-list-cartesia-ai-03bf92a2`，不另建 |
| Lauren Tan / poteto | 复用 `corescope-x-poteto`，显示标签变化不另建账号 |
| SpaceXSI | 复用 `corescope-x-spacexai`，沿用稳定ID |
| METR | 原Blog保留；新增仅采 /evaluations/ 的独立资料频道，拒绝 /blog/ |
| OpenAI Developers | 原Learning RSS保持资料模式；新增Blog网页频道，现有RSS不覆盖本次Blog文章 |
| 小米MiMo、蚂蚁百灵的多平台频道 | X和公众号按不同身份保留，不因品牌同名误删 |

同发布者的不同频道可以保留；同一发布者共用signal_group_id不等于重复来源。29个新X中19个没有上游角色字段，采用CoreScope正常筛选策略；不把AIHOT显示标签中的职位、雇主或“官方号”字样当作认证或一手来源证明。本次44项也不等于已获得AIHOT私有全量目录。

## 公开RSS、网页和资料：10项均已实际采集

| 来源 | 稳定 ID | 参与方式 | 最新轮返回数 | 去重材料数 | 验收状态 |
| --- | --- | --- | ---: | ---: | --- |
| [Chips and Cheese](https://chipsandcheese.com/feed) | `corescope-rss-chips-and-cheese` | 热度信号 | 20 | 20 | 采集成功，有素材入库/关联 |
| [METR · 模型评测资料](https://metr.org/research/) | `corescope-web-metr-evaluations-resources` | 独立资料 | 9 | 9 | 采集成功，有素材入库/关联 |
| [Anthropic：Transformer Circuits](https://transformer-circuits.pub/feed.xml) | `corescope-rss-transformer-circuits` | 正常筛选 | 56 | 2 | 采集成功，有素材入库/关联 |
| [HumanLayer Blog](https://www.humanlayer.dev/blog) | `corescope-web-humanlayer-blog` | 正常筛选 | 11 | 11 | 采集成功，有素材入库/关联 |
| [Inception Labs：Blog](https://www.inceptionlabs.ai/blog) | `corescope-web-inception-blog` | 正常筛选 | 13 | 13 | 采集成功，有素材入库/关联 |
| [Eugene Yan：Writing](https://eugeneyan.com/rss/) | `corescope-rss-eugene-yan` | 正常筛选 | 212 | 2 | 采集成功，有素材入库/关联 |
| [张小珺商业访谈录（播客 RSS）](https://feed.xyzfm.space/dk4yh3pkpjp3) | `corescope-rss-zhangxiaojun-podcast` | 正常筛选 | 157 | 157 | 采集成功，有素材入库/关联 |
| [Ideogram Blog](https://ideogram.ai/blog/) | `corescope-web-ideogram-blog` | 正常筛选 | 5 | 2 | 采集成功，有素材入库/关联 |
| [LTX Product Updates](https://ltx.io/blog-category/product-updates) | `corescope-web-ltx-product-updates` | 正常筛选 | 42 | 2 | 采集成功，有素材入库/关联 |
| [OpenAI Developers：Blog（网页）](https://developers.openai.com/blog) | `corescope-web-openai-developers-blog` | 正常筛选 | 31 | 2 | 采集成功，有素材入库/关联 |

“最新轮返回数”是解析器返回候选数；日期、入口过滤、首轮上限及全局判重会影响实际入库数。后续普通轮次可以继续处理既有列表窗口，不能将每次解析数相加当成新文章数量。所有来源保持摘要与原文链接展示策略。

**METR历史评测按资料处理。** 9份评测的原始发布日期逐条与页面证据一致，全部backfill=true，timeline保持原日期；processing_state=skipped，publication=withdrawn，新闻池0、精选0、热点信号0、分析0、模型回执0。[资料页](http://127.0.0.1:8780/resources)和资源API均HTTP200，目录卡状态为monitored。该页提供资料入口和监测状态，逐篇评测仍从METR原站浏览。

## X账号：29项已通过正式采集入口

| 来源 | 稳定 ID | 参与方式 | 最新轮返回数 | 去重材料数 | 验收状态 |
| --- | --- | --- | ---: | ---: | --- |
| [Niels Rogge · X](https://x.com/NielsRogge) | `corescope-x-nielsrogge` | 热度信号 | 3 | 3 | 采集成功，有素材入库/关联 |
| [Graham Neubig · X](https://x.com/gneubig) | `corescope-x-gneubig` | 热度信号 | 2 | 2 | 采集成功，有素材入库/关联 |
| [Jeremy Howard · X](https://x.com/jeremyphoward) | `corescope-x-jeremyphoward` | 热度信号 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [AI at Meta · X](https://x.com/AIatMeta) | `corescope-x-aiatmeta` | 正常筛选 | 2 | 2 | 采集成功，有素材入库/关联 |
| [Kimi.ai · X](https://x.com/Kimi_Moonshot) | `corescope-x-kimi-moonshot` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Dan Hendrycks · X](https://x.com/hendrycks) | `corescope-x-hendrycks` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Jan Leike · X](https://x.com/janleike) | `corescope-x-janleike` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Elvis Saravia · X](https://x.com/omarsar0) | `corescope-x-omarsar0` | 热度信号 | 12 | 12 | 采集成功，有素材入库/关联 |
| [Chris Olah · X](https://x.com/ch402) | `corescope-x-ch402` | 热度信号 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Tri Dao · X](https://x.com/tri_dao) | `corescope-x-tri-dao` | 热度信号 | 1 | 1 | 采集成功，有素材入库/关联 |
| [Larsen Cundric · X](https://x.com/larsencc) | `corescope-x-larsencc` | 正常筛选 | 14 | 14 | 采集成功，有素材入库/关联 |
| [matt palmer · X](https://x.com/mattyp) | `corescope-x-mattyp` | 正常筛选 | 2 | 2 | 采集成功，有素材入库/关联 |
| [Muse · X](https://x.com/Muse) | `corescope-x-muse` | 正常筛选 | 6 | 6 | 采集成功，有素材入库/关联 |
| [Ado · X](https://x.com/adocomplete) | `corescope-x-adocomplete` | 正常筛选 | 0 | 5 | 采集成功，有素材入库/关联 |
| [dominik kundel · X](https://x.com/dkundel) | `corescope-x-dkundel` | 正常筛选 | 1 | 1 | 采集成功，有素材入库/关联 |
| [Lydia Hallie ✨ · X](https://x.com/lydiahallie) | `corescope-x-lydiahallie` | 正常筛选 | 2 | 2 | 采集成功，有素材入库/关联 |
| [Alexander Embiricos · X](https://x.com/embirico) | `corescope-x-embirico` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Meta Newsroom · X](https://x.com/MetaNewsroom) | `corescope-x-metanewsroom` | 正常筛选 | 3 | 3 | 采集成功，有素材入库/关联 |
| [Ammaar Reshi · X](https://x.com/ammaar) | `corescope-x-ammaar` | 正常筛选 | 0 | 2 | 采集成功，有素材入库/关联 |
| [Christine Awad · X](https://x.com/christinesed) | `corescope-x-christinesed` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Danny Trinh · X](https://x.com/dtrinh) | `corescope-x-dtrinh` | 正常筛选 | 1 | 1 | 采集成功，有素材入库/关联 |
| [David Singleton · X](https://x.com/dps) | `corescope-x-dps` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Lingxi Li · X](https://x.com/lingxi) | `corescope-x-lingxi` | 正常筛选 | 2 | 2 | 采集成功，有素材入库/关联 |
| [Peng Zheng · X](https://x.com/pengzheng_) | `corescope-x-pengzheng-` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Roshan Sadanani · X](https://x.com/roshan_s) | `corescope-x-roshan-s` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Xiaomi MiMo · X](https://x.com/XiaomiMiMo) | `corescope-x-xiaomimimo` | 正常筛选 | 1 | 1 | 采集成功，有素材入库/关联 |
| [Alex Cornell · X](https://x.com/alexcornell) | `corescope-x-alexcornell` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |
| [Balta · X](https://x.com/baltaaazr) | `corescope-x-baltaaazr` | 正常筛选 | 0 | 1 | 采集成功，有素材入库/关联 |
| [Tarek Sheasha · X](https://x.com/bigT_sheesh) | `corescope-x-bigt-sheesh` | 正常筛选 | 0 | 0 | 采集成功，窗口内无可入库素材 |

全部使用Bird user_tweets，48小时初始范围、每轮1页、首轮上限20、配置目标间隔1440分钟。原生调度器会根据游标覆盖情况调整下次时间，短期回填重试时间不等于配置间隔被改写。最新轮14源返回候选、15源返回0；其中3个返回0的账号已有之前成功轮次的素材，因此累计17源有素材、12源暂无素材。成功空结果不算采集失败；这些12源的非空正文和入库仍需未来新帖观察。

29源都有关联的completed回执。最新轮按subject和attempt/update时间核对，28次live attempt、1次已有回执复用（Balta）；fetch_runs.detail没有显式receiptIds/reused字段，不能将其说成该字段直接证明的结论。receipt.origin记录原请求来源，复用后仍为live，不伪造cache类别。

## 公众号：5项已接线，均因余额不足等待复验

| 来源 | 稳定 ID | 参与方式 | 最新轮返回数 | 去重材料数 | 验收状态 |
| --- | --- | --- | ---: | ---: | --- |
| [公众号：智谱](https://mp.weixin.qq.com/s?__biz=MzkyMzI3NzQ0Mg%3D%3D&mid=2247493980&idx=1&sn=995ae194e71d723b6110fb8c621e618c) | `corescope-mp-zhipu` | 正常筛选 | 0 | 0 | 待充值复验：20001 |
| [公众号：京东JoyAI](https://mp.weixin.qq.com/s?__biz=MzU0MjU0MDMzMw%3D%3D&mid=2247487258&idx=1&sn=744e8842e6bccdc2821e275bc80dda32) | `corescope-mp-jd-joyai` | 正常筛选 | 0 | 0 | 待充值复验：20001 |
| [公众号：小米 MiMo](https://mp.weixin.qq.com/s?__biz=Mzk3NTkxMTM2NA%3D%3D&mid=2247484810&idx=1&sn=d4107cecaf17c3e234daa2c3d782ee03) | `corescope-mp-xiaomi-mimo` | 正常筛选 | 0 | 0 | 待充值复验：20001 |
| [公众号：蚂蚁百灵](https://mp.weixin.qq.com/s?__biz=MzkyODk2MDQwNw%3D%3D&mid=2247488073&idx=1&sn=1deff0f84dce1931113975e212a91644) | `corescope-mp-ant-ling` | 正常筛选 | 0 | 0 | 待充值复验：20001 |
| [公众号：千问APP](https://mp.weixin.qq.com/s?__biz=MzYzNDE5MDEwMQ%3D%3D&mid=2247489149&idx=1&sn=26d7fefe24bfb18efa4582467313b1eb) | `corescope-mp-qwen-app` | 正常筛选 | 0 | 0 | 待充值复验：20001 |

这5个账号都已通过正式checkMpAccount发出真实Dajiala mp_history请求，各有1次live失败回执：智谱35801、小米MiMo35802、蚂蚁百灵35803、京东JoyAI35805、千问APP35806。接口统一返回 **insufficient balance（code20001）**，文章列表、正文和入库均未验收通过；不是未接适配器，也不能标作无近期更新。

待办条件是为现有Dajiala账户充值，然后通过原生采集器复验这5项。保留现有本机密钥，无需重新提交密钥。本次确认失败后未重复购买请求、未放宽7天首轮公众号新闻窗口。

## 配置持久化、运行边界与验证

全量有效配置是 [industry/sources.json](../industry/sources.json)。本次公开入口、X、公众号分别落入 [公开入口补充包](../industry/corescope-online-supplement.json)、[X补充包](../industry/corescope-online-x-supplement.json)、[公众号补充包](../industry/corescope-online-mp-supplement.json)；METR资料策略落入 [来源档案](../industry/corescope-source-profiles.json)。从V2 SQLite以mode=ro、query_only重生成时，680/680配置逐字段相同。本次未改V2数据库、配置或服务，未启停正式服务。

运行中的只读桥通过既有seedSources将44项自动插入CoreScope，ON CONFLICT保留既有配置；本轮幂等核对确认44项已同步、原636项未变，并留下44条source.review审计。模型分析与发布继续按原规则，不改评分、精选或时间门槛，不强制发布采集结果。

预算配置及开关本次均未改动。最终核对Bird和LLM数量预算enabled=false、Dajiala=true，数值限额与接入前一致；接入前预检未记录enabled，所以不能以计数超过数值上限推断Bird会被熔断。所有真实提供商请求仍经回执记录。

验证结果：Node24.20.0；类型检查通过；前端构建通过；前端测试40/40；Python导出测试26/26；站点35项smoke全部通过。**后端全套783/784**，唯一失败为既有admin-budget-switch测试GET /api/admin/settings一次返回500；同隔离环境的单项诊断随后1/1通过。该实现本轮未修改，原500正文未保留，根因未确认，不能将单项成功改写成全套全绿。

接入前备份为 `.data/qa/source-refresh-implementation-20261015/corescope-before-refresh.dump`，346,246,690字节，pg_restore --list验证通过。私有配置快照、逐轮结果、资源与回执复核、测试日志都在同一忽略目录；密钥、.env、数据库和.data未提交。完整44项配置、身份证据及逐源验收见 [结构化交付记录](corescope-source-expansion-20261015.json)。
