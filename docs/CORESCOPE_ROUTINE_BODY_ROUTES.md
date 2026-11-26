# 三站日常自动正文路径

DoublePulsar、MIT科技评论中国与Speechhome不再依赖逐篇恢复计划。已有采集器或外部信息流发现新文章后，正常worker在需要正文时自动使用下表路径，无须人工冻结正文hash或新建batch。

| 文章站点 | 日常正文字段 | 新链接发现方式保持 |
|---|---|---|
| DoublePulsar | 固定 `https://doublepulsar.com/feed` 中精确原文对应的 `content:encoded` | HN等原有来源；不把整个HN来源的Jina关掉 |
| MIT科技评论中国 | `https://apii.web.mittrchina.com/information/details?id=<原ID>` 的公开 `data.content` | 既有MIT RSS来源 |
| Speechhome | `https://speechhome.com/api/api/post/detail/<原ID>` 的公开 `data.result.content` | 既有external输入；仍依赖上游正常送入新链接 |

本次是正文提取能力，不新增列表采集器或worker，不修改V2/BirdClaw。Speechhome没有因此变成独立列表发现源；若上游没有送入新文章，就没有新正文任务。来源ID、参与方式、暂停、发表日期、48小时/最新2000、模型与发布门槛、全文许可保持。

## 自动处理和质量边界

配置位于 `industry/body-routes.ts`。域名路由覆盖从聚合源进入的同站文章；已确认的常见www别名纳入原站规则。原站标题/URL/文章ID不匹配、未知结构、会员状态或正文不完整时保留unconfirmed，不切换成通用Readability站点壳或Jina。

DoublePulsar仍严格匹配feed permalink与标题，忽略已知RSS/统计跟踪参数；只接受完整字段 `content:encoded`，超过原RSS 280字符且非预告。`description` 逐篇证明例外不扩展到日常抓取。Feed最多4项缓存、60秒，合并同时读取；日常与固定恢复缓存分别保存，临时失败不会污染另一种模式。

MIT及Speechhome保持精确同ID、标题、已知成功/免费状态与 `content` 字段校验。MIT只接受 `code=10000/status=1/is_vip=2`；Speechhome只接受 `status=200/isSucceed=true/statusCode=0`，19位ID按字符串比较。Speechhome支持原 `/post/<id>` 和已验证 `/blogs/all/<id>`；误落列表的 `/blogs/<id>` 不作为正文详情。清洗后仍须满足原200字符、非预告/登录/验证页规则。接口日期占位值不覆盖既有时间。

日常路径与固定恢复函数分开：日常新文章按已核验的公开完整字段提取；原固定计划的正文/尾部/主题证明依然必需，证明失败不落日常路径绕过。关闭旧计划不复活旧范围；后续正常日常路径来自本次独立授权。

新pending文章即使带partial文字，也先进入原正文队列。已body=ok的内容直接复用，不重复抓取/加版本/评分；历史已分析或领域排除的unconfirmed材料不会因本次上线重新打开。失败不是发布资格：仍由原分析与publication规则决定摘要/精选/主题/事件展示。

## 费用和失败处理

Jina在provider入口、读取凭据/回执/预算/HTTP之前拒绝上述发布方与MIT公开API域名，覆盖所有purpose、format、round和跨日身份；既有unknown回执不释放、不重放。站点未支持路径也不购买Jina。其他发布方保持原有策略。

匿名原站GET复用 `guardedFetch` 的DNS、连接、来源、大小及超时边界，无Cookie/登录、验证码绕过或新付费服务。408/429/5xx和网络故障交给原worker三次有界正文重试；401/403/404、权限/身份/内容校验失败留未确认，不把认证失败当预算等待。达到原提取重试上限后仍只按已有摘要正常评估。

日常正文成功写入前锁定原source，再按文章ID/URL/revision重验source/config/enabled/editorial/title，才产生正文新修订、历史、安全取得审计及原分析交接。无效内容决定也校验来源/配置及URL；网络异常的失败计数沿用既有worker的revision保护。没有直接设置selected/eligible/visibility或增授全文权限。

## 验收记录

私有基线、测试、原站接口及RSS安全证据位于 `.data/qa/routine-body-20261101/`；不提交原始回答、正文、密钥或数据库。真实新文章、原站只读可得性、测试库完整链路分别记录，不能相互代替。

2026-11-01 19:48（Asia/Shanghai）加载代码后的真实核验通过：

| 站点 | 既有验收文章 | 日常路径实际正文字符 | 与当前库内正文SHA | 当前API/HTML |
|---|---|---:|---|---|
| DoublePulsar | `h1m1v4f1q656w35cmwo2mdhrv` | 4176 | 一致 | 通过 |
| MIT科技评论17164 | `uln8vfg3gg477t9t70y7bzqzy` | 7354 | 一致 | 通过 |
| Speechhome Nemotron转写 | `rzmkm2w7bfoucbuy944rngcoo` | 8495 | 一致 | 通过 |

上述是免费真实正文路径、原有入库与当前分析/发布投影及页面的复用核验，没有重提取写库或重评分。另有DoublePulsar五篇feed样本、MIT与Speechhome各两篇最新匿名API样本全部取得公开完整字段；最新MIT接口内容与旧库版本不同，仅记录差异，没有据此改写旧正文或撤销原领域过滤。

本轮162篇既有材料中，当前没有可直接进入新流程的pending/new文章；最近48小时5篇非ok材料均已分析或被领域规则排除，保持原状态。DoublePulsar最新帖已超48小时。因此本次没有新增生产文章入库/发布样本，不能把上述只读接口成功当成新文已自动发布。新未知ID/URL的正常队列→提取→正文新修订→分析交接在隔离测试库实测通过；下一篇符合原范围、由既有发现链路送入且需要正文的文章会自动复用日常路由。没有为了验收重开旧批次、修改日期或新灌历史文章。

最终全量后端990/990、生产Node24.14关键107/107、前端40/40，类型检查、构建与线上smoke全部通过。离线测试还覆盖已ok复用、非bare partial先提取、固定proof仍必需、中央Jina禁令、旧unknown保留、来源/配置/URL/revision/暂停/参与方式的请求中变化，以及原三次临时失败重试。早期过渡测试中，固定计划终止后的旧未确认结果断言，以及429/500返回null断言，已分别按本次独立日常授权和可重试语义调整；最终稳定源码全量通过，日志保留。无新依赖或数据库迁移。

仅CoreScope正常优雅重启：19:47停止，19:48:01原Windows托管入口ready，原worker继续运行，8780/8781/5448健康。V2 PID21268和BirdClaw PID25300及创建时间与基线相同；BirdClaw519个跟踪文件、配置及全局CLI指纹相同。本任务未修改、启停、重配V2/BirdClaw或其他checkout。

Jina的14条既有回执及14个attempt完全未变，本次三站新增Jina请求为0。来源配置/许可、24个发布保护文件、预算配置和全局48h/最新2000均未变，5篇旧非ok材料保持原状态。源码、测试与本文提交 `CosmosHWPG/AIHOT` 的 `codex/corescope-system`，不合并PR；运行地址 `http://127.0.0.1:8780/`。私有结果为 `verification.json`、`sites.csv`、`results.md` 及边界/测试日志。
