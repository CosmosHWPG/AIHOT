# 单篇RSS正文恢复与跨日付费保护

本次授权只恢复两篇既有文章：DoublePulsar `h1m1v4f1q656w35cmwo2mdhrv` 和 MIT科技评论中国17168 `qliobaudgka8ogdssg9tz3g80`。不改V2/BirdClaw，不增加列表采集器或新依赖，不修改来源、全文许可、评分或发布门槛。实际验收结果以文末记录为准。

## 单篇正文路径

固定 `web-body-recovery` 计划的成员可带 `rssBody`：批准的feed地址、`allowJina:false`、正文SHA256、清洗正文末200字符SHA256及核验主题词。仅正常启用的editorial公开网页、当前来源/URL/配置/发布时间/修订匹配时才取得RSS策略；现有48小时/最新2000规则保留，原固定许可可在等待老化后继续处理。旧184条计划保持关闭。

适配器只从该feed中查找精确原文permalink，不导入其他条目。保留正文选择参数和fragment，仅忽略已知跟踪参数；相同canonical重复条目视为歧义，不取第一个凑数。标题必须相同或仅少量尾词差异，仍受精确正文证明约束。`content:encoded` 优先；`description` 只有该文章经核验的精确证明才允许读取，不全局打开 `summaryIsBody`。清洗正文须超过原RSS的280字符且非预告，不能用长度、HTTP200或摘要代替正文范围核验。

网络沿用 `guardedFetch` 的连接/大小/重定向保护。feed正文在进程内最多缓存4个feed、60秒，合并同时读取，不保留跨站通用浏览器缓存。不调用Jina或模型来解析feed。

结果交给正式 `extractArticleBody` 事务：先核对来源、文章URL/修订和仍有效的固定许可，再新建正文修订、记录安全取得证据，并由唯一既有worker进入原分析/发布/事件队列。原title/author/published_at/source/attemptTag均保留；公开全文仍服从来源许可。不得直接设置selected/eligible/visibility。

同文章ID和原URL的禁止Jina指令保留在审计后的计划中；计划complete或revoked只结束范围许可，不自动解除该指令，也不重新授权旧计划。RSS内容不再匹配时不购买另一份Reader回答。

## 文章级失败缓存

`0048_article_body_failure_cache.sql` 只新增安全元数据表，不改付费账本。失败绑定article ID、原URL、Jina正文用途、原因、原receipt ID和精确正文哈希；不依赖UTC日期或输出格式，回执常规保留期到期也不使失败自动解除。

直抓仍可取得真实新正文；直抓不足且准备调用Jina时，先检查此缓存。缓存可从同一文章/URL已有completed回执补证短正文、明确目标HTTP错误、验证页及已审计的精确错正文。pending/unknown继续抛原有等待异常，不能当空正文、普通失败或重购许可。最新有效回答不得由更早失败替代。

失败决定和正常正文结算使用文章行锁；得到新正常正文后，仅当前URL/修订/body=ok/正文SHA一致才记录resolution并保留历史。resolution时点使旧的或晚归的旧请求不能重建过期失败。原始回答、Cookie、Key及正文不复制到缓存表或提交仓库。

同一旧错正文仍可按精确哈希在正式提取流程中清零并产生新修订；其他合法partial不清除。无内容变化证据不因跨UTC日、预算关闭或手工重排自动重买。此修改不增加unknown放行次数。

## 本机操作入口

先准备一个只含固定article IDs、feed策略和已核验正文证明的私有request JSON，再依次运行：

```powershell
node --env-file=.env scripts/corescope-rss-body.ts plan --request=<request.json> --out=<plan.json>
node --env-file=.env scripts/corescope-rss-body.ts apply --plan=<plan.json>
node --env-file=.env scripts/corescope-rss-body.ts enqueue --plan=<plan.json>
node --env-file=.env scripts/corescope-rss-body.ts status --id=<plan-id>
node --env-file=.env scripts/corescope-rss-body.ts complete --id=<plan-id>
```

CLI仅操作本机独立CoreScope数据库，固定计划30分钟内激活，不改来源配置；入队为稳定审计身份、正常extract队列，不注册第二个worker。再次enqueue只返回已有交接。complete要求所有正文真实ok且下游任务严格结算；不能把已排队或旧摘要页当通过。

## 验收记录

执行前安全基线、正文主题/尾部核验、回执及边界证据位于本机 `.data/qa/rss-body-recovery-20261101/`，不提交该目录。初始DoublePulsar正文revision2/unconfirmed、MITTR revision1/unconfirmed；Jina221742/221703均completed且attempts1。两个feed分别找到4176和3810字符，原文主题与身份一致；这只是执行前正文可得性证据，尚不等于入库或发布验收。

最终于2026-11-01 12:28（Asia/Shanghai）完成两条真实正文及下游验收：

| 材料 | 正文修订 | 正文字符 | 当前发布版本 | 结果 |
|---|---|---:|---:|---|
| DoublePulsar | 2→3 | 4176 | 4 | 当前修订分析/发布投影、自然公开API/HTML原文链接通过 |
| MIT科技评论17168 | 1→2 | 3810 | 3 | 当前修订分析/发布投影、自然公开API/HTML原文链接通过 |

两条正文SHA与执行前经主题/尾部核验的feed证明完全相同；正式取得审计、缓存failure历史及新revision resolution标记齐全。原来源/配置、标题、作者、发布时间、摘要许可、attemptTag均相同，无人工发布覆盖。两条Jina原回执221742/221703及全部attempt相对基线完全未变，各仍attempts1，本次新增Jina请求为0。两篇均按原模型规则自然公开、selected=false；没有为了验收强制精选或放开全文。

独立固定许可rss-body-two-20261101（digest fa99a0ddf870998d48615864cbed87067e0774d3168e6d8132e0e3e4b60dd0dc）12:26激活，仅正式入队两条。12:28原严格结算complete，2/2 settled、无活跃任务/deferral/未结算回执；完成后再读验证，两条denyJina仍true、策略不再授予RSS范围许可。旧184条许可未重新激活。

最终类型检查、前端40/40及构建、站点smoke通过。生产Node24.14关键103/103、缓存与Windows运行时隔离20/20、事件隔离10/10通过。稳定源码全量921项中920通过，唯一旧events.test.ts断言失败已通过只读测试库定位：同文件前序遗留fact127/story82的随机文本词法bigram相似度恰好0.25，stub的answerAll把它也判为SAME_STORY，从而以更早story82为归并锚点；不是本次正文逻辑或已证实的向量问题。未改业务阈值或相关事件代码，完整日志和full-events-test-review.json保留，不能记作全量921通过。较早过渡版本的919项有一项Windows测试清理临时目录EBUSY，随后隔离20/20及最终该测试均通过；不掩盖原失败日志。

仅正常重启CoreScope加载代码和0048迁移。第一次启动的Node24.14迁移子进程以-1073740791（0xC0000409）退出，未据此判定SQL错误或进程泄漏；原托管入口幂等重试后迁移成功，12:26:27恢复ready。没有替换全局Node或其他系统运行时。最终网页/API/worker/bridge均Windows托管ready、restarts0，8780/8781数据库健康；全局48h/2000、原预算开关和24个发布/精选保护文件哈希保持。

操作边界：本任务未修改、启停或重配V2/BirdClaw。BirdClaw519个跟踪文件、配置及全局CLI指纹相同，PID25300及创建时间一致。另只读观察到V2监听从基线PID18480变为21268，新进程创建于12:10:39，早于本任务12:24的CoreScope正常停止；原因/操作者未核实，本任务未对V2执行启停，保留差异证据且未恢复或干预该进程，不能把整体PID基线写成全部相同。

本机明细articles.csv/md、verification.json、implementation-verification.json及边界/日志保存在私有QA目录；不提交正文、原始回复、.env、数据库或密钥。代码与本文一并提交CosmosHWPG/AIHOT的codex/corescope-system分支，不合并PR。运行地址http://127.0.0.1:8780/；原文章详情路径为/items/<articleId>，没有新增重复文章。
