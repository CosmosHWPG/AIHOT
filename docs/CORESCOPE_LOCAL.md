# CoreScope 本机完整系统

CoreScope 使用独立 PostgreSQL、API、网页、worker 和 V2 只读桥。它保留 AIHOT 的事件、热点、精选、主题、日报、管理后台、RSS、公开 API 和 MCP；网页通过 HTTP 读取 API，用户浏览网页不调用模型。它不是静态预览。

## Windows 一键运行

需要 Node.js 24.11 或更新版本。本机运行不需要 Docker，也不安装 Windows 数据库服务。

1. 在项目根目录准备私有 `.env`。当前交付已按授权复用 V2 模型服务配置，管理员密码和各个签名密钥另行随机生成；所有秘密仅在本机文件内，未提交 Git。
2. 双击 `Start-CoreScope.cmd`。
3. 浏览器打开 **http://localhost:8780**，管理员入口 **http://localhost:8780/admin**。登录密码取自本机 `.env` 的 `ADMIN_PASSWORD`。
4. 双击 `Stop-CoreScope.cmd` 停止独立系统。数据保留，下一次启动接续处理。

第一次启动会从 [EDB 官方 PostgreSQL 二进制分发](https://www.enterprisedb.com/download-postgresql-binaries) 下载固定版本 PostgreSQL 17.11 x64 ZIP 到 `.data/runtime/`，只解压运行文件，不注册全机服务。在 Windows ARM64 上通过系统 x64 仿真运行。下载地址、文件大小和本次实际 SHA-256 保存在 `.data/runtime/postgres-download.json`；该 SHA-256 是本机下载记录，不冒充官方独立校验值。

启动器初始化数据库、运行增量迁移、幂等导入主题和新增信源、按需安装依赖与构建前端，然后隐藏启动各个进程并检查真实数据库健康。重复启动会复用已经确认归属的进程。若端口被其他进程占用，会报错并保留该进程，不按端口强行停止。

启动窗口依次显示配置检查、数据库认证、迁移、种子同步、预算检查、网页构建和应用健康检查的进度。只有最后出现 `[READY] CoreScope is ready` 或 `[READY] CoreScope is already running` 才表示完整系统可用；中途的 PostgreSQL ready 只表示数据库准备完成。

后台监督进程与 PostgreSQL 启动控制使用独立隐藏进程，输入输出直接连接日志文件，不依赖启动窗口的控制台或管道。完整 `[READY]` 出现后可以关闭启动窗口；需要停止系统时运行 `Stop-CoreScope.cmd`，让正在处理的请求和数据库正常收尾。启动准备阶段关闭窗口可能中断后续准备，下一次启动会核验并复用本项目仍在运行的组件。

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
```

所有进程都使用真实管理员鉴权，禁止设置 `DEV_AUTH_ROLE`。数据库只监听本机地址。飞书推送、飞书告警和 IndexNow 默认关闭；这些外部出口不属于本机交付。

`COLLECT_ENABLED` 和 `MODEL_CALLS_ENABLED` 是真实安全阀：设为 `false` 仍可浏览、管理和查看已发布资料，但停止相应的直接采集或模型调用。开启后由 worker 的模型回执和预算熔断控制开销；V2 桥只读原系统，不在原系统写入或重启服务。更改 `.env` 后先停止再启动，保证所有进程加载同一份配置。

更新代码或行业配置时也先停止，完成 `git pull` 或本机修改后再启动。启动器会应用尚未执行的增量迁移并按需重建网页；直接重复点击启动只验证并复用现有进程，不会在处理模型请求期间替换代码。

桥入口：

```powershell
node --env-file=.env scripts/corescope-v2-bridge.ts --watch
```

启动器已经包含这个桥进程，请勿在正常运行期间另起重复 watch。单次导入和历史补齐参数以桥脚本的帮助输出及 V2 接入文档为准。

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
