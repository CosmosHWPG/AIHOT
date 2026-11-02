# 2026-10-20 CoreScope：37项来源补齐与正式采集验收

固定的37项已进入持久配置包和独立 CoreScope 正式库。只读重复读快照为 **2026-10-20T11:32:45.075Z（北京时间19:32:45）**，最终完整恢复后11:47:55Z再次只读核对未变：**717个来源，701启用、16停用**。接入前680项的名称、类型、完整配置、角色、管理员启停、频率、发布权限等13个操作配置字段逐项保持；新增37项全部与草案一致，V2始终只读。

**35项首轮请求成功：28项有材料、7项首轮暂无可入库材料；其中初批10个X需分轮补采，正常到期续轮后仍有8个X的48小时窗口覆盖未完成。2个公众号因供应商余额不足20001，尚未采集成功，待余额恢复后复验。** 本轮新增来源产生49条发现记录，关联49个去重文章ID，其中46篇是本轮新建，另3篇复用原有文章。采集、分析、精选和发布是不同阶段，49条发现记录不代表49篇均已分析或发布。

| 来源类型 | 新增 | 采集检查成功 | 有材料来源 | 首轮返回0 | 失败待复验 | 发现记录 | 本轮新建文章 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RSS | 7 | 7 | 7 | 0 | 0 | 14 | 14 |
| 网页 | 14 | 14 | 14 | 0 | 0 | 28 | 25 |
| X | 14 | 14 | 7 | 7 | 0 | 7 | 7 |
| 公众号 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| 合计 | 37 | 35 | 28 | 7 | 2 | 49 | 46 |

全量分类为 RSS261、网页63、JSON20、X166、公众号71、外部桥接136（120启用、16停用）。本次37项为36个正常筛选、1个热度信号（Big Technology）；上游角色未公开的来源沿用CoreScope正常筛选策略，不将AIHOT显示标签视为私有角色或认证证明。

## 逐源验收

下表的状态、found/new和发现数固定为首批11:32:45Z快照；X覆盖列显示首轮到11:39:57Z到期续轮后的变化。频率单位为分钟；原日期为已关联文章的来源发布日期范围（UTC日），不是抓取时间。found是解析器返回候选数，new是本轮新建文章数，发现记录包含跨来源复用。公开来源首轮上限为2，因此完整列表返回数较大不会等于首批入库数。

| 来源及稳定ID | 类型 | 入口/精确身份 | 频率 | 首批状态 | found | new | 发现记录 | 原日期 | X覆盖（首→续） | 验收结论 |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |
| Browserbase / Stagehand 工程博客<br>`corescope-web-browserbase-blog` | web_list | [公开入口](https://www.browserbase.com/blog) | 240 | ok | 7 | 2 | 2 | 2026-10-14 | — | 采集成功，已入库/关联 |
| Cerebras：Blog（网页）<br>`corescope-web-cerebras-blog` | web_list | [公开入口](https://www.cerebras.ai/blog) | 240 | ok | 48 | 2 | 2 | 2026-10-06 ~ 2026-10-16 | — | 采集成功，已入库/关联 |
| Conductor 官方更新<br>`corescope-rss-conductor-changelog` | rss | [公开入口](https://www.conductor.build/changelog/rss.xml) | 240 | ok | 207 | 2 | 2 | 2026-10-02 ~ 2026-10-15 | — | 采集成功，已入库/关联 |
| Hamel Husain 长文（RSS）<br>`corescope-rss-hamel-blog` | rss | [公开入口](https://hamel.dev/index.xml) | 360 | ok | 20 | 2 | 2 | 2026-09-30 ~ 2026-10-20 | — | 采集成功，已入库/关联 |
| Qoder 产品与技术博客<br>`corescope-web-qoder-blog` | web_list | [公开入口](https://qoder.com/zh/blog) | 240 | ok | 67 | 2 | 2 | 2026-09-24 ~ 2026-10-14 | — | 采集成功，已入库/关联 |
| Anthropic：Alignment Science Blog（网页）<br>`corescope-web-anthropic-alignment-science` | web_list | [公开入口](https://alignment.anthropic.com/) | 360 | ok | 62 | 2 | 2 | 2026-10-15 ~ 2026-10-19 | — | 采集成功，已入库/关联 |
| Lovable Blog<br>`corescope-web-lovable-blog` | web_list | [公开入口](https://lovable.dev/blog) | 240 | ok | 169 | 2 | 2 | 2026-10-15 | — | 采集成功，已入库/关联 |
| Microsoft：Official Blog（RSS）<br>`corescope-rss-microsoft-official-blog` | rss | [公开入口](https://blogs.microsoft.com/feed/) | 240 | ok | 10 | 2 | 2 | 2026-10-19 ~ 2026-10-20 | — | 采集成功，已入库/关联 |
| Ollama：Blog（RSS）<br>`corescope-rss-ollama-blog` | rss | [公开入口](https://ollama.com/blog/rss.xml) | 240 | ok | 62 | 2 | 2 | 2026-10-16 ~ 2026-10-19 | — | 采集成功，已入库/关联 |
| AI as Normal Technology（RSS）<br>`corescope-rss-ai-as-normal-technology` | rss | [公开入口](https://www.normaltech.ai/feed) | 360 | ok | 20 | 2 | 2 | 2026-10-14 ~ 2026-10-19 | — | 采集成功，已入库/关联 |
| Big Technology（热点 RSS）<br>`corescope-rss-big-technology` | rss | [公开入口](https://www.bigtechnology.com/feed) | 360 | ok | 20 | 2 | 2 | 2026-10-12 ~ 2026-10-16 | — | 采集成功，已入库/关联 |
| Black Forest Labs：Blog（网页）<br>`corescope-web-black-forest-labs-blog` | web_list | [公开入口](https://bfl.ai/blog) | 240 | ok | 10 | 1 | 2 | 2026-09-23 ~ 2026-10-16 | — | 采集成功，已入库/关联 |
| Cognition 模型 / Devin 博客（网页）<br>`corescope-web-cognition-blog` | web_list | [公开入口](https://cognition.com/blog) | 240 | ok | 91 | 2 | 2 | 2026-09-25 ~ 2026-10-16 | — | 采集成功，已入库/关联 |
| Meta AI：Research Blog（网页）<br>`corescope-web-meta-research-blog` | web_list | [公开入口](https://research.meta.ai/) | 240 | ok | 14 | 1 | 2 | 2026-10-14 ~ 2026-10-15 | — | 采集成功，已入库/关联 |
| Microsoft AI：官方博客（网页）<br>`corescope-web-microsoft-ai-blog` | web_list | [公开入口](https://microsoft.ai/blog/) | 240 | ok | 33 | 2 | 2 | 2026-10-01 ~ 2026-10-15 | — | 采集成功，已入库/关联 |
| MiniMax：Blog（网页）<br>`corescope-web-minimax-blog` | web_list | [公开入口](https://www.minimax.io/blog) | 240 | ok | 13 | 1 | 2 | 2026-08-13 ~ 2026-10-19 | — | 采集成功，已入库/关联 |
| OpenHands 官方博客<br>`corescope-web-openhands-blog` | web_list | [公开入口](https://www.openhands.dev/blog) | 240 | ok | 81 | 2 | 2 | 2026-10-13 ~ 2026-10-15 | — | 采集成功，已入库/关联 |
| Replit：Blog（网页）<br>`corescope-web-replit-blog` | web_list | [公开入口](https://replit.com/blog) | 240 | ok | 15 | 2 | 2 | 2026-10-13 ~ 2026-10-16 | — | 采集成功，已入库/关联 |
| Thinking Machines Lab：News（网页）<br>`corescope-web-thinking-machines-news` | web_list | [公开入口](https://thinkingmachines.ai/news/) | 240 | ok | 13 | 2 | 2 | 2026-08-27 ~ 2026-10-15 | — | 采集成功，已入库/关联 |
| Modal Blog<br>`corescope-rss-modal-blog` | rss | [公开入口](https://modal.com/blog/atom.xml) | 120 | ok | 146 | 2 | 2 | 2026-10-16 ~ 2026-10-19 | — | 采集成功，已入库/关联 |
| 蚂蚁百灵 Developer Blog<br>`corescope-web-ant-ling-developer-blog` | web_list | [公开入口](https://developer.ant-ling.com/zh-CN/blogs) | 240 | ok | 23 | 2 | 2 | 2026-09-29 ~ 2026-10-14 | — | 采集成功，已入库/关联 |
| Peter McCrory · X<br>`corescope-x-petermccrory` | x_search | [精确账号](https://x.com/petermccrory) | 1440 | ok | 1 | 1 | 1 | 2026-10-18 | partial→partial | 已关联，48h窗口继续补采 |
| DeepSeek · X<br>`corescope-x-deepseek-ai` | x_search | [精确账号](https://x.com/deepseek_ai) | 1440 | ok | 1 | 1 | 1 | 2026-10-20 | partial→partial | 已关联，48h窗口继续补采 |
| World Labs · X<br>`corescope-x-theworldlabs` | x_search | [精确账号](https://x.com/theworldlabs) | 1440 | ok | 0 | 0 | 0 | — | partial→partial | 首轮请求成功，暂无可入库材料；覆盖继续推进 |
| Thinking Machines · X<br>`corescope-x-thinkymachines` | x_search | [精确账号](https://x.com/thinkymachines) | 1440 | ok | 0 | 0 | 0 | — | partial→partial | 首轮请求成功，暂无可入库材料；覆盖继续推进 |
| viggo · X<br>`corescope-x-decohack` | x_search | [精确账号](https://x.com/decohack) | 1440 | ok | 0 | 0 | 0 | — | partial→partial | 首轮请求成功，暂无可入库材料；覆盖继续推进 |
| Mark Zuckerberg · X<br>`corescope-x-finkd` | x_search | [精确账号](https://x.com/finkd) | 1440 | ok | 0 | 0 | 0 | — | partial→partial | 首轮请求成功，暂无可入库材料；覆盖继续推进 |
| Jakub Pachocki · X<br>`corescope-x-merettm` | x_search | [精确账号](https://x.com/merettm) | 1440 | ok | 1 | 1 | 1 | 2026-10-19 | partial→complete | 采集成功，已入库/关联 |
| Mira Murati · X<br>`corescope-x-miramurati` | x_search | [精确账号](https://x.com/miramurati) | 1440 | ok | 0 | 0 | 0 | — | complete→complete | 首轮暂无材料；已检查轮次的窗口闭合 |
| Michael Truell · X<br>`corescope-x-mntruell` | x_search | [精确账号](https://x.com/mntruell) | 1440 | ok | 0 | 0 | 0 | — | complete→complete | 首轮暂无材料；已检查轮次的窗口闭合 |
| 谢赛宁 · X<br>`corescope-x-sainingxie` | x_search | [精确账号](https://x.com/sainingxie) | 1440 | ok | 1 | 1 | 1 | 2026-10-19 | complete→complete | 采集成功，已入库/关联 |
| shaoruu · X<br>`corescope-x-shaoruu` | x_search | [精确账号](https://x.com/shaoruu) | 1440 | ok | 1 | 1 | 1 | 2026-10-19 | complete→complete | 采集成功，已入库/关联 |
| 硅基流动 SiliconFlow · X<br>`corescope-x-siliconflowai` | x_search | [精确账号](https://x.com/siliconflowai) | 1440 | ok | 1 | 1 | 1 | 2026-10-19 | partial→partial | 已关联，48h窗口继续补采 |
| 宇树 Unitree · X<br>`corescope-x-unitreerobotics` | x_search | [精确账号](https://x.com/unitreerobotics) | 1440 | ok | 0 | 0 | 0 | — | partial→complete | 首轮暂无材料；已检查轮次的窗口闭合 |
| 自变量 X Square · X<br>`corescope-x-xsquarerobot` | x_search | [精确账号](https://x.com/xsquarerobot) | 1440 | ok | 1 | 1 | 1 | 2026-10-19 | partial→partial | 已关联，48h窗口继续补采 |
| 公众号：月之暗面<br>`corescope-mp-kimi-moonshot` | mp_account | [身份原帖](https://mp.weixin.qq.com/s?__biz=MzkzMTY4NTIyNA%3D%3D&mid=2247484360&idx=1&sn=35df5c42fb318a8f93f32ca36e12ebe6) | 180 | failed | 0 | 0 | 0 | — | — | 余额不足20001，待充值复验 |
| 公众号：通义实验室<br>`corescope-mp-tongyi-lab` | mp_account | [身份原帖](https://mp.weixin.qq.com/s?__biz=MzkxMTYyMTAzNA%3D%3D&mid=2247501476&idx=1&sn=a9caef85456da041a0bfa3c0d40d0843) | 180 | failed | 0 | 0 | 0 | — | — | 余额不足20001，待充值复验 |

## 去重、日期与频道边界

37项与接入前680项、37项内部的采集身份冲突均为0。X按精确handle比较，公众号按biz及已有验证身份比较，公开频道按真实入口和文章范围比较；同发布者的X、公众号、News、Research和Blog频道不因品牌同名而删除。Microsoft Official、Microsoft AI、Microsoft Research，以及Meta Research、既有Meta AI Blog、MiniMax英文Blog和原News桥接分别保留其范围。

文章层通过既有原始URL/平台ID身份复用。BFL的flux-3-image-klein、Meta的muse-spark-open、MiniMax的minimax-m31f三篇已由`v2-source-60`发现，本轮新增发现关联且保留原文章归属，不重复新建。Hamel只用官方RSS目录地址，20项中8个首页占位在入口过滤中剔除，留下12个唯一文章候选；AIHOT的/index.html同页只用于证据比对。接入前两篇的目录与/index.html均不在运行库，本轮无需扩展全局URL标准化。

Microsoft AI、Qoder、Anthropic Alignment列表没有可用发布日期，使用每轮最多2次详情的显式`detail.requirePublishedAt`日期门；补齐后仍无有效来源日期的候选不入库，后续可重试。Microsoft只接受datePublished，Qoder只接受article:published_time，Alignment只接受正文精确日日期，不用modified或未知历史日期代替今天。实际入库6篇全部与已验证原日期精确匹配，全部backfill=true，timeline等于原日期。OpenHands使用纯标题字段，摘要分离，并在列表阶段拒绝2条无日期记录；有效候选81条。

## X与公众号实际回执

14个X全部使用现有Bird user_tweets，初始48小时、每轮1页、首轮上限20、配置间隔1440分钟。按首批source subject、fetch时间区间及receipt_attempts核对，**每源各有1次live attempt，共14次，对应14个completed回执，未观察到回执复用**；7源非空、7源首轮暂无可入库材料。首批14个均只请求1页，其中10个coverage=partial、truncated=true、backlog=1；4个coverage=complete、truncated=false、backlog=0，全部dropped=0。7个返回0中5个仍为partial，仅2个为complete。partial来源的next_fetch_at由覆盖调度安排在约5分钟后，配置频率仍为1440分钟；这不等于已完成48小时覆盖。11:36:01Z只读补查尚无后续轮次，所有游标均无gap，原始14次回执与49/46首批计数分别保留。成功返回0只描述本页，不能据此推断整个48小时无帖。CLI返回或原有回执身份本身不足以证明新请求，本结论来自实际回执与attempt。

首轮标记partial的10源：Peter McCrory、DeepSeek、World Labs、Thinking Machines、viggo/decohack、Mark Zuckerberg/finkd、Jakub Pachocki/merettm、SiliconFlow、Unitree、X Square。complete的4源：Mira Murati、Michael Truell、谢赛宁、shaoruu。完整的source ID列表、每源pages/backlog/truncated/dropped和安全游标投影均在结构化记录中；complete只证明该次原生提供商窗口已闭合，不表示已经穷尽账号全部历史。

**到期补采结果。** 2026-10-20T11:37:48Z至11:38:08Z，根会话仅对已到next_fetch_at的10个partial来源各执行1个普通续轮，没有force，也没有提高每轮1页上限。11:39:57Z只读快照证实累计24个X fetch_run、24次live received attempt、24个completed回执，0复用；本次10轮全部0新材料。merettm与Unitree由partial转complete，当前**6 complete、8 partial、0 gap**。10个续轮返回游标的服务器端摘要均不同于初轮，表明页游标有推进；摘要变化不等同于窗口完整。首批49发现/46新建保持不变，未观察到第三轮；后续由原生常规调度承接，不进行无边界人工强刷。表内found/new/发现计数仍采用首批快照，覆盖列额外展示首轮→本次续轮后的值。

月之暗面和通义实验室均已走正式Dajiala mp_history路径，各有1次live失败请求，回执分别为**93207、93209**，错误码均为**20001（insufficient balance）**。两源的文章列表、正文和入库未验收通过，不能表述为无近期更新。通义的历史AIHOT原帖仅证明独立账号身份，本次观察窗口没有该标签新材料，也不能替代本轮成功采集证据。现有首轮公众号策略为7天新闻窗口、最多2条；这不是持续采集的固定7天保证。本轮失败后未重复购买请求或放宽策略。

## 运行恢复、持久化与隔离

本机后台已沿用现有owned任务完成完整停止/启动，**2026-10-20T11:46:18Z最终就绪**，载入新后端。API、网页、worker、只读桥均就绪且无子进程重启；`http://127.0.0.1:8780/`、`8781`数据库健康检查通过。此为追加日期轮转修复后的最终恢复证据。此次未修改启动脚本，未对V2/V1做服务或配置操作。11:47:27Z的只读活动快照确认恢复后sources.schedule仍在执行（最新轮11:47:24Z运行中，前一轮有完成记录），而非仅进程ready；bridge在11:46:16Z成功轮询且无last_error。pgboss未完成队列只做安全名称/状态/数量投影，不导出任务payload或私有输出。

持久化来源目录/部署配置包在[来源配置包](../industry/sources.json)，新增项进入[公开频道补充包](../industry/corescope-online-supplement.json)、[X补充包](../industry/corescope-online-x-supplement.json)、[公众号补充包](../industry/corescope-online-mp-supplement.json)。运行时管理员调整和既有Bird路由升级保存在正式库，应以后台信源页核对当前实际配置；本次新增37项与正式库完全一致，旧680项只与接入前正式库快照比对保持，不宣称旧条目等同静态seed。通过V2 SQLite mode=ro、query_only重新生成后，与持久化目录的717项来源配置按稳定ID和字段全部一致；来源数组顺序、补充ID元数据及V2实时抓取/更新时间不要求字节一致，不把它们误报为采集配置改动。

预算开关和数值均与接入前快照一致，本轮budget.update审计为0：Bird和LLM的数量预算enabled=false、Dajiala=true。此处报告的是现状保持，不将disabled解释为正在执行数量熔断；真实请求继续记录回执。原680来源的管理员暂停、频率及配置均未覆盖。

既有METR评测资料仍保持isolated：9篇全部历史backfill、timeline保留原日期、processing_state=skipped；公共新闻/精选0、热点signal0、事实归组0、分析0、文章级LLM回执0。本轮仅作SQL计数复核，未重新访问或采集METR网页。

## 验证与待办

最终类型检查、前端构建exit0，前端测试40/40；追加日期详情轮转游标修复后，项目Node24.20 arm64的隔离后端全套**793/793**通过（exit0，251161ms），日期定向**9/9**通过，freshDB日期9项与selection-eval-runtime3项另计**12/12**通过。轮转修复避免前部永久无日期条目反复占用详情额度，后续候选可在正常轮次继续处理。追加修复后最终完整重启就绪，站点smoke **35/35**通过（含feeds、leaderboard和MCP），证据为site-smoke-final.log。

保留一次较早全套执行的原生异常事实：793项中792通过，另一个Node子进程退出0xC0000409且没有stdout/stderr，未观测到断言错误，根因未确认。最后完整793/793通过与该次历史异常分别记录，不用诊断成功抹去历史失败。35源首批真实采集及6篇日期保留验收不因此撤销；2个公众号仍待余额恢复后的原生复验。

接入前备份`.data/qa/source-refresh-implementation-20261020/corescope-before-refresh.dump`为**801,564,282字节**，pg_restore --list已验证。私有680配置快照、只读重复读验收、逐轮采集、回执和测试日志留在忽略目录；.env、凭据、数据库、供应商原文和.data不提交。完整37项配置、公开身份证据及逐源安全验收见[结构化记录](corescope-source-expansion-20261020.json)。本次分支为`codex/corescope-system`，提交内容对应此验收，commit以git history为准；根会话完成push另提供commit链接。
