# CoreScope：AIHot 最近两天信息源审视与补齐（2026-11-02）

**已新增1项：公众号“龙猫LongCat（美团）”。正式库当前731项，715启用、16停用；公众号72项、X170项。原730项的14个来源字段和全部预算开关/限额保持不变，V2保持只读。**

**实际采集尚未成功：Dajiala在北京时间11月2日21:55:52拒绝首次列表请求，错误码20001（余额不足）。1次live列表请求、0次正文请求、0篇入库；不是“账号无更新”。已告知需要充值，未重复刷接口、改预算或清失败状态。**

## 审视范围与新增差异

- 固定滚动48小时：北京时间2026-10-31 21:44:21至2026-11-02 21:44:21。API仅支持24h/7d，使用7d分页后以原发表或发现时间筛选48h，未改写日期。
- 主列表按timeline/published各11页取得1081个唯一条目，其中121条落窗；10个热点37条报道中25条落窗，补充3个条目。最终并集124条、45个来源标签。
- 对比11月1日保存的1088个唯一ID，新增观察63条、32个标签；这63条均在上次抓取截止后有发表或发现时间。新增条目数不等于新增来源数。
- 22个X精确handle均已存在；5个公众号biz中4个已存在，只有LongCat缺失。18个公开标签中17个有既有频道范围，HN的精确AI热帖查询/排序仍未证实。
- 4次公开RSS预览确认Sakana、OpenRouter、Browser Use、Latent Space的5个本批原文已在现有feed；其余13项仅核对配置范围，没有声称本轮逐篇采集。
- AIHot公开stats显示941个启用来源；本次45标签不代表其私有全量目录，也不按站点总数猜补来源。

## 新增来源与去重

- 稳定ID：`corescope-mp-longcat-meituan`；精确biz：`MzYyMTA0NTc5NQ==`；既有Dajiala原生`mp_history`与`mp_article`路径，正常间隔180分钟。
- 原730源（包括停用来源）、71个公众号身份、公开历史映射/verified profiles和授权缓存中均无同号。已有“美团技术”的biz为MjM5NjQ5MTI5OA==，与本账号不同；数字生命卡兹克已由v2-source-7176覆盖，不重复建别名。
- 首次检查沿用现有7天年龄门和最多2篇，不强制导入历史，不把旧日期改成今天。源为editorial，全文展示/再分发均关闭；first_party=false，不把AIHot标签或验证码页当作独立官方归属认证。
- 配置包及独立库已追加。先通过只读dry-run，再以完整配置CAS和身份锁插入，source.create审计4363；升级器复核为1 unchanged（说明新行已插入，无需二次改路由），0 updated、0 skipped。

## 实际采集与待验收

- 本次fetch_run：`225700` failed insufficient_balance_20001。
- 提供商回执：`235384` mp_history / failed / live。
- 当前列表成功：否；新建材料0篇；正文成功0篇；发现关联0条。列表失败时不能据found=0推断没有更新。
- 待Dajiala余额恢复后走普通有界检查，核对返回biz/账号、列表、最多2篇正文、原日期及全局去重/入库；不清回执或绕过既有预算/门槛。

## 45个标签的差异/复用清单

| AIHot来源标签 | 窗口/新增条目 | CoreScope来源ID与入口 | 证据级别 | 处理 | 验收边界 |
| --- | ---: | --- | --- | --- | --- |
| Tripo（官方 X） | 1/0 | `corescope-x-tripoai`<br>https://x.com/tripoai | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：百度 Baidu (@Baidu_Inc) | 1/1 | `corescope-x-baidu-inc`<br>https://x.com/baidu_inc | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：卡兹克 (@Khazix0918) | 1/0 | `corescope-x-khazix0918`<br>https://x.com/khazix0918 | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：蚂蚁百灵 (@AntLingAGI) | 1/1 | `corescope-x-antlingagi`<br>https://x.com/antlingagi | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Addy Osmani (@addyosmani) | 1/1 | `corescope-x-addyosmani`<br>https://x.com/addyosmani | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Andrej Karpathy (@karpathy) | 1/1 | `v2-source-3725`<br>https://x.com/karpathy | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Aravind Srinivas（Perplexity CEO） (@AravSrinivas) | 3/2 | `corescope-x-aravsrinivas`<br>https://x.com/aravsrinivas | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Elon Musk (@elonmusk, xAI) | 1/1 | `corescope-x-elonmusk`<br>https://x.com/elonmusk | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Google DeepMind (@GoogleDeepMind) | 1/0 | `corescope-x-googledeepmind`<br>https://x.com/googledeepmind | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：indigo (@indigox) | 3/2 | `corescope-x-indigox`<br>https://x.com/indigox | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Lauren Tan（SpaceXSI，Grok Bot 工程负责人） (@poteto) | 3/1 | `corescope-x-poteto`<br>https://x.com/poteto | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Lingxi Li（SpaceXSI，Grok Bot 工程） (@lingxi) | 1/0 | `corescope-x-lingxi`<br>https://x.com/lingxi | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：MiniMax (@MiniMax_AI) | 1/1 | `corescope-x-minimax-ai`<br>https://x.com/minimax_ai | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：MiniMax Design (H3) (@Hailuo_AI) | 1/1 | `corescope-x-hailuo-ai`<br>https://x.com/hailuo_ai | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Mustafa Suleyman（Microsoft AI CEO） (@mustafasuleyman) | 1/1 | `corescope-x-mustafasuleyman`<br>https://x.com/mustafasuleyman | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：opencode (@opencode) | 1/0 | `corescope-x-opencode`<br>https://x.com/opencode | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：PixVerse (@PixVerse) | 5/0 | `corescope-x-pixverse`<br>https://x.com/pixverse | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Rohan Paul (@rohanpaul_ai) | 15/8 | `corescope-x-rohanpaul-ai`<br>https://x.com/rohanpaul_ai | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Saito 硬地骇客 (@SaitoWu) | 1/1 | `corescope-x-saitowu`<br>https://x.com/saitowu | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Sundar Pichai (@sundarpichai) | 1/1 | `corescope-x-sundarpichai`<br>https://x.com/sundarpichai | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：Tianyi Cui（@tianyi） | 3/1 | `corescope-x-tianyi`<br>https://x.com/tianyi | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| X：X.PIN (@thexpin) | 2/2 | `corescope-x-thexpin`<br>https://x.com/thexpin | exact_identity_config_join | 复用 | 未在本轮验收该账号本轮实际采集、游标覆盖或文章入库；身份去重不等于账号官方归属认证。 |
| 公众号：卡尔的AI沃茨 | 1/1 | `corescope-mp-aiwarts`<br>https://mp.weixin.qq.com/s?__biz=Mzg3MTk3NzYzNw%3D%3D&mid=2247512714&idx=1&sn=c2a781fbf4f976bd47b34caea1e2ffe9 | exact_identity_config_join | 复用 | 本轮没有对复用账号执行实际采集验收；复用不代表窗口内各篇已入库。 |
| 公众号：龙猫LongCat（美团） | 1/1 | `corescope-mp-longcat-meituan`<br>https://mp.weixin.qq.com/s?__biz=MzYyMTA0NTc5NQ%3D%3D&mid=2247486081&idx=1&sn=0609ae26ada1d4d96126b95044dd4519 | exact_biz_missing_supported_native_selector | 已新增，实采待余额恢复 | Dajiala余额不足20001；首次列表失败，尚无正文请求或入库；待充值后复验。未认证法人/官方账号归属。 |
| 公众号：数字生命卡兹克 | 2/1 | `v2-source-7176`<br>https://mp.weixin.qq.com/s?__biz=MzIyMzA5NjEyMA%3D%3D&mid=2647688060&idx=1&sn=e00d7e57b6f0e3670f0e267e677047df | exact_identity_config_join | 复用 | 本轮没有对复用账号执行实际采集验收；复用不代表窗口内各篇已入库。 |
| 公众号：腾讯混元 | 1/1 | `corescope-mp-tencent-hunyuan`<br>https://mp.weixin.qq.com/s?__biz=MzkwODU2OTQyNQ%3D%3D&mid=2247498763&idx=1&sn=279f8fb4e43a987fdc0aa2af0b0f7958 | exact_identity_config_join | 复用 | 本轮没有对复用账号执行实际采集验收；复用不代表窗口内各篇已入库。 |
| 公众号：月之暗面（Kimi） | 1/1 | `corescope-mp-kimi-moonshot`<br>https://mp.weixin.qq.com/s?__biz=MzkzMTY4NTIyNA%3D%3D&mid=2247484369&idx=1&sn=f54fea77e9f62b4c4a3e3fa54f6d5009 | exact_identity_config_join | 复用 | 本轮没有对复用账号执行实际采集验收；复用不代表窗口内各篇已入库。 |
| Browser Use | 2/0 | `corescope-rss-browser-use-com-b05a52d6`<br>https://browser-use.com/rss.xml | native_public_feed_preview_exact_original_member | 复用 | 本轮原生 RSS 公开 GET 与有限 feed 中原文成员关系成立；尚不等于 SQL 入库、48 小时门槛、正文或发布验收。 |
| ChinaTalk（RSS） | 1/1 | `corescope-rss-chinatalk-media-2a38e59e`<br>https://www.chinatalk.media/feed | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Databricks：Blog（RSS） | 1/0 | `corescope-rss-databricks-com-4b0d7518`<br>https://www.databricks.com/feed | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Gary Marcus：The Road to AI We Can Trust（RSS） | 1/0 | `corescope-rss-garymarcus-substack-com-94c28c84`<br>https://garymarcus.substack.com/feed | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Google DeepMind：Blog（RSS） | 1/1 | `v2-source-30`<br>https://deepmind.google/blog/rss.xml | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Hacker News：AI 热帖 | 5/1 | `v2-source-152077`<br>桥接入口；原公开查询见结构化清单<br>`v2-source-60`<br>https://news.ycombinator.com/rss | aggregate_query_equivalence_unconfirmed | 复用已有覆盖，查询等价待核验 | 本地 HN 首页 RSS 与 AI 关键词 newest 聚合入口已经存在，但 AIHot 的 AI 热帖筛选/排序/查询参数等价尚未确认。5 个文章目的站不是 5 个可直接新增的上游来源。 |
| IT之家·人工智能 | 30/17 | `corescope-rss-ithome-com-5479b994`<br>https://www.ithome.com/rss/ | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Latent Space（RSS） | 1/0 | `v2-source-8316`<br>https://www.latent.space/feed | native_public_feed_preview_exact_original_member | 复用 | 本轮原生 RSS 公开 GET 与有限 feed 中原文成员关系成立；尚不等于 SQL 入库、48 小时门槛、正文或发布验收。 |
| MarkTechPost（RSS） | 4/2 | `corescope-rss-marktechpost-com-7d33969b`<br>https://www.marktechpost.com/feed/ | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| O'Reilly Radar（热点 RSS） | 1/1 | `corescope-rss-oreilly-com-4d46873e`<br>https://www.oreilly.com/radar/feed/ | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| OpenRouter：Announcements（RSS） | 1/0 | `corescope-rss-openrouter-ai-0670d609`<br>https://openrouter.ai/blog/feed.xml | native_public_feed_preview_exact_original_member | 复用 | 本轮原生 RSS 公开 GET 与有限 feed 中原文成员关系成立；尚不等于 SQL 入库、48 小时门槛、正文或发布验收。 |
| Recode China AI（RSS） | 1/0 | `corescope-rss-recodechinaai-com-04fbdf26`<br>https://www.recodechinaai.com/feed | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Sakana AI：Blog（网页） | 1/1 | `corescope-rss-sakana-ai-08bc6298`<br>https://sakana.ai/feed.xml | native_public_feed_preview_exact_original_member | 复用 | 本轮原生 RSS 公开 GET 与有限 feed 中原文成员关系成立；尚不等于 SQL 入库、48 小时门槛、正文或发布验收。 |
| SemiAnalysis 长文 RSS（RSS） | 2/2 | `v2-source-76`<br>https://newsletter.semianalysis.com/feed | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| Simon Willison 博客 | 2/1 | `rss-simon-willison`<br>https://simonwillison.net/atom/everything/ | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| TechCrunch：AI（RSS） | 3/1 | `v2-source-610`<br>https://techcrunch.com/feed/<br>`v2-source-81`<br>https://techcrunch.com/category/artificial-intelligence/feed/ | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| The Decoder：AI News（RSS） | 11/4 | `rss-the-decoder`<br>https://the-decoder.com/feed/ | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |
| The Verge：AI（RSS） | 1/0 | `rss-the-verge-ai`<br>https://www.theverge.com/rss/ai-artificial-intelligence/index.xml<br>`v2-source-172`<br>https://www.theverge.com/rss/index.xml<br>`v2-source-618`<br>http://www.theverge.com/rss/full.xml | configured_channel_scope_only | 复用 | 仅有现有入口、频道范围及配置筛选条件证据；本轮未对该入口执行实际采集或预览，不声称各原文均已被覆盖采集。 |

## 运行、持久化和检查

- 后端官方隔离测试993/993、前端40/40、typecheck、生产构建及正式站点35项smoke通过。测试仅使用corescope_test，关闭真实采集并移除真实密钥；未重启CoreScope或V2服务。
- 本轮before-image保留原730项完整配置与3个tracked文件逐字节副本。追加事务原子提交，不改旧行、暂停项、队列或预算；正式库验收再次逐项比较14个来源字段一致。
- 持久配置：[全量来源](../industry/sources.json)、[公众号补充包](../industry/corescope-online-mp-supplement.json)、[V2映射摘要](corescope-v2-sources.json)。映射sources原行保持不变。
- V2以mode=ro/PRAGMA query_only再生成到忽略目录：731个现有来源均保留且配置无变化，但上游目录同期多出10条wx公众号配置，因此输出741项，不能宣称全量再生成完全一致。新上游552511已由成功回执游标的精确ghid+biz证实与corescope-mp-aiwarts同号；其余9项的身份、去重和接入仍待独立审查，本次没有自动合入。
- 既有V2只读桥接仍被Broadcom乱码/NUL旧记录阻塞；其最后成功时间为10月31日21:40:38。新增LongCat走独立原生公众号采集，不依赖该桥。桥进程存活不等于同步成功。

详细逐项证据、时间戳、回执安全投影和配置保持结果见[结构化验收](corescope-source-expansion-20261102.json)。密钥、供应商原文、完整before-image、私有响应和测试库数据均不提交Git。
