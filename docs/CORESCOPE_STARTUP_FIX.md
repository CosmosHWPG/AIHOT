# 2026-10-03 一键启动失败修复

本机 `postgres.log` 在北京时间 21:44:15 记录 `out of memory`，失败发生于模型目录 seed 的 `lb_models INSERT`。数据库已经启动，但启动流程尚未到达 API/web/worker/bridge，因此网页 8780 不可访问。只看到 PostgreSQL ready 不代表整个系统 ready。

原启动流程每次都执行幂等 seed；模型目录虽然使用 `ON CONFLICT DO NOTHING`，仍把已存在的 2184 个模型与 7035 个别名重新送入数据库。模型单批 500 行产生 4000 个绑定参数，别名单批 1000 行。冲突不写新行，也仍需要解析、绑定与检查。此错误说明数据库当时无法分配内存；不能推断 500 行在所有机器上都必然造成内存不足。

修复内容：

- 先读取已存在的模型 slug 与别名身份，仅提交缺失的条目。正常重启已完成的目录不再尝试重复 INSERT；新增版本仍补充新条目。
- 新模型分成每批 100 行、别名每批 200 行，降低首次及增量导入的单次数据库开销。
- 保留后台人工改过的模型名称与别名目标，不因重启恢复模板值。
- 启动器显示阶段进度，失败阶段与原因保存在 `.data/logs/startup.error.log`，并保留原有数据库和组件日志。

回归测试使用独立测试库的 BEFORE INSERT trigger：目录第二次导入时只要尝试重复写，即使最终 `ON CONFLICT DO NOTHING`，测试也会失败。同时验证跨批次初始导入、新条目补充与后台编辑保留。

继续使用项目根目录的 `Start-CoreScope.cmd`。只有启动器显示 `CoreScope is ready` 且 API、web、worker 和 bridge 身份/健康检查通过，才能认为整个系统已经启动。

运行状态与故障查看：

```powershell
npm run corescope:status
Get-Content .data/logs/startup.error.log -Tail 30
```

如果仍遇到内存不足，保留该错误日志和 `.data/logs/postgres.log`，检查当时机器可提交内存余量；无需删除数据库或重新填写模型密钥。

本机验收（北京时间 2026-10-03）：

- 更新后完整空测试库后端最终 583/583 通过；网页 32/32、全仓类型检查与生产构建通过。
- 新增 2 项真实数据库目录回归和 2 项真实 Windows 启动失败日志回归；另行复查相关旧用例，共 26/26 通过。
- 前两次完整测试各有一次不同的旧测试进程异常退出：第一次为 analysis shutdown 子进程的 Windows 原生 `0xC0000409`，第二次为 publication 测试文件进程。没有把该退出码当作数据库 OOM 的证据，也没有修改这些业务代码；单独重跑及最后一次完整测试均通过。原始测试记录保留于本机 `.data/qa/startup-backend-full.log`、`startup-backend-rerun.log` 和 `startup-backend-final.log`。
- 修复执行前保存独立正式库备份 `.data/backups/corescope-before-startup-fix-20261003.dump`，验证备份目录可读取；原数据库、配置与密钥保留。
- 完全停止 CoreScope 后，从项目外目录执行真正的 `Start-CoreScope.cmd`：23:01:26 开始，23:01:33 到达 `[READY]`。实际 seed 显示 0 个新增模型、0 个新增别名。
- API、web、worker、V2 只读 bridge 均 `ready=true`、重启数 0；再次启动复用这些进程，全站 33 项 smoke 通过，浏览器已实际打开精选页。

本次仅修复独立 CoreScope 的目录同步与启动诊断，不更改 V2 服务、V2 数据库、模型服务配置或行业评分规则。
