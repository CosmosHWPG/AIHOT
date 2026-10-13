# Bird 接入、验收与运行说明

2026-10-13。设计基线见 [Bird设计评估](CORESCOPE_BIRD_COLLECTION_DESIGN.md)。本文记录实际实现和持续全量扩展的边界。

## 真实试点

CoreScope 已新增 `provider=bird`，用自己的 Node24 调用项目内固定的 Bird0.8.0，独立调度、入库、分析和发布。Windows当前用户 AUTH_TOKEN/CT0 只在内存中读取并注入 Bird，代理复用本机127.0.0.1:7897。没有嵌入BirdClaw、修改或启停V2/BirdClaw，也没有覆盖全局Bird。

项目依赖与BirdClaw所用全局包的52个JavaScript文件逐个哈希一致。真实whoami核验与BirdClaw acct_primary身份一致，回执2516完成；该核验不永久保证Cookie有效性或未来限流状态。

首批正式采集在北京时间16:16–16:21完成：

| 账号 | 原来源ID | 结果 | 新材料 |
|---|---|---|---:|
| AnthropicAI | corescope-x-anthropicai | 成功 | 1 |
| rohanpaul_ai | corescope-x-rohanpaul-ai | 成功 | 7 |
| emollick | v2-source-186 | 成功 | 6 |
| OpenAI | v2-source-190 | 成功，本轮窗口无新材料 | 0 |
| karpathy | v2-source-3725 | 成功，本轮窗口无新材料 | 0 |

首批新增14条，来源ID和原平台水位保留。所有调用经过Bird回执、预算和profile互斥。后台继续运行后，17:30快照为15轮成功、累计新增61条；12个不同账号已有成功记录，102个仍待首次成功。该数量会继续变化。

五篇来自Rohan Paul、AnthropicAI、emollick的材料按原模型与发布规则进入公开[全部动态](http://127.0.0.1:8780/all)，包括Natura-1、Claude蒸馏防御及端侧模型观点。没有手工提高分数、设置精选或修改行业门槛。原始帖链接、正文、来源和发布时间保留。浏览器实际看见中文标题、摘要、来源与评分，公开单篇HTTP200。入库和公开全部动态不等同于进入精选或热点。

真实回执重放：复用2517，`created=false/revised=false`，同一 `x:2109795898909950247`只有一条材料，新增Bird网络调用为0。

后台来源详情HTTP200，显示Bird选择、会话验证记录、当前供应商最近成功及覆盖缺口。实际API/HTML没有包含认证Cookie、管理员密码或模型密钥，验收用登录会话已退出。

## 全量扩展范围

试点后，本机来源路由按5→20→114扩展，114个启用X来源已配置为Bird；持久Windows托管worker逐个推进。**这不表示114个作者均已真实抓取成功。** 下方status的 `fleet.succeeded/awaiting_success` 与逐源详情反映实际进度。

初始政策保持1 CLI/分钟、10/滚动小时、120/滚动24小时；模型额度保持原值。全量目标间隔1440分钟，续读可提前检查，但同样受总预算、公平调度和冷却限制。一个CLI可能包含多个X请求，不能以CLI次数充当精确HTTP请求数，也不能据此保证两套系统合计流量。114个作者各一页加正文/重试可能超过日额度，实际覆盖会延后，不承诺24小时内全部完整。

每分钟至多排一个Bird作者，优先最近成功时间较早的到期来源。额度、已有排队任务、租约或冷却阻止排队时不虚增抓取失败；手工容量门控返回skipped/deferred并保留健康状态。RSS、网页、JSON、公众号及V2只读桥继续独立运行。

源包保留可选Xquik默认配置；本机Bird偏好保存在独立数据库并有审计，seed/route-upgrade保留人工配置。新的独立安装按plan/enable显式迁移，不依赖这台机器的数据库或私有.env。不自动回退到付费供应商。

## 配置与操作

CoreScope私有.env或后端collectors.env：

```dotenv
BIRD_ENABLED=true
BIRD_ACCOUNT_PROFILE=birdclaw-primary
BIRD_CREDENTIAL_MODE=user-env
BIRD_PROXY_URL=http://127.0.0.1:7897
# BIRD_EXPECTED_USER_ID=本人已核验的采集登录账号ID
# BIRD_EXPECTED_USERNAME=该登录账号句柄
```

user-env读取当前Windows用户已配置的AUTH_TOKEN/CT0，不依赖旧Codex/启动器环境。缺任一值时拒绝调用，避免自动读取浏览器另一账号。期望身份是采集登录账号，不是目标OpenAI等作者。Cookie禁止写来源JSON、CLI参数或Git；禁止运行会输出Cookie前缀的 `bird check`。

项目npm依赖固定Bird0.8.0；CLI优先使用项目node_modules。BIRD_CLI_PATH/BIRD_NODE_PATH用于明确的外部路径，BIRD_CLI_SHA256可绑定入口完整性。本机已固定核查过的入口哈希。无需Git Bash、BirdClaw Node26、3001服务器或SQLite原生npm包。

在项目根目录执行：

```powershell
.\Start-CoreScope.cmd
.\Status-CoreScope.cmd
.\Stop-CoreScope.cmd

# 状态检查不发X或模型请求。
node --env-file=.env scripts/corescope-bird.ts status

# 首次启用或更新Cookie后：经回执和预算核验真实登录身份。
node --env-file=.env scripts/corescope-bird.ts auth

# 默认五账号的可审阅迁移计划及应用。
node --env-file=.env scripts/corescope-bird.ts plan
node --env-file=.env scripts/corescope-bird.ts enable

# 手工真实验证最多五个来源，遵守同一预算。
node --env-file=.env scripts/corescope-bird.ts fetch --ids=corescope-x-anthropicai

# 试点通过后全量迁移，默认目标间隔1440分钟。
node --env-file=.env scripts/corescope-bird.ts plan --all
node --env-file=.env scripts/corescope-bird.ts enable --all
```

operations只允许独立本机5448/corescope数据库，拒绝V2或其他数据库。来源修改使用正式管理员事务和审计；保留原ID、lastTweetId/initializedAt，旧供应商opaque cursor归档。Cookie变化、401或认证403时，更新用户配置后重新auth；更换登录账号必须核验期望身份，不绕过匹配检查。

看资讯：[全部动态](http://127.0.0.1:8780/all)。看状态：[后台来源管理](http://127.0.0.1:8780/admin/sources)。长期打开的公开页面需刷新/导航读取新数据。退出Codex或关闭启动窗口后，Windows托管服务继续运行；电脑重启/注销后仍需手动启动。

## 完整性及故障边界

- 每次CLI一页，由CoreScope逐次保存回执和业务结果。CLI内部多页失败会丢前页，不能把单次max-pages改大。
- bottom cursor用于回溯，到期追新从顶部开始。空页丢cursor不证明完整覆盖；置顶、转发和引用不提前结束范围。
- 近期成功和完整覆盖分开。旧Xquik未读backlog与超48小时停机缺口持续保留，需独立补抓证据或人工确认，不能用新的一页擦掉。
- 所有X单源及分片提交锁定并核验来源快照；切换途中旧任务不覆盖新配置、游标、间隔或材料。Bird专用手工命令额外锁定期望供应商；等待期间来源改路由时，在创建抓取轮次或发送请求前跳过，不能转用付费接口。
- 历史provider按原证据固定，未知标unknown。Article元信息即使没有正文链接也触发待补；read只有正文证据才输出全文blocks，缺全文为unconfirmed，不隐式调用收费接口。
- 明确受保护作者拒绝公开采集；受保护引用正文从标准化和原始回执剔除。只暴露读取，无发帖、关注、点赞或私信。
- Node无shell、隐藏窗口、环境白名单、45秒总时限、8MiB JSON上限和独立query-ID缓存。取消只终止所持CLI，不按进程名结束其他Node。
- 429当前固定冷却15分钟，认证错误冷却30分钟并需重新auth。CLI没有可靠提供Retry-After，故不宣称精确上游时长。unknown网络结果遵守既有回执恢复策略，不循环重发。
- 单profile门控仅覆盖CoreScope API/worker/脚本，不约束BirdClaw合计流量。Bird npm已经停止维护，未文档化GraphQL可能变化；版本固定、隔离和回滚用于管理该限制。

## 验证与证据

类型检查、web生产构建通过；最终提交代码在独立空corescope_test后端全套702/702、0跳过；web32/32；生产HTTP/API/MCP smoke35/35。测试包含Bird回执/并发/分页/隐私、Article正文证据、手工命令路由变化、旧provider切换竞争、升级保护及Windows托管存活。

后端测试使用项目内私有官方Node24.20.0，生产仍为既有Node24.14.0，没有升级全局Node、V2或BirdClaw运行时。部署前独立PG备份 `.data/backups/corescope-before-bird-20261013.dump` 为145,651,599字节，pg_restore --list校验通过。

私有证据在 `.data/qa/`：bird-live-preflight.json、bird-pilot-processing.json、bird-http-acceptance.json、bird-replay-proof.json、bird-backend-final.log及边界快照；密钥、数据库和原始响应不提交Git。V2代码/配置、BirdClaw跟踪文件/config/全局CLI哈希和服务PID/创建时间用于边界复核。它们自己的服务正常更新数据库，不能要求运行中的数据库字节不变。17:30边界哈希复核全部一致，V2和BirdClaw服务仍为原PID及创建时间；重启后的CoreScope四角色ready，35项线上smoke通过。

关闭Bird总开关停止新调用而不删除材料；通过后台回退provider，供应商游标分别归档并保留缺口。付费供应商凭据与额度另行验证，回退不取消预算。
