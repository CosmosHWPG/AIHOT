# 最近48小时公开网站正文补处理（2026-11-01）

本批有限验收已结束，失败来源如实保留；不能将已排队、HTTP200或有摘要页解释为全部正文恢复成功。固定清单、逐条和逐站结果保存在本机 `.data/qa/jina-backfill-20261101/`，不提交正文、原始服务回答、数据库或密钥。以文末最新验收记录为准，较早阶段保留作为操作历史。

最新用户授权（2026-11-01 01:29）：Jina次数预算已通过正式CLI审计关闭，`budgets.jina.enabled=false`，生效时间01:29:26.736。保留5/50/300数字和全部历史计数、live回执、用量、费用，不自动重新开启；不再用这些保留数字限制请求。其他服务预算开关和数字未改，认证、供应商限流、unknown防重发、来源/全文许可及内容/发布门槛保留。继续原184分母中剩余92条（子集元数据见budgetoff-remaining92.json），验收后提交CosmosHWPG/AIHOT；文中较早的Jina额度开启记录仅是历史阶段。

## 固定范围

用户授权：补处理最近48小时内其余正文抓取失败的公开网站材料；仅正文兜底、不启用列表采集、不降低发布门槛，V2与BirdClaw不变。

在2026-11-01 00:25:03.822（Asia/Shanghai）固定窗口：2026-10-30 00:25:03.822至2026-11-01 00:25:03.822，按材料真实 `published_at`。共184条、44个目标网站，均有既有正文提取任务证据、正文未确认、来源启用且为editorial；其中53条在固定时点已超出全局最新2000条位置。

原703条候选中，其余519条单列：318条已被领域规则过滤、22条非editorial、154条正文未确认但没有实际提取失败证据、25条处于pending且没有正文失败证据。这些不纳入补处理，也不解锁旧过滤项。

固定身份清单SHA256：`95f9d89e82910e12aa1e2784bafcf9dbc513c67b706d76e97f3f38cec149f4f9`。清单绑定文章身份、原来源、URL、修订、真实发布时间、来源配置和原状态。

## 正常队列与固定许可

首批12条在自然最新2000条范围内，通过正式 `rerun(...,'extract',...)` 入口入队。其余172条以两个固定 `web-body-recovery` 许可计划（118+54）补齐；仍仅由现有Windows托管worker执行正文提取、原有分析和发布流程。不会登记第二个worker或自动采集器。

许可只覆盖固定文章身份及修订演进，验证来源配置、URL、发布时间和初始状态；新计划30分钟内激活，窗口锚点最多早于计划30分钟。原全局48小时/最新2000条规则仍启用；许可优先级9000，正常近期队列保持优先。旧Bird和模型修复计划的摘要格式不变。

Jina沿用独立预算和回执机制：开始时为5次/分钟、50次/滚动小时、300次/滚动24小时；不因本批更改开关、提高限额或清计数。额度不足、执行中或unknown回执均单列等待。相同URL和UTC日的已收到回答复用，不增加轮次或attemptTag购买同一回答。

`JINA_BODY_FALLBACK=true`、`COLLECT_SKIP_JINA=true`，只在直接正文提取不足时使用Reader。本文所说的web_list/json_list是既有材料的原来源类型，并不表示启用Jina列表采集。正文200字符下限、模型及发布代码、来源全文许可均保持原规则。

## 实际发现的错误页问题

首批发现两类HTTP200不能当作文章正文的实际回答：

- Reddit材料 `rfgcqveh1hxdpn42cn9j9s2qs`：Reader元数据明确报告目标HTTP403，回执220979。
- Product Hunt材料 `bs3uk3h61hzi36ubifoga2euw`：Reader标题精确为“Just a moment...”，正文含强验证特征，回执221007；清洗后333字符与当前入库正文哈希相同。

正文提取增加明确拒绝：目标4xx/5xx只检查Reader元数据部分；验证页须精确验证标题和强验证正文特征组合，避免把正常讨论验证码/HTTP错误的文章误判。拒绝的回答仍正常结算回执。

纠正旧错误正文时，仅在当前待提取修订中正文与同一被拒回答完全相等才清除，产生新修订和 `content.body-rejected` 审计；保留历史版本、摘要和回执，不清除其他合法局部正文。随后沿用正常分析和发布投影，不直接改selected、eligible或visibility。

## 验收口径

逐条记录：真实正文任务、Jina回执或直接恢复证据、同一文章身份的入库修订、当前修订分析与发布投影、公开API和HTML的原文链接及公开版本。仅旧摘要页存在不能证明正文补齐。正文已恢复但被原规则过滤是处理结论，不能人为公开；短内容、验证页和目标错误要分别记录，不能推测为永久失效或付费墙。

逐站结果汇总保留全部184条的分母，不以每站一条成功掩盖同站其他失败。预算等待、unknown等待、待模型处理与真实抓取/处理失败分别统计。只有所有固定材料得到最终结论且无继续等待项，才结案并停止本批跟进；不会停止CoreScope服务。

截至00:40快照，首批12条：4条有效自然公开（3条Jina、1条直抓恢复），3条正文恢复后按原规则过滤，3条没有可用正文，2条错误页待精确纠正；其余172条尚未入队。没有宣称整批完成。

首批明确不可用回答：Forbes回执220976的Reader Markdown仅1字符；WSJ回执221008仅1字符；nullprogram回执220978仅56字符。均保持正文未确认，不能靠放宽长度下限通过。

## 验证与操作边界

首次隔离后端回归833项：832通过、1项 `selection-eval-runtime` 的Node子进程以Windows代码0xC0000409异常退出，无断言输出；同一Node v24.14隔离单文件复测3/3通过。保留原失败日志，不改称首次全量通过。验证页组合拒绝测试加入后，最终完整回归836/836通过（00:46，隔离测试库、仅本机桩服务，无真实付费调用）。

类型检查、网页构建、前端40项测试已通过；部署后仍需站点smoke、实际错误正文纠正、固定批次真实处理和逐站验收。当前应用修正尚未提交；通过相应验证后提交独立CoreScope分支，不合并PR。

本批只允许修改独立CoreScope目录。V2和BirdClaw仅只读核对原监听身份及BirdClaw代码/config/全局CLI哈希，不启停、不重新配置，也不恢复其他并行checkout文件。开始时V2/BirdClaw监听PID分别18480/25300。

## 部署后的阶段记录

00:46仅正常停止/启动CoreScope，00:46:54由Windows托管恢复；API34900、web43000、worker37576、bridge42824，重启次数均0。网页/API数据库健康正常，站点smoke全部通过。

00:47两个固定许可均激活，172条全部通过正式入口交接，没有新worker。Reddit与Product Hunt两条精确错误正文均由revision2升至3，正文清为0/unconfirmed，并完成当前revision正常分析与发布投影。回执仍分别为220979/221007、attempts均1，审计2524/2523记录了旧正文长度和新状态，没有重新购买回答。

00:49:36阶段快照：61条body=ok，16条完成当前自然公开API/HTML核验，4条新正文按原领域规则排除，7条正文未恢复，其他材料处于正常处理、额度或回执等待。这是进行中快照，不是终验；body=ok还需标题主题与错误/导航页质量核对。原53条范围外材料中已有26条正文入库，尚不能以此宣称53条均已展示。

逐条/逐站报告：`articles.csv`、`articles.md`、`sites.csv`、`sites.md`、`results.md`、`report.json`，均位于私有QA目录，44个站点实际对应30个配置来源ID。等待模型和原始正文失败分别记录，不以旧摘要页替代新修订通过。

四个发布/精选保护文件哈希相同，184条来源身份/配置/许可和attemptTag无漂移、无人工覆盖；本批开始后的Jina回执purpose均为body_fallback。V2与BirdClaw监听PID仍18480/25300；BirdClaw519个跟踪文件、配置与全局CLI哈希相同。

已建立当前聊天的有限验收跟进 `corescope-jina-184`，每30分钟只跟进本固定清单和现有worker；正常推进、已知失败和正常额度等待保持安静，新增明确故障/需要人工操作/完成才通知。完整交付且无继续等待项后删除此跟进，不停止CoreScope。

补充只读诊断：TDS材料 `bu1ef4qnbrnjb0q060yk8koks` 存在早于本批的embedding未知回执213145（2026-10-30 22:03创建、attempts2）及对应旧events.group失败（2026-10-30 23:26结束）。这不是本批Jina未知请求；不手工release/replay或用新attemptTag掩盖历史状态。须观察新正文/新输入正常流程是否受其影响，旧批次状态扫描产生的failed计数不得直接算成本次模型失败。

正文质量另由只读 `quality-audit.mjs` 定期检查新ok修订，保存 `bulk-body-quality-audit.json`：原URL、当前正文哈希对应回执、标题主题及验证/导航特征。缺少自动题词、短帖或导航线索只触发人工建议；有疑点的材料在报告保留质量复核pending，人工确认记录在 `manual-body-quality-review.json`。不因无错误关键词便宣布完整全文，不将合理的讨论帖/原联系方式页自动当抓取错误。

## 01:10 最新阶段结果与已部署修正

截至2026-11-01 01:14:06（Asia/Shanghai）：60条材料完成新修订分析、当前发布投影及公开API/HTML原文链接核验，其中22条当前正文精确对应Jina回执、38条由普通HTTP/来源路径恢复；2个原产品/介绍页按其真实页面类型完成；9条正文恢复后由原领域规则排除；19条正文未恢复；94条仍待处理（92额度等待、1未知Jina回执等待、1正常处理）。原53条范围外材料已有26条公开API/HTML通过，当前没有未决正文质量复核项。没有把184条全部交接说成全部通过。

| 当前未恢复样本的目标网站 | 条数 | 实际证据与原因 |
|---|---:|---|
| Forbes | 6 | Reader仅返回1字符Markdown，没有可用正文；部分已核实元数据含CAPTCHA，不推断付费墙或永久失效 |
| Reddit | 4 | 3条Reader报告目标HTTP403，1条明确“Prove your humanity”验证页 |
| Product Hunt | 4 | 3条明确验证页，1条目标HTTP403 |
| YouTube | 2 | Jina回答已正常结算，但Reader报告目标网站HTTP401；不是Jina Key认证失败 |
| WSJ | 1 | Reader无可用正文，元数据含CAPTCHA |
| nullprogram | 1 | 清洗后55字符，低于原200字符门槛，无证据认定登录/付费墙 |
| Cyberplace | 1 | 原status身份和主题已核实，Reader却返回747字符账号资料；未取得原帖正文 |

这些是当前样本的失败结论，不是永久停用来源。完整逐条证据及同站其他pending材料仍见私有CSV/Markdown。

新增两类最小修正已于01:09:31加载：

1. Reddit精确品牌验证标题与两个强验证指令组合才拒绝，正常文章讨论这些词仍可通过。新增材料 `zq5xpkalgor5jjsbdkgrahp7o` 复用221080，revision2→3，238字符错误正文清零，审计2827。
2. 已由原站证据核实的错正文，可先记录 `content.body-rejection-authorized` 审计，提取器仅按同文章、同URL和精确正文SHA256匹配拒绝；不把来源URL写死在代码，不用泛化关键词清除正文。Cyberplace `sxgi1rbcaz761klycnvawg4ef` 的747字符profile经授权审计2829后，复用221114、revision2→3、清为unconfirmed，拒绝审计2832；正常当前修订分析/发布投影已对齐。四条实际纠正均保持原receipt、attempts1、无新attemptTag和人工发布覆盖。

Cyberplace同一status公开HTML含SocialMediaPosting JSON-LD，文本186字符、OG描述187字符且主题正确，只能视作partial身份/内容证据，不降200字符门槛，不声称完整原帖。Sketch原URL就是互动游戏页；InfoQ原minibook URL就是介绍/目录/下载页（当前Readability1666字符与入库哈希一致），两者单列为原页面恢复，不声称文章全文或整本报告。

PDF `hflzryprh5q2hzp44gqdzcqmx` / Divergence Labs 的221254在收到回答后遇到PostgreSQL `unsupported_unicode_escape`，回答持久化失败，无法据安全现存证据确定具体字符。Jina存储现在保留原2M截断，只对NUL/孤立代理等JSONB不支持字符规范化；仅发生变化时额外以可逆UTF-16LE base64保存原截断文本，正常回答结构不变，使用量/费用和回执身份不变。原221254未手工释放或重放：已由原机制于01:05:46转unknown，仍须从该时点超过30分钟后才可能得到一次原自动恢复许可；许可、再次请求、正文入库和公开展示分别验收，不能提前称已恢复。

最终完整代码在本项目已有独立Node24.20中后端853/853通过；实际生产系统Node24.14的新增关键4文件43/43通过，类型检查、前端40/40及构建、最终站点smoke均通过。系统Node24.14的另一全量曾有一项0xC0000409原生子进程退出，以及receipts测试文件提前失败（该文件日志未给明确原因）；保留日志，不将其当作断言通过，也没有据此声称已查明系统根因；没有替换全局Node或其他系统运行时。最终源码与测试文件哈希记录在 `implementation-verification.json`，后续哈希不变无需重复整套回归。

01:10再次核对：Jina只产生body_fallback回执，全局48h/2000、发布/精选保护文件、来源配置/全文许可、attemptTag保持，无人工发布覆盖。V2/BirdClaw PID仍18480/25300；BirdClaw519个跟踪文件、配置及全局CLI无变化。仅正常重启CoreScope，网页/API与Windows托管worker健康。代码待整批验收和对应结果整理后提交，不提前将本次有限验收结案。

01:20静默核验：60条文章公开、2个原页面、10条领域过滤、20条正文未恢复、92条等待（90容量、1既有未知回执、1正常处理）。相比01:14仅两条正常推进：Reddit `cz1ovvs59d2uqh0cnz2c8lfwv` 恢复后按原领域过滤，`yc26s9dx6clxodl58fa6zyex2` 的221588报告目标403、正文未恢复；不把同类目标拒绝当新增系统故障。正文质量未见新明确错页，7个已测试文件哈希相同，853/43检查不重复；来源、许可、attemptTag和保护代码无漂移。PDF221254仍unknown/attempt1，旧embedding213145仍unknown/attempt2，未新增请求或手工释放。8780/8781和worker健康、restarts0；V2/BirdClaw监听仍18480/25300。逐站/逐篇报告已刷新，安全快照及 `heartbeat-20261101-0119-result.json` 保存本机；额度与既有回执等待无需人工动作，验收跟进保持ACTIVE。已通过工具刷新本心跳说明，采用当前853/43验证记录和四条已完成纠正事实，不保留旧836/两条纠正作为最终基线。

## 关闭Jina次数预算后的修复与验证（02:03）

Jina预算关闭后继续沿用唯一Windows托管worker。新增唤醒逻辑只在Jina预算为关闭时，将精确本地Jina次数额度错误的未来retry_at提前到当前时间；不清历史计数、请求次数、错误、attemptTag或queued_at，不绕过其他provider冷却、unknown、活跃任务或来源与范围校验。后台正式预算更新和原定时sweep共用该逻辑，不登记额外采集器。

质量核验另发现YouTube Cookie同意中间页和一条Reddit删除帖的导航/版规正文。YouTube须匹配目标主机、精确标题、cookies及Accept all/Reject all按钮组合才拒绝。删除帖经排除导航后仅161字符实质讨论，保留原200字符要求。两条分别复用221688/221802，attempts均1、正文revision2→3、精确错误正文清零，审计2968/2966，随后由原分析/发布流程结算。不能据此将同站正常文章或有足够实质讨论的删除帖一律拒绝。

最后两条发现的是交接故障而非额度仍生效：PDF221254于01:40:43自动放行，但旧实现只恢复failed文章，analyzed/unconfirmed未入队；Speechhome的正文因旧额度等待为pending，旧分析却已结束，普通new扫描遗漏。修复沿用原ops.recover及固定web许可sweep：同一releaseAuditId只消费一次，后续同URL/同文章真实请求、unknown、活跃任务、延期、来源/当前范围变化仍拦截；web-only analyzed/pending成员仅接回原extract队列。保持当前revision、评估身份和费用台账，不新增release/attemptTag/round。web批次的pending正文不再被误算已结算，旧Bird/模型计划的格式与结算行为保留。

最终后端全量883项：882通过，1项既有signals讨论匹配测试预期signal-unmatched却返回signal；完整日志保留，不能记作883全通过。实际生产Node24.14的全部本次关键修复、预算开关及该signals文件在独立空测试库91/91通过；类型检查、前端40/40与构建通过。未据隔离通过就宣称已查明全量单项不一致根因，也没有修改全局Node或V2/BirdClaw运行时。

02:02:28正常排空并仅停止CoreScope；02:03:12由原Windows托管恢复，站点smoke全部通过。02:03:18只调用原维护生产入口resumeReleasedBodyHandoffs和sweepRecoveryBatches一次，分别接回1条已放行PDF和1条pending网页，无新worker/采集器、直接provider请求或新增release。PDF同一221254的attempt2已completed，正文revision3/ok、107497字符；JSONB安全规范化后原截断UTF16LE可逆文本292208个base64字符另存，证明真实问题路径已成功持久化。当前修订分析/发布和正文主题质量仍分别核验，不以正文入库提前声明公开。

02:04补充测试诊断：只读corescope_test证实全量唯一失败的signals fixture与前序rematch fixture都投影到axis114，存储向量均为该轴1、模型同为text-embedding-v4，余弦1导致按正常阈值直接匹配。测试tag仅取模1000，并非唯一向量空间。安全证据full-test-signal-collision.json保留；本次未扩展修改无关测试或业务匹配阈值，仍报告全量882/883及空库隔离91/91。

## 最终逐站验收（2026-11-01 02:08，Asia/Shanghai）

本次固定184条/44个目标站点/30个配置来源均已有正文补处理结论；剩余92子集未扩展。原正常下游任务也已结束，无本批活跃任务、容量等待、质量复核或待模型样本。

| 范围 | 新正文、当前分析与API/HTML公开通过 | 原产品/介绍页读取通过 | 原领域规则过滤 | 正文未恢复 | 继续等待 |
|---|---:|---:|---:|---:|---:|
| 本次剩余92条 | 46 | 0 | 14 | 32 | 0 |
| 固定整批184条 | 106 | 2 | 24 | 52 | 0 |

整批132条恢复了原材料正文或页面文字；52条明确未恢复，不宣称所有网站都能突破上游限制。失败中26条正文过短、26条目标错误/验证/非原帖内容；当前批次没有新模型处理终止故障。44个站点中32个站点的固定样本均按原规则完成，12个站点含失败；不是把某站一条成功当作全站成功。

| 失败目标网站 | 剩余92中失败 | 整批184中失败 | 实际原因 |
|---|---:|---:|---|
| Forbes | 13 | 19 | Reader无可用正文，19条清洗为0字符；已核实元数据含CAPTCHA，不猜付费墙或永久失效 |
| Reddit | 6 | 11 | 目标403、明确人机验证、短回答；一条原作者帖已删除且有效讨论仅161字符 |
| Product Hunt | 3 | 7 | 明确验证页或目标403 |
| YouTube | 4 | 6 | 5条目标401，1条Cookie同意中间页；不是Jina Key认证失败 |
| MIT Technology Review China | 2 | 2 | Reader仅1字符Markdown，清洗0字符；原因无更多证据 |
| Bluesky | 1 | 1 | Reader仅1字符Markdown，清洗0字符 |
| DoublePulsar | 1 | 1 | Reader报告目标403 |
| UX Planet | 1 | 1 | Reader报告目标403 |
| Speechhome | 1 | 1 | 原URL同ID跳转后仅站点壳，导航/招聘/空列表，并非NVIDIA原帖 |
| Cyberplace | 0 | 1 | Reader取到账号profile，没有目标status正文；原站短文本仅partial |
| WSJ | 0 | 1 | Reader无可用正文，元数据含CAPTCHA |
| nullprogram | 0 | 1 | 清洗55字符，未达原200字符要求，不推断认证或付费墙 |

PDF已真实恢复：hflzryprh5q2hzp44gqdzcqmx，Jina221254同一回执attempt2完成，正文revision3/ok、107497字符；论文URL、标题主题和Methods/Results/References结构已核对，当前analysis39411/input_revision3与publication对齐、公开API和HTML原PDF链接均通过。仅确认取得论文材料，不保证PDF逐字无遗漏；未强制设为精选。

Speechhome最后质量复核确认错误页面：222156/attempt1的1111字符是站点壳；普通原URL GET也只取得相同站点壳，没有目标原帖正文。授权审计2974后走正常提取，复用同一已结算回执，将精确坏正文由revision3升至4并清为0/unconfirmed，正常当前修订分析/发布对齐。实际拒绝审计见verification-latest.json；不再次购买失败答案、不开新attemptTag、不泛化封禁整个站点。仅因HTTP200或有公开摘要不能计作正文恢复。

最后事件摘要已正常完成，当前story/digest版本一致，无活跃任务或未结算回执。本批两个固定许可收回：54条许可经原严格校验complete；118条许可严格complete仍被早于本批的embedding213145/attempts2未知账本挡住，仅该历史项未严格settled（其当前新正文、公开API/HTML、分组及事件摘要均已通过）。未伪造settled或重放旧未知请求，记录原因后通过原审计revoke收回该已无本次工作的有限正文许可。该历史未知账本原样保留，不能宣称它已恢复，也不将它误算成新增Jina失败或继续本批正文等待。

最终导出位于本机私有QA目录：articles.csv/md（184条）、sites.csv/md（44站）、remaining92.csv/md（本次92）、results.md、report.json、final-closeout.json、batch-close-result.json。正文、原始回复、数据库和密钥均未提交。Jina开关最终仍false，历史计数和费用保留；来源、全文许可、attemptTag无漂移，四个发布/精选保护文件哈希不变，全局48h/2000仍启用。仅Jina正文兜底，列表关闭。

02:08边界核对：V2/BirdClaw监听仍为原18480/25300；BirdClaw519个跟踪文件、配置及全局CLI哈希相同。CoreScope新API46220、web21408、worker20944、bridge42744均Windows托管、ready且restarts0，8780/8781数据库健康。只对CoreScope正常重启，未修改/启停/重配V2或BirdClaw。站点运行地址：http://127.0.0.1:8780/ 。本记录与本次源码/测试一并提交至CosmosHWPG/AIHOT的codex/corescope-system分支，不合并PR；无需继续有限正文补处理，交付后删除本批有限跟进，正常CoreScope服务持续运行。
