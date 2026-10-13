# CoreScope 本机完整系统

CoreScope 使用独立 PostgreSQL、API、网页、worker 和 V2 只读桥。它保留 AIHOT 的事件、热点、精选、主题、日报、管理后台、RSS、公开 API 和 MCP；网页通过 HTTP 读取 API，用户浏览网页不调用模型。它不是静态预览。

## Windows 一键运行

需要 Node.js 24.11 或更新版本。本机运行不需要 Docker，也不安装 Windows 数据库服务。

1. 在项目根目录准备私有 `.env`。当前交付已按授权复用 V2 模型服务配置，管理员密码和各个签名密钥另行随机生成；所有秘密仅在本机文件内，未提交 Git。
2. 双击 `Start-CoreScope.cmd`，等待最后的 **[READY]**。
3. 浏览器打开 **http://localhost:8780**，管理员入口 **http://localhost:8780/admin**。登录密码取自本机 `.env` 的 `ADMIN_PASSWORD`。
4. 双击 `Stop-CoreScope.cmd` 停止独立系统。数据保留，下一次启动接续处理。

第一次启动会从 [EDB 官方 PostgreSQL 二进制分发](https://www.enterprisedb.com/download-postgresql-binaries) 下载固定版本 PostgreSQL 17.11 x64 ZIP 到 `.data/runtime/`，只解压运行文件，不注册全机服务。在 Windows ARM64 上通过系统 x64 仿真运行。下载地址、文件大小和本次实际 SHA-256 保存在 `.data/runtime/postgres-download.json`；该 SHA-256 是本机下载记录，不冒充官方独立校验值。

启动器初始化数据库、运行增量迁移、幂等导入主题和新增信源、按需安装依赖与构建前端，然后隐藏启动各个进程并检查真实数据库健康。重复启动会复用已经确认归属的进程。若端口被其他进程占用，会报错并保留该进程，不按端口强行停止。

启动窗口依次显示配置检查、数据库认证、迁移、种子同步、预算检查、网页构建和应用健康检查的进度。只有最后出现 `[READY] CoreScope is ready` 或 `[READY] CoreScope is already running` 才表示完整系统可用；中途的 PostgreSQL ready 只表示数据库准备完成。

后台由 Windows 任务计划程序托管，使用当前登录用户、普通权限和免密码的交互登录令牌。任务只在点击启动时运行，没有开机或登录触发器；项目专属 `System` 长期任务持有数据库和应用监督进程。维护时单独使用 `Database` 长期任务启动数据库，随后完整启动可以安全复用该数据库。关闭启动窗口、退出或崩溃的 Codex 不再承担服务生命周期。任务不设置运行时长上限，切换到电池不会停止。运行边界是当前 Windows 登录会话；注销或重启电脑后重新运行 `Start-CoreScope.cmd`。

双击 `Status-CoreScope.cmd` 可以检查任务宿主、数据库 PID、API/网页数据库健康及各应用进程。完整 `[READY]` 出现后可以关闭启动窗口；需要停止系统时运行 `Stop-CoreScope.cmd`，让正在处理的请求和数据库正常收尾。任务启动请求已送达后，准备过程也由后台宿主执行；若启动窗口过早关闭，再点击启动会等待同一实例。没有合法任务宿主的旧版后台实例不会被当作新机制的健康实例复用，升级时先运行停止脚本。

启动失败时窗口保留 `[FAILED]` 以及失败步骤。错误时间、步骤和原因追加写入 `.data/logs/startup.error.log`，每一步和迁移、种子等子脚本输出保存在 `.data/logs/startup.log`；两者为 UTF-8 JSON 行日志，启动器会隐藏已配置密钥、密码和数据库连接串。可以把错误日志中的最新错误交给维护人员排查，不要发送 `.env` 或运行状态文件。双击启动器失败后会等待按键，按键关闭窗口后日志仍然保留。

| 组件 | 监听或位置 |
| --- | --- |
| 网页、管理后台、RSS、公开 API、MCP | `127.0.0.1:8780` |
| 内部 API | `127.0.0.1:8781` |
| 独立 PostgreSQL | `127.0.0.1:5448` |
| 正式库 / 测试库 | `corescope` / `corescope_test` |
| 数据库文件 | `.data/runtime/postgres-data/` |
| API / web / worker / bridge / PostgreSQL 日志 | `.data/logs/` |
| 启动步骤、子脚本输出 / 启动失败详情 | `.data/logs/startup.log` / `.data/logs/startup.error.log` |
| 监督进程与子进程 PID、入口、启动时间 | `.data/runtime/processes.json` |

控制脚本可在 PowerShell 中单独执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/corescope-runtime.ps1 -Action Start -NoBrowser
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/corescope-runtime.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/corescope-runtime.ps1 -Action Stop
```

`-Action Database` 只准备并启动独立数据库，适合迁移和测试。停止应用时，启动器先核验 PID、创建时间和项目入口，通过项目专属命名管道及 IPC 请求正常退出，等待 worker 已开始的付费请求和回执收尾，最后正常停止 PostgreSQL。收尾最多等待约 205 秒。监督进程异常丢失且仍有已确认归属的子进程时，脚本报错并要求先排查日志，避免直接关数据库。

## 必要配置

```dotenv
SITE_URL=http://localhost:8780
WEB_PORT=8780
API_PORT=8781
API_BASE_URL=http://127.0.0.1:8781
POSTGRES_USER=corescope
POSTGRES_PORT=5448
DATABASE_URL=postgres://corescope:<本机随机密码>@127.0.0.1:5448/corescope
V2_DATABASE=<现有V2 SQLite完整路径>
CORESCOPE_V2_BATCH_LIMIT=6
CORESCOPE_V2_POLL_SECONDS=120
CORESCOPE_BRIDGE_ENTRY=scripts/corescope-v2-bridge.ts
CORESCOPE_BRIDGE_ENABLED=true
# 公开采集与源站探测使用相同出口；填写本机有效 HTTP 代理，未使用时可省略
EGRESS_PROXY_URL=<本机可用HTTP代理>
# 仅为已授权本机公众号解密缓存目录，不填入公共 source profile
WX_CACHE_DIRECTORY=<授权公众号缓存目录>
```

所有进程都使用真实管理员鉴权，禁止设置 `DEV_AUTH_ROLE`。数据库只监听本机地址。飞书推送、飞书告警和 IndexNow 默认关闭；这些外部出口不属于本机交付。

`EGRESS_PROXY_URL` 控制 `guardedFetch` 的采集出口，不能只以终端中另一种 HTTP 客户端成功来断言 worker 可达。2026-10-12 的迁移使用同一采集出口验证 RSS、官网列表和 JSON；代理配置仅保存在本机 `.env`。

`WX_CACHE_DIRECTORY` 只给只读公众号适配器定位已授权本机缓存。CoreScope 仅读取公开账号文章，不运行 `wx`、不启动或停止 daemon、不写缓存、不读私人聊天、不管理 V2。该路径不属于公开 profile，也不得提交 Git。已有本机缓存刷新流程必须继续提供新数据；仅启动 CoreScope 不会登录微信或自动刷新该缓存。

`COLLECT_ENABLED` 和 `MODEL_CALLS_ENABLED` 是真实安全阀：设为 `false` 仍可浏览、管理和查看已发布资料，但停止相应的直接采集或模型调用。开启后由 worker 的模型回执和预算熔断控制开销；V2 桥只读原系统，不在原系统写入或重启服务。更改 `.env` 后先停止再启动，保证所有进程加载同一份配置。

更新代码或行业配置时也先停止，完成 `git pull` 或本机修改后再启动。启动器会应用尚未执行的增量迁移并按需重建网页；直接重复点击启动只验证并复用现有进程，不会在处理模型请求期间替换代码。

桥入口：

```powershell
node --env-file=.env scripts/corescope-v2-bridge.ts --watch
```

启动器已经包含这个桥进程，请勿在正常运行期间另起重复 watch。单次导入和历史补齐参数以桥脚本的帮助输出及 V2 接入文档为准。

## 2026-10-12 信源迁移与资源目录

本次接入 profile 取代最初 174 个启用、13 个原生 RSS 的配置。425 个 canonical 来源目前拟定为 284 个原生路线（203 RSS、15 网页列表、15 JSON、51 只读公众号缓存）、125 个 V2 桥接路线、14 个原暂停来源和 2 个未接入资源目录。原生路线已保留真实解析证据；这些配置数字不能代替正式库的实时健康或发布产出。

原 251 个关闭来源中，227 个恢复资格来源已逐项复核（146 个原生、81 个受限桥接），14 个原暂停来源继续关闭，10 个非文章页单独进入资源目录。资源目录 `/resources` 将 8 个已验证监测入口与 2 个参考入口分开说明；资源记录使用 `isolated`，不进入精选新闻或热点计数。Docker 仅观察 vLLM 官方容器标签，GitLab 仅观察 `machine-learning` 公共项目，npm 使用 AI 关键词搜索，PyPI 是全站更新元数据；不能宣传为完整监测整个平台。

在停止 CoreScope 应用、保留 V2 只读边界的维护阶段，先探测和审阅配置，再预览正式库变化：

```powershell
# 有界源站验证；只读已授权公众号缓存，不调用模型或付费提供商
node --env-file=.env scripts/corescope-source-probe.ts
node --env-file=.env scripts/corescope-source-probe.ts --resume
# 只核查指定来源，不改 profile、审计或增量进度
node --env-file=.env scripts/corescope-source-probe.ts --ids=v2-source-183,v2-source-106 --no-write
# 从只读 V2 目录与已审阅 profile 生成 source pack
python scripts/corescope-v2-export.py --db "<V2 SQLite路径>" --sources-only --source-profiles industry/corescope-source-profiles.json --source-pack industry/sources.json --source-map docs/corescope-v2-sources.json
# 只启动本项目数据库，准备维护；完整应用此时仍停止
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/corescope-runtime.ps1 -Action Database
node --env-file=.env scripts/seed.ts
node --env-file=.env scripts/corescope-source-upgrade.ts --dry-run
# 审阅预览回执后应用；该命令不写 V2
node --env-file=.env scripts/corescope-source-upgrade.ts --apply
```

探测脚本默认更新本项目的 profile 与审计 JSON，`--no-write` 仅显示结果；两种方式都不会自动升级正式库。`seed.ts` 不覆盖已存在来源，必须使用专用升级脚本迁移既有采集路线。14 个原暂停来源的冻结名单在重跑时保留；原生路线和桥接路线互斥，同一入口不能同时采用两者。管理员受保护配置冲突会在升级结果中报告，不应通过盲目覆盖消除。

完成正式库升级后，再运行 `Start-CoreScope.cmd` 并用实际 source 状态、队列、新增材料和发布回执验收。本节维护操作本身不证明运行成功；2026-10-12最新616源、191个补齐入口的正式库与采集验收见 [补齐记录](CORESCOPE_ONLINE_EXPANSION.md)。原425源与2026-10-04历史验收见 `CORESCOPE_SOURCE_AUDIT.md`，历史材料数不能当作今日运行数据。

## X与公众号API配置

在本项目私有 `.env` 填写 `X_TWITTER_SCRAPER_API_KEY` 和 `DAJIALA_KEY`；默认服务地址无需额外填写。`COLLECT_KINDS` 包含 `x_search` 后启用原生X定时调度。修改密钥后用 `Stop-CoreScope.cmd` 正常停止，再运行 `Start-CoreScope.cmd` 重新加载配置。不要将密钥提交Git或发送到聊天。

公众号无需猜测ghid：新增目录已含公开原文长链与核验biz。Dajiala每轮新增正文上限2篇，并遵守既有请求预算；余额不足明确保留错误，充值后下轮或后台手动采集可续读已存回执。缓存通道使用只读账号匹配，独立于API充值。X预算与credit预留详见 [Xquik配置](CORESCOPE_XQUIK.md)。

## 构建、测试与验收

```powershell
npm run typecheck
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node --env-file=.env scripts/smoke.ts --base http://localhost:8780
```

后端测试必须使用空的 `corescope_test` 库（数据库名必须以 `_test` 或 `_ci` 结尾），先运行迁移，并关闭采集和模型安全阀。禁止对 `corescope` 正式库运行隔离测试。

网页完整性检查包括精选、全部资料、热点、事件报道、日报与历史、主题与主题详情、收藏、管理员登录、RSS、OpenAPI 和 MCP。真实内容到达后的分析、归组、热度、日报结果应在后台运行记录及回执中验收；HTTP 200 只能确认页面可访问，不能代替这些结果。

## Docker 运行

原生一键运行和 Docker 是两个独立部署选项。Docker 机器上沿用 [原项目部署文档](deploy.md)：

```bash
docker compose up -d --build
```

Compose 为数据库、上传文件和缓存使用自己的卷，不读取原生 `.data/runtime/postgres-data`。API / web 使用容器内部端口，网页对外端口由 `.env` 的 `PORT` 控制；`SITE_URL` 要对应实际访问地址。需要 V2 桥时，V2 的 SQLite 及其必要只读文件必须挂载到桥运行环境，并设置该环境中的 `V2_DATABASE` 路径；Windows 本机路径不能原样在 Linux 容器内使用。已有原生系统仍在运行时，请避免复用同一个外部端口。

远程上线、域名、HTTPS 和条款内容确认按原项目 `docs/deploy.md` 处理。本交付的验收目标是本机系统与一键启停。

## 最近48小时、最新2000条的处理策略

2026-10-13新增独立开关 `content.recent-processing`。先在现有 `editorial` / `hot_signal` 来源范围内，按真实 `published_at DESC,id DESC` 取最近48小时且非未来的最新2000条，再筛选未完成任务；已分析和领域排除记录仍占据各自在前2000的位置。`isolated` 资源保持原资源结算路径，不占新闻模型槽位，不改来源参与方式或公开资格。旧稿、日期未知及范围外记录保留原状态，不标记失败、不删除。

统一入口、正文队列、分析消费者和事件队列共用范围保护；现有待执行任务只调整优先级，已开始任务自然完成。启用后重启worker，分析队列以一个消费者完成每篇的正常处理链，然后接续下一篇。新采集更新滚动范围；每分钟校正待执行优先级，每5分钟补齐范围内正常到期任务。已保存回执继续复用，不添加重评分身份。

```powershell
# 只读计划/当前状态；私有明细保存于 .data/qa/newest48h-2000。
npm run corescope:processing -- plan
npm run corescope:processing -- status

# 启用范围并排入正常队列；不改变模型额度。
npm run corescope:processing -- start

# 仅在明确获得额外付费请求授权后使用；未授权不要执行这一选项。
npm run corescope:processing -- start --temporary-llm=2000

# 恢复旧处理范围；重新启动worker以恢复原分析并发数。
npm run corescope:processing -- disable
```

本机文本请求当前使用 OpenRouter `deepseek/deepseek-v4.1-flash`，接口为 `POST https://openrouter.ai/api/v1/chat/completions`。`llm` 的800次是滚动24小时请求尝试上限，包含领域预筛、两次精选评分、结构抽取、中文文案，以及按需要触发的归组、复核、事件综述、报告和翻译。不是800篇文章：普通通过材料通常需要5次文本请求。收到/失败/未知/预占尝试均保守计数，缓存重用不增加次数。向量模型 `qwen/qwen3-embedding-8b` 经 `/api/v1/embeddings`，另受embedding预算，不占llm额度。

此前用户授权将本机LLM上限临时从800改为2000，维持20/分钟、180/滚动小时，并在激活24小时后恢复800。租约期间另限制最多1200次新的live文本请求，即使激活前800次已逐步滚出窗口也不突破这次授权；失败、未知及预占计数，缓存重用不占次数。`corescope.temporary_llm_budget` 持久记录到期时间；每分钟维护及每次LLM请求前均检查到期，服务重启不会延长期限，既有800次计数不清空。管理员后来修改预算时保留其新配置并记录superseded。普通启动不会自动启用或续租临时额度。随后用户授权关闭模型次数限制，实际当前配置见下面的独立预算开关说明。

### 按服务配置预算开关

[后台设置](http://127.0.0.1:8780/admin/settings) → **付费请求预算**。每个服务一行，取消“启用额度限制”、填写修改原因并保存即可关闭该服务的分钟、滚动小时和滚动24小时次数限制。重新勾选保存则按保留的限额和真实滚动使用量执行；限额为0且开关开启表示暂停。关闭预算与关闭采集/模型总开关是两种操作。

2026-10-13本轮用户授权的运行配置：只关闭 `llm` 次数预算，覆盖预筛、双评分、结构化、理解、摘要、事件归组、事件摘要等该服务请求。Bird保持1次CLI/分钟、10/滚动小时、120/滚动24小时；embedding和其他服务保留各自配置。模型仍通过既有OpenRouter接口调用 `deepseek/deepseek-v4.1-flash`，没有更换供应商或模型。

关闭 `llm` 时，后台在同一事务中结束此前的临时2000次租约，并保留原20/180/800数值作为下次启用的限额。已关闭的开关不会在旧租约到期时自动开启。开关保存到独立CoreScope数据库，重启后保留，修改后新请求立即读取，无需再重启服务。首次增量迁移默认所有服务开启，升级本身不改变现有额度。

关闭限制后仍正常计费，所有真实请求、失败/未知状态、用量、成本和回执继续记录，已收到回答继续复用。不会重发未知回执、绕过账号身份/冷却或供应商余额/限流。最近48小时最新2000条处理范围、来源参与方式、领域过滤和精选门槛均保持；关闭预算不保证每条都公开或进入精选。

管理员保存和每分钟维护会只唤醒当前范围内的数字额度等待，通过现有worker正常处理，不清次数、不增补真实错误重试次数、不恢复未知结果，也不启动第二个采集器。采集等待、文本处理等待和向量处理等待需要分别看对应服务。

本机命令同样走正式管理员更新及审计，仅允许5448/corescope：

```powershell
npm run corescope:budgets -- status
npm run corescope:budgets -- set --service=llm --enabled=false --reason="启动期关闭模型次数限制"
# 后续需要恢复时显式执行；不会清空已有使用量。
npm run corescope:budgets -- set --service=llm --enabled=true --reason="恢复模型次数限制"
```

API沿用 `PUT /api/admin/budgets/:service`，支持 `{ enabled, reason, version? }` 或各限额的局部更新。前端只发实际修改的字段，避免关闭临时租约时把旧2000值回写；`version` 为GET的 `updated_at`，过期视图返回409。省略enabled的旧请求保持原开关。

本次预算开关验收：独立空corescope_test后端762/762、0跳过，web40/40；全仓类型检查、生产构建及35项本机HTTP/API/MCP检查通过。22:43:36正式关闭LLM预算，22:44:29核验关闭后36次live尝试（35已收到，1正常在途），使用量216/滚动小时、1196/滚动24小时超过保留数字限制仍继续正常处理；5个正常公开样本的API、HTML与原文链接全部通过。后台GET返回enabled=false，HTML中LLM复选框未勾选。当前窗口53个公开、0个精选，热点榜2个事件；以上为该时点快照，不能视为最新2000条全部处理完成。

22:48:54复核：关闭后201次live尝试（199已收到、2正常在途），当前2000条中76个公开、2个自然精选，热点榜4个事件；12个公开样本的API、HTML、原文链接通过。新精选由既有处理链和门槛自然产生，没有手工设置selected/eligible。Windows托管worker持续运行，材料与逐源验收仍在推进。

2026-10-14 00:10运行快照：当前2000条公开458、自然精选10、热点10，LLM开关仍关闭，Bird/embedding次数限制保持启用。发现1条独立RSS评分终止失败（Data Center Dynamics，回执4179），最近一次响应达到1024输出tokens上限但正文为空；三次格式失败后正常保护机制停止重试，未公开。原预筛与结构化回答保留，需先核验输出长度/格式再正常审计重入队。本次心跳只读诊断该故障，没有调整模型参数、过滤门槛或重评分；安全证据和全批次状态见[持续验收](CORESCOPE_BIRD_FLEET_ACCEPTANCE.md)。

2026-10-14 02:01快照：窗口公开952、自然精选46、热点10、new22，终止失败3条。除原DCD外，AWS Machine Learning Blog的score8996最新1024-token回答正文为空；Techzine Infrastructure的understand9248为itemType枚举校验失败（正常stop、非截断），均在三次输出失败后暂停且无公开记录。保留前序回答，未盲重放或更改模型参数；诊断、原始回执身份和恢复要求见持续验收记录。后台健康，LLM预算off、Bird/embedding预算原值保持。

部署前备份 `.data/backups/corescope-before-budget-switch-20261013.dump` 为166,935,156字节、目录校验通过；证据存于 `.data/qa/budget-switch`。Windows托管System host、独立PG、API、web、worker及只读bridge均ready，未增加自动采集器。源配置指纹不变；V2/BirdClaw服务PID与创建时间不变，BirdClaw519个跟踪文件/config/全局CLI指纹不变。原V2整体及并行同步差异说明继续保留。

事件归组/综述遇到预算不足或回执在途改为持久等待，不消耗真实失败重试额度；旧精确预算终止错误补入恢复队列一次，未知请求不因本修正重复发送。讨论补召回覆盖48小时，已建事实也补召回迟到讨论；同模型实际输入复用原回执，候选变化走正常判断，不强行挂接。精选和热点仍受原评分、公开及多来源证据规则约束；计划清单或HTTP 200不能证明已经产生新精选/热点。

主页在当前筛选下没有最近48小时自然精选时，单独展示最多6条近期公开动态，按真实发布时间排列；沿用AIHOT卡片与时间轴，明确区分动态和精选，保留历史精选列表。辅助API异常不阻断原精选；自然新精选出现后隐藏过渡区。公开资格、精选分数和首页热点至少3条的显示规则均保持原值。

2026-10-13本机验收：迁移0045/0046已应用；临时额度激活于21:18:34，2026-10-14 21:18:34自动到期。180个本轮请求已收到结果，11个新增公开样本和1个更新样本通过详情API、HTML与原文链接；29个精确预算终止记录已登记一次性恢复，窗外任务按新范围跳过，其余按原回执接续。Maia300讨论经真实归组判断正常关联既有报道，21:35热点排名产生1条，热点API、榜单和事件详情原文链接通过。新精选仍为0，不报告全量2000已完成；21:41范围内1710篇仍待处理，模型小时上限180已满，首批容量从22:25起逐步释放。worker继续按同一规则处理。主页已显示近期公开动态；CSV/JSON清单由processing status更新。

发布代码后端全套742/742、0跳过，web36/36、全仓类型检查、生产构建通过；正式全站35项HTTP/API/MCP检查通过。备份 `.data/backups/corescope-before-recent-processing-20261013.dump` 为161,803,251字节，pg_restore目录验证通过。私有逐条与运行证据保留于 `.data/qa/newest48h-2000`，不提交数据库、回执原文或凭据。本轮只修改和启停独立CoreScope；V2与BirdClaw未由本任务修改或启停，前后服务PID一致，BirdClaw代码/config/全局CLI指纹一致。旧V2整体及18:23运行范围指纹仍存在独立并行工作的差异，保留原证据，不恢复或覆盖这些文件。
