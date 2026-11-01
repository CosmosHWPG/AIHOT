# 2026-11-01 CoreScope：13项来源接入与实际采集验收

本轮13项已进入独立 CoreScope 正式库和持久化配置包。核对时间为 **2026-11-01T15:25:10.770Z**，全量 **730个来源：714启用、16停用**。接入前717项的14个来源字段（含稳定ID、名称、类型、完整config、角色、频率、管理员启停和发布权限）逐项保持不变；新增13项与最终配置完全一致，Bird/LLM/Dajiala预算开关和数值保持不变。V2仅以只读方式访问，未改其代码、数据库、配置或服务。

**13项最新采集请求均成功；10项已有材料，3项未返回可入库材料。** 累计19条发现记录关联19个去重文章ID，其中18篇本轮新建、1篇复用原有文章。发现、分析、精选、发布分别计数，19条发现不表示19篇新闻已发布。X首轮后仅对3个已到期partial来源各执行1次普通续轮，没有force或提高页数；当前尚有3个X窗口未闭合。

| 来源类型 | 新增 | 最新请求成功 | 有材料来源 | 发现关联 | 本轮新建 |
| --- | ---: | ---: | ---: | ---: | ---: |
| RSS | 6 | 6 | 6 | 12 | 11 |
| 网页 | 2 | 2 | 2 | 4 | 4 |
| JSON | 1 | 1 | 1 | 2 | 2 |
| X | 4 | 4 | 1 | 1 | 1 |
| 合计 | 13 | 13 | 10 | 19 | 18 |

全量类型：RSS267、网页65、JSON21、X170、公众号71、外部桥接136。此轮没有新增公众号。

## 逐源结果

found是原生解析器返回候选数，首轮backfill上限再限制实际入库；公开源展示首次成功请求的found/new，X展示首轮，覆盖状态采用最新快照，续轮没有新增材料。正式请求、fetch_run及日期范围见同名JSON。

| 来源 | 类型 | 采集入口 | 常规间隔/分钟 | 成功轮found | 成功轮新建 | 累计发现 | 最新X覆盖 | 验收状态 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| The Pragmatic Engineer：Newsletter<br>`corescope-rss-pragmatic-newsletter` | rss | [入口](https://newsletter.pragmaticengineer.com/feed) | 360 | 20 | 2 | 2 | — | 已采集并关联入库 |
| Pydantic AI：官方文章<br>`corescope-rss-pydantic-articles` | rss | [入口](https://pydantic.dev/feed.xml) | 240 | 20 | 2 | 2 | — | 已采集并关联入库 |
| Sarvam AI：Blog<br>`corescope-rss-sarvam-ai` | rss | [入口](https://www.sarvam.ai/rss.xml) | 240 | 30 | 2 | 2 | — | 已采集并关联入库 |
| Steve Yegge：Medium<br>`corescope-rss-steve-yegge-medium` | rss | [入口](https://medium.com/feed/@steve-yegge) | 360 | 10 | 2 | 2 | — | 已采集并关联入库 |
| Gamma：Changelog<br>`corescope-rss-gamma-changelog` | rss | [入口](https://meetgamma.canny.io/api/changelog/feed.rss) | 360 | 10 | 2 | 2 | — | 已采集并关联入库 |
| EleutherAI：Blog<br>`corescope-web-eleutherai-blog` | web_list | [入口](https://blog.eleuther.ai/) | 360 | 3 | 2 | 2 | — | 已采集，2篇旧文归档资料 |
| Addy Osmani · X<br>`corescope-x-addyosmani` | x_search | [入口](https://x.com/addyosmani) | 1440 | 1 | 1 | 1 | partial | 已采集并关联入库 |
| Adam Wolff · X<br>`corescope-x-dmwlff` | x_search | [入口](https://x.com/dmwlff) | 1440 | 0 | 0 | 0 | complete | 窗口检查完成，本轮无材料 |
| PromptArmor · X<br>`corescope-x-promptarmor` | x_search | [入口](https://x.com/promptarmor) | 1440 | 0 | 0 | 0 | partial | 请求成功，窗口覆盖待完成 |
| Jensen Huang 同名账号 · X<br>`corescope-x-jensenhuang` | x_search | [入口](https://x.com/jensenhuang) | 1440 | 0 | 0 | 0 | unknown | 请求成功，覆盖缺口待核验 |
| OpenMOSS：研究博客<br>`corescope-web-openmoss-blog` | web_list | [入口](https://openmoss.ai/blog/cn/) | 240 | 13 | 2 | 2 | — | 已采集并关联入库 |
| LG AI Research：官方研究博客<br>`corescope-web-lg-ai-research-blog` | json_list | [入口](https://www.lgresearch.ai/api/board/blog/list?pg=1&pgSz=12&schExpsYn=Y&schLangTp=en&schCatgCd=BAAACC&sordFld=sort&sordMetd=ASC) | 240 | 12 | 2 | 2 | — | 已采集并关联入库 |
| Trail of Bits：AI安全研究<br>`corescope-rss-trailofbits-blog` | rss | [入口](https://blog.trailofbits.com/index.xml) | 240 | 20 | 1 | 2 | — | 已采集并关联入库 |

## 三项待核验来源

- **OpenMOSS**：使用官网真实的 https://openmoss.ai/blog/cn/，不再把锚点 /#blog 当作列表入口。原生网页解析到13个带日期条目，正式采集新建2篇，包含本次目标MOSSImage文章；保留官网原始日期。
- **LG AI Research**：接通官网公开JSON列表，使用expsYmd的原生yyyymmdd日期解析。pgSz=30的两次正式请求超时；仅把分页大小改为官网默认12后，正式请求成功返回12条并新建2篇。未放宽TLS、超时、代理、预算或日期门；不能仅据此断言此前超时的上游根因。稳定ID虽含web，实际kind为json_list。
- **Trail of Bits**：官网 /index.xml RSS正式请求成功，20个候选产生2条发现、1篇新建、1篇复用。**10月27日指定原文仍404**，当前feed最新文章为10月21日；频道已可采集，指定原文及其本周证据仍待复验。不得用两篇较旧文章替代该原文验收。

## 去重与持续调度

13项与接入前717项、暂停来源及13项内部的精确采集身份冲突均为0。按真实RSS路径、网页/JSON范围和精确X handle去重，同名品牌不同频道不直接合并。Pragmatic新Newsletter与既有v2-source-628 Blog分开采集，但共用feed:0ed1fdcf7cff510b99c8信号组以免重复增加发布者热度。V2中5个AIHOT反馈网页（9285、9614–9617）继续排除。文章沿用已有URL/平台身份复用，Trail of Bits的既有文章没有再建一篇。

公开源按240/360分钟的现有调度自动抓取，初次最多2篇并按原日期回填；浏览页面不触发全源抓取。X使用现有Bird user_tweets，48小时初始窗口、每轮1页、常规1440分钟；有backlog时原生调度约5分钟后续页。JensenHuang仅按同名账号接入，不声明为NVIDIA官方身份。Adam Wolff本轮complete且0材料；partial返回0只代表当前页，不能推断整窗无更新。

X当前待窗口验收：`corescope-x-addyosmani`、`corescope-x-promptarmor`、`corescope-x-jensenhuang`。4源累计7个fetch_run、7个completed回执、7次live请求；3次续轮均为新请求，无复用或pending/unknown请求。窗口unknown与供应商请求unknown分开计数。没有手工清游标、租约、任务或改变预算；后续由原生调度承接。公开feed/列表及初始导入均有边界，不宣称已补齐全部历史。

## EleutherAI旧文作为资料

两篇本轮新建旧文均保留原发布日期：

- [Subliminal Learning / Pretraining](https://blog.eleuther.ai/subliminal-learning-pretraining/)：2026-10-25。
- [Aletheia Retrospective](https://blog.eleuther.ai/aletheia-retrospective/)：2026-08-25。

独立正式库按逐行版本、内容哈希、日期和状态CAS归档，保留before-image和审计：backfill=true、timeline等于原日期、processing_state=skipped、文章级visibility=withdrawn、eligible=false、selected=false，分析与事实归组均0。本次归档本身未请求模型。正常发布函数同步公共投影；不通过删除任务或改日期隐藏旧文。

/resources增加独立参考文章卡片，10月25日研究资料链接恰好1个、状态reference；页面与API均200，两篇旧文的公共新闻详情均404。仅资料元数据公开，原始材料和分析不投影。**EleutherAI来源本身仍为enabled/editorial**，同源未来新文继续现有新闻筛选；没有把整个来源隔离为资料。

## 运行与验证

应用代码已通过现有后台主机的recovery流程重载，2026-11-01T15:14:11Z恢复并通过数据库就绪检查，数据库未重启。网页8780、API8781、worker和周期调度已运行，后续sources.schedule有完成记录。V2的8775监听PID21268、CoreScope数据库5448的PID65664均与接入前一致。

- 接入前独立数据库备份约1.84GB，备份目录可列举校验通过；配置只追加13项。
- 13项先以独立库CAS插入，再经source-upgrade dry-run/apply复核：13 unchanged、0 update、0 skipped；unchanged指升级器无需再次改路由，不是没有插入新来源。旧717项没有被批量覆盖。
- 官方隔离数据库后端测试 **993/993**、前端测试 **40/40**、生产构建和全项目typecheck通过；正式站点 **35项smoke检查通过**。
- V2 SQLite以mode=ro和PRAGMA query_only重生成来源，730项按稳定ID的采集配置完全一致；来源数组顺序、补充ID排序和V2实时映射元数据不要求字节一致，未写V2或覆盖持久化映射。
- 持久配置：[全量来源](../industry/sources.json)、[公开源补充包](../industry/corescope-online-supplement.json)、[X补充包](../industry/corescope-online-x-supplement.json)、[资料策略](../industry/corescope-source-profiles.json)。密钥、私有回执、完整备份和原始材料均在忽略目录，不提交Git。

## 待验收边界

1. Addy Osmani与PromptArmor仍partial，有分页待补；Jensen Huang同名账号为unknown，续页出现empty_page_without_cursor缺口。本轮3个账号的48小时窗口均未验收，请求成功不等于窗口闭合；未清空gap或把空页标作complete。
2. Trail of Bits指定10月27日原文404，待发布者恢复或提供可证实替代原始链接；现有RSS工作正常。
3. RSS/网页首轮有界回填、feed近期范围及同源未来文章持续采集仍由常规运行验证，不把首轮结果写成全历史验收。

4. V2只读桥接存在接入前的独立故障：10月31日21:42:43 CST起，一条上游Broadcom记录的正文及元数据含NUL和大量乱码，PostgreSQL拒绝整批导入，最后成功时间21:40:38、游标停在上游ID253449。13个新增原生来源不依赖此桥；该故障未在本轮修改，未跳过坏记录或推进游标，V2仍只读。桥进程存活不代表桥同步成功。

V2只读桥接运行状态在同名JSON的runtime.bridge单列，不混入新增13项native采集验收。完整安全结果见 [结构化验收](CORESCOPE_SOURCE_EXPANSION_20261101.json)。
