# CoreScope 后台托管修复（2026-10-13）

本机入口是项目根目录 `Start-CoreScope.cmd`，网页为 <http://127.0.0.1:8780>。完整启动以最后的 `[READY]`、真实数据库认证、API/网页健康和所有应用进程身份为准。`Status-CoreScope.cmd` 用于检查；`Stop-CoreScope.cmd` 正常停止并保留数据。

## 故障与机制

2026-10-13 06:56:20（北京时间），Windows 记录 Codex 异常退出和虚拟内存不足；PostgreSQL 在 06:56:25 记录连接强制断开。旧监督进程、API、web、worker、bridge 和 PostgreSQL PID 后来都已消失，状态文件仍留在 `ready=true`，没有正常停止日志。系统最近一次启动时间仍为 2026-09-28，因此该断点不是电脑重启。旧 PID 已退出，无法事后证明其具体 Job 归属或精确终止原因。

现执行进程所在 Windows Job 的限制为 `0x2800`，包含 `KILL_ON_JOB_CLOSE` 和 `BREAKAWAY_OK`，没有 `SILENT_BREAKAWAY_OK`。旧 Node 启动器使用 `detached/unref` 和文件日志，能消除控制台与管道依赖，但 [Node 24.14 的 Windows libuv 源码](https://raw.githubusercontent.com/nodejs/node/v24.14.0/deps/uv/src/win/process.c) 没有请求 `CREATE_BREAKAWAY_FROM_JOB`。根据 [Windows Job 规则](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)，这仍存在宿主 Job 清理时连带结束后代的机制风险；不能把此前单独终止假父进程的测试当作覆盖整个宿主 Job。

## 实现

Windows 任务计划程序按本项目路径和启动模式命名长期任务。普通完整启动由 `System` 任务持有独立 PostgreSQL 和应用监督进程；维护时可以先使用 `Database` 任务仅启动 PostgreSQL，随后 `System` 安全复用该数据库，两个宿主都持续等待其进程正常停止。任务采用当前用户 `InteractiveToken`、普通权限、免保存密码、无触发器、按需启动和重复运行忽略。`ExecutionTimeLimit=PT0S` 取消默认时长上限，电池切换不会中断任务；[Microsoft 的运行期限说明](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)明确零时长代表无限运行。

任务 Action 持续运行本项目 `Hosted` 入口。监督进程继续管理 API/web/worker/bridge，原文件日志、私有配置、模型预算和鉴权控制管道保留。任务登记和 `Running` 状态不等于系统健康：启动器还需核验任务定义、宿主 PID/创建时间/项目路径、数据库 PID及认证、API与网页的数据库查询，以及每个应用的真实入口和 readiness。未有合法任务宿主的旧后台需要先正常停止再启动，不能以复用旧 PID 冒充新机制验收。

停止通过原命名管道等待已开始的请求收尾，再正常停止本项目数据库，宿主随后自然退出，不使用粗暴的任务终止。关闭启动窗口或退出 Codex 不等于停止 CoreScope；注销 Windows 或重启后需要重新运行启动脚本。本次没有新增开机/登录自启动，也没有修改 V2 的代码、配置、数据库或服务。

## 验收

以下为北京时间 2026-10-13 本机验收，独立测试只使用临时假进程、私有 Job 和随机任务，不关闭用户的 Codex 或 Windows 窗口；真实系统验收也只关闭专门创建的启动请求 Job，不冒充人工退出整个 Codex 的测试。

- 数据库冷启动：`Database` 请求先进入不可继承句柄的私有 `KILL_ON_JOB_CLOSE` Job，创建长期 Windows 宿主后完成 PostgreSQL 身份及认证检查。关闭最后一个 Job 句柄时，同组负对照退出；宿主 PID48148、PostgreSQL PID30516 在该特定 Job 外，同一 PID/创建时间继续存活，并在新执行调用中完成认证查询。
- 保全正式库：备份 `.data/backups/corescope-before-runtime-host-fix-20261013.dump` 为 138,109,946 字节，`pg_restore --list` 通过。备份 SHA-256 为 `e9587a1a75ff3089011f52b11ebba7bc86bbb1596ca2b16ae24fd12d5d1a80c9`。只读身份查询确认独立 `corescope` 库、5448 端口、616 个来源、20,131 条材料；数据没有重置。
- 数据库维护模式转整套启动：两个宿主、PostgreSQL、supervisor、API、web、worker、bridge 共 8 个真实进程均在启动请求 Job 外，关闭该 Job 后全部保持同一 PID/创建时间，跨新执行调用的数据库认证与双 HTTP 健康通过，四角色 ready、重启数 0。
- 正常停止：原控制管道完成应用收尾，`pg_ctl` 正常停止数据库，两个宿主与任务实例自然结束，5448/8780/8781 都不再监听。V2 的 8775 服务保留。
- 标准一键冷启动：从项目外 `C:\Users\30424\Documents` 运行真正的 `Start-CoreScope.cmd`，10:29:10 到达完整 READY。本次只有 `System` 宿主同时持有数据库及四角色，7 个进程均在私有请求 Job 外；关闭 Job 后同一 PID/创建时间持续存活。系统宿主 PID51188、PG39356、supervisor47860、API29004、web3192、worker12028、bridge36996。
- 重复启动：10:30:19 再次 READY，宿主 nonce/实例与上述全部 PID 未变。冷启动后的全站 35 项 smoke 通过，包含主页、资料、热点、日报、主题、资源目录、管理员入口、RSS、公开 API、图标与 MCP。
- 边界检查：CoreScope 私有 `.env` SHA-256 未变；受检 V2 `app.py` 未变，8775 仍由 PID35868 持有，创建时间仍为 2026-10-11 03:16:07.352679。此次修改和测试均位于独立 CoreScope，未执行 V2 更新、迁移、停止或重启。

类型检查、网页生产构建和网页 32/32 通过。最终独立空 `corescope_test` 的完整后端回归在 Node 24.20.0 下 **655/655、0 skip** 通过（193,832.827 毫秒，`.data/qa/runtime-host-backend-node24.20.log`）；所有测试关闭外部采集/推送，模型仅接本机 stub，正式库不运行隔离测试。第一轮有一项旧评估测试的 Node 子进程以 Windows 原生 `0xC0000409` 退出，无 stdout/stderr；该文件单独 3/3 重跑通过，第二轮该项也通过。第二轮捕获新 Job 测试的非原子心跳文件瞬时读取失败，已针对测试读取竞争修正；没有将这些失败掩盖成通过，也没有修改评估业务逻辑。

旧 Node 24.14.0 后续完整回归还出现不同既有测试文件进程退出；X 分片文件单独 4/4 通过，TAP 诊断确认媒体测试文件的退出码同为 `0xC0000409`。未发现对应的新内存不足事件，不能归因为 OOM。媒体文件在单独空库中还依赖前置队列建立，单独执行的缺队列结果不用于代表完整套件的业务结果。

[Node 24.20.0 官方发布记录](https://nodejs.org/en/blog/release/v24.20.0)包含 [Windows libuv shutdown assertion 修复](https://github.com/nodejs/node/pull/61999)。本机另下载官方 ARM64 `node.exe`，在 `.data/runtime/node-ab-v24.20.0/` 核验签名和官方 SHA-256（`92949e7764e56e305cb84ea3d575912e822c79e85599362e8d408b04b9ffd326`），仅以这个独立执行文件运行同一 `corescope-test.ts`。测试子环境前置其 PATH，使各测试子进程版本一致；全局 Node、V2、生产任务定义和现服务均未替换。此对照与上游已知缺陷有关，没有 native stack，不能宣称已唯一证明旧版退出的根因。

原始日志与私有 Job 收据在本机 `.data/qa/runtime-host-*`，包含标准冷启、正常停止、重复启动、各轮回归及边界检查；密钥、数据库、这些本机日志和备份均不提交 Git。
