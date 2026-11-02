# Jina Reader 正文兜底

本次范围：只启用 CoreScope 的普通网页正文兜底；不启用 Jina 列表采集，不修改 V2、BirdClaw、来源参与方式、领域规则、评分或公开全文许可。Jina Key 由使用者在本机填写，密钥及私有验收材料不提交 Git。

## 本机配置

CoreScope 私有 `.env`：

```dotenv
JINA_API_KEY=在本机填写
JINA_BODY_FALLBACK=true
COLLECT_SKIP_JINA=true
```

两个开关直接读取进程环境，应放在项目 `.env`。Key 也支持既有 `collectors.env` 分组凭据机制。已经运行的系统须正常停止再启动，只有再次执行 Start 不会让现有进程重新加载 `.env`。

`COLLECT_SKIP_JINA=true` 保留原来的普通 RSS、网页列表、JSON 采集；不会将它们改写成 Jina 列表。X 和公众号继续使用各自原路线。正文补齐的成功不等于允许在站内展示全文，原 `site_fulltext`、`syndicate_fulltext` 保持。

## 处理行为

1. 文章需要正文时，先通过普通 HTTP 路线读取并用 Readability 提取正文。
2. 直连失败、返回非 HTML、或没有可用正文时，才请求 Jina Reader；请求经过现有回执与 `jina` 服务预算。
3. 可用正文保存在原文章身份下，正常产生新 revision，再由唯一托管 worker 分析、发布和归并，不创建新的来源或重复文章，不设置精选/公开资格覆盖。
4. 正文不足时记录 `unconfirmed`；内部预算不足或相同请求仍在执行时保留容量等待，不消耗真实提取失败次数。
5. Jina 回执随正文写入、无正文结论或过期结果处理事务一起结算；持久化失败保留收到的回答供后续复用，不重复购买。

正文至少200字符、原模型和发布门槛均不变。HTTP200和长度本身不足以证明正文正确，真实验收还须核对来源URL、文章主题/标题和验证码等异常页面迹象。

Jina 的 `jina` 预算独立于 Bird、LLM、embedding。接入时保持已有预算开关和数字，不清使用量。供应商余额、认证和上游限流仍有效，`pending/unknown` 不允许盲目重放。

## 本次固定试点

2026-10-31，四个不同公开网站的既有文章，均有原生发现记录、正文未确认，且处于自然最近48小时/最新2000条范围，无活跃任务或未知Jina回执。使用正式提取重试入口，保留原文章身份与发布规则。

| 网站 | article ID | 直连复测 |
|---|---|---|
| MIT 科技评论中文网 | `ec31gjan114yqx761zl9p691k` | HTTP200，但无法提取可用正文 |
| Data Center Dynamics | `epddqlx4i208ju6vlsyguc0cb` | HTTP403 |
| Dark Reading | `ca5xvfszixso0zmtf5ysacbyz` | HTTP403 |
| OpenAI | `l2klfoq48rgvlf2y6dnqomu3k` | HTTP403 |

The Decoder 是直抓恢复的对照样本，不计作 Jina 抓取成果。原材料已有摘要公开页，因此本试点验收的是正文补齐、新 revision 的自然分析和公开投影更新，不能称为新增四篇文章。

固定清单及私有证据位于 `.data/qa/jina-pilot-20261031/`，不提交原始回答、正文、数据库或密钥。

2026-10-31 23:26:53（Asia/Shanghai）验收完成，四站均通过。四篇文章均在原身份下由 revision1 升至 revision2，正文状态为 `ok`，新修订经原规则分析后自然公开；没有新增四篇重复文章、没有人为设置精选。

| 网站 | 入库正文字符数 | Jina回执 | 公开结果 |
|---|---:|---|---|
| MIT 科技评论中文网 | 6,596 | 220701，1次，completed | API/HTML200，原文链接通过；全部动态 |
| Data Center Dynamics | 17,241 | 220720，1次，completed | API/HTML200，原文链接通过；全部动态 |
| Dark Reading | 11,965 | 220723，1次，completed | API/HTML200，原文链接通过；全部动态 |
| OpenAI | 1,974 | 220722，1次，completed | API/HTML200，原文链接通过；按原规则自然入精选 |

逐项核对了 Reader 返回标题、原链接、文章主题关键词和验证页迹象；没有仅凭长度或HTTP200判通过。MITTR、DCD另经独立浏览器标签页实看，中文标题/导读/来源/原文链接与评分栏正常，无明显重叠、截断或横向溢出。OpenAI已在精选时间线API及首页HTML核实。列表仍按原时间排序，没有将试点材料置顶。

部署后截至23:27:34的Jina真实请求均为 `body_fallback`，没有Jina列表请求。试点四次请求均一次返回并结算；原worker另有一条正常正文兜底请求，说明新数据会继续使用此功能。Jina预算保持5/分钟、50/小时、300/滚动日；Bird/LLM/embedding原开关及数字保持不变。

验证：独立 `corescope_test` 后端819/819、前端40/40、类型检查、网页构建及运行站点smoke全部通过。发布/精选四个受保护代码文件与接入前哈希相同；四个来源配置和全文许可相同，试点文章无人工覆盖、无新attemptTag。

本次仅正常停止/启动CoreScope。V2和BirdClaw监听PID分别保持18480、25300；BirdClaw519个跟踪文件、配置及全局CLI与接入前比较无变化。原系统和其他并行checkout未被修改或恢复。

## 回退与边界

需要关闭后续正文兜底时，将 `JINA_BODY_FALLBACK=false` 后正常重启 CoreScope，继续保留 `COLLECT_SKIP_JINA=true`。已经获取的正文和历史回执保留，不回滚原始证据、不修改发布判断。

此接入没有目标网站Cookie透传、自动登录、会话续期或验证码处理；不能保证恢复所有403。外部服务返回的错误或等待需按真实回执报告，不以放宽正文、评分或发布资格代替恢复。
