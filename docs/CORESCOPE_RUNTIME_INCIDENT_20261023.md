# CoreScope 2026-10-23 后台停止取证与修复

## 结论与证据边界

今天约14:34的数据库关闭，高可信地归因于 **CoreScope自己的Windows宿主将一次WMI内存不足探测错误误判为数据库进程退出，继而执行了自有资源清理**。这个判断由Windows事件、PostgreSQL日志、同一个宿主nonce的日志及故障时版本的代码共同支撑；并非只因为数据库出现了`received fast shutdown request`。

直接证据是：14:33:55，CoreScope宿主PID492查询PostgreSQL PID43056时，WMI返回`0x80041006`。该码是微软定义的`WBEM_E_OUT_OF_MEMORY`，表示操作内存不足，**不表示进程不存在**。旧实现把未取到CIM进程对象统一返回`false`，Hosted循环随即进入异常清理；之后先有supervisor停止回执，再有PostgreSQL fast shutdown，最后才写出“数据库意外退出”的错误日志。

操作系统没有提供可用的`pg_ctl`进程创建及父PID历史：Security日志当前无权读取，TaskScheduler历史原本关闭。因此，下文明确区分“直接记录”和“按代码及连续日志还原的发起链”，不将后者写成已取得完整OS父子链，也不归因于外部Codex会话或其他线程。

取证窗口为 **2026-10-23 14:25–14:40，Asia/Shanghai**。Windows、数据库和V2在取证阶段均保持只读；未开启系统审计、修改内存设置、结束未知进程或操作V2服务。

## 闭环时间线

故障时代码基线为提交`baf3dbc9ba3909dba83933b0c2e4a3e56a98db42`。下表所有时间均为北京时间。

| 时间 | 来源与标识 | 直接记录及含义 |
|---|---|---|
| 10月20日19:46:06.020 | `postgres.log`，PID43056 | PostgreSQL17.11 postmaster启动。 |
| 10月20日19:46:06.106 | `postgres.log`，PID43056 | 数据库已可接受连接；确认43056是本次独立数据库的postmaster。 |
| 10月20日19:46:15.8137428 | `host-system.log`，hostNonce `8bc3146eaea344f1a464b7413944e4eb` | Hosted/System进入`host-running`，持有已验证进程生命周期。 |
| 10月23日14:33:55.2068501 | WMI-Activity/Operational，Event5858，Record318403 | ClientProcessId=492；查询`Win32_Process WHERE ProcessId = 43056`返回`0x80041006`。这是探测失败。 |
| 14:33:57.8104211 | 同一hostNonce，Hosted/host-running | 输出`{"stopped":true}`，与本地supervisor停止回执格式一致。 |
| 14:33:59.879 | `postgres.log`，PID43056 | `received fast shutdown request`；被查询的同一postmaster此时仍能接收关闭请求。 |
| 14:33:59.880 | `postgres.log`，PID43056 | `aborting any active transactions`。 |
| 14:34:00.256 | `postgres.log`，PID43056 | `database system is shut down`。 |
| 14:34:00.3519133 | 同一hostNonce，Hosted/host-running | 记录`Owned PostgreSQL exited unexpectedly; inspect postgres.log.`。旧代码在异常清理完成之后才写此错误，不能将这条消息的时间当作最初发现数据库消失的时间。 |
| 14:34:00.4507829 | Windows PowerShell，Event403，Record7832160 | PID492引擎从Available转为Stopped；HostApplication安全投影确认`Action Hosted / HostMode System`，并非显式`Action Stop`入口。 |

固定WMI操作字符串为：

```text
Start IWbemServices::ExecQuery - root\cimv2 : SELECT * FROM Win32_Process WHERE ProcessId = 43056
```

错误码依据：[Microsoft WMI Error Constants](https://learn.microsoft.com/en-us/windows/win32/wmisdk/wmi-error-constants)。

## 为什么会由探测失败发展成关闭

以下行号属于上述故障代码基线，修复后行号可能变化：

1. `scripts/corescope-runtime.ps1:401–411`的`Test-OwnedProcess`使用`Get-CimInstance ... -ErrorAction SilentlyContinue`查询进程；查询报错和进程确实不存在都会落到“没有对象”，返回`false`。
2. 同文件`838–847`的Hosted循环将PostgreSQL探测`false`直接解释成意外退出并抛异常，未区分`unknown`、`absent`和身份不符。
3. 顶层`catch`在`952–966`先保存失败状态，执行`Stop-HostedOwnedResources`，最后才写错误日志。因此，“Owned PostgreSQL exited unexpectedly”是旧监控的判断文字，并非数据库自行崩溃的证据。
4. `Stop-HostedOwnedResources`在`875–889`按宿主所有权限定清理范围：先调用Node runtime的`stop`动作，再经`pg_ctl stop ... -m fast`关闭由此宿主创建的PostgreSQL。
5. `scripts/corescope-runtime.ts:132–163`的本地已认证停止处理先排空自有应用子进程，再返回`stopped=true`；现场14:33:57的回执与此路径吻合。

据此还原的发起路径为：

```text
CoreScope Hosted/System PID492
  → WMI查询自有PostgreSQL PID43056时内存不足
  → 旧布尔存活检查把查询错误当作进程缺失
  → Hosted异常清理
  → Node runtime stop，排空自有应用
  → pg_ctl fast stop，关闭自有PostgreSQL
```

这是高可信代码与日志重建。没有可用4688记录来直接给出`pg_ctl`当时的PID、父PID及创建事件，因此不宣称取得了完整OS进程亲子链。

## 内存压力是已记录条件，责任来源尚未确认

System日志`Microsoft-Windows-Resource-Exhaustion-Detector`的 **Event2004 / Record840150** 报告：

| 字段 | 值 |
|---|---:|
| SystemCommitLimit | 60,737,474,560字节 |
| SystemCommitCharge | 60,656,492,544字节 |
| 剩余提交额度 | 80,982,016字节，约77.2MiB |
| 物理内存 | 33,893,933,056字节 |
| 物理内存使用 | 30,001,209,344字节 |
| 进程数量 | 666 |

该事件列出的前三个进程为ChatGPT.exe PID7272（2,658,045,952字节提交）、chrome.exe PID27732（2,387,349,504字节）、explorer.exe PID8800（1,904,054,272字节）。这是有限的高占用列表，**不能据此认定其中某一个程序或CoreScope导致整机内存耗尽**。CoreScope不在这三个名字中，也不能据此推算它当时的内存用量。

2004的`TimeCreated`为 **14:33:48.7232446**，内嵌`ExhaustionEventInfo.Time`为 **14:34:10.3511972**，两者有偏差，均保留，不用它建立精确先后关系。与本次故障直接对应的是WMI5858：PID492在14:33:55查询43056时明确返回内存不足。

Application日志随后还有 **Event1000 / Record109034，14:34:10.4861316** 的chrome.exe异常（故障PID2540，`0xe0000008`）。这只是同窗口应用异常，不能证明Chrome发起CoreScope关闭。

## 后台为何未自行恢复

修复前读取到的现有CoreScope任务配置如下；它们属于本项目独立任务，未读取或修改V2任务配置。

| 项目 | System任务 | Database任务 |
|---|---|---|
| 任务名 | `CoreScope-90cc74b97bc14d990da7-System` | `CoreScope-90cc74b97bc14d990da7-Database` |
| RestartOnFailureCount | 0 | 0 |
| TriggerCount | 0 | 0 |
| ExecutionTimeLimit | PT0S | PT0S |
| LogonType | InteractiveToken | InteractiveToken |
| 取证时状态 | Running，17:01:51已恢复启动 | Ready |

任务没有失败重启，也没有登录等自动触发，故宿主退出后无法由任务定义自动恢复。`PT0S`表示没有设置任务运行时长上限；本次不是由已配置的时长上限直接解释。System任务的`StopIfGoingOnBatteries`及`DisallowStartIfOnBatteries`均为false。

## 日志覆盖与不能证明的事项

- Security4688/4689及auditpol查询因当前权限不足不可读；本次未提权、未改变全局审计策略。
- TaskScheduler Operational在取证前已关闭，无法回溯当时任务终止历史。
- PowerShell Operational开启，但14:25–14:40只有39条40961/40962/53504事件，没有4103/4104。该日志最老可用记录为当天13:51:50，Windows PowerShell最老记录为05:51:28，10月20日PID492的启动历史已不在现存滚动日志中。
- 同窗口WMI5858只有上述一条。TerminalServices LocalSessionManager、UserProfile及RestartManager未读到该窗口事件；这不等于已经排除所有人为或会话操作。
- 已有取证没有证明外部Codex、其他会话或特定用户执行了本次停止。缺失或不可访问的日志也不等于某动作绝对没有发生。
- 安全字段投影保存在本机忽略目录`.data/qa/runtime-recovery-20261023/windows-forensics-safe.json`。该文件不包含完整命令、环境、密钥、数据库URL或私密事件原文，不随Git提交。

## 修复与验证

### 实现

- 长期监控改为原生进程探测，核验PID、创建时间及执行文件，将`alive`、`exited`、`unknown`、`mismatch`分别处理。unknown及身份不符保留运行资源并重新检查，不能进入破坏性清理。启动/接管阶段仍保留完整命令、SID、任务定义及实例归属校验。
- 确认PG或supervisor退出后才进入恢复，先排空应用，按5/15/45秒退避；同一运行代次10分钟最多三次，次数跨宿主重试持久化，冷却后再尝试。恢复沿用现有数据库、来源、模型预算和正常队列，不重置处理状态。
- 两个任务均设一分钟间隔、最多三次失败重试；System另设当前SID登录后30秒触发。保持InteractiveToken、普通权限、无密码保存、无运行时长上限。无人登录时不承诺后台运行；重新登录后按持久意图恢复。
- 新增`desired-state.json`，Start保存running，Stop为两个模式保存stopped。任务重试/登录不会复活已停止系统；新代次不能被旧READY回执冒充，创建替代进程必须正向读到当前running代次。
- 新宿主先完整验证旧资源，再发布接管回执；验证失败不覆盖旧回执，防止临时查询错误丢失仍存活进程的身份。未知进程和占用端口不被结束。
- 应用子进程在supervisor的IPC断连时自行优雅排空；Windows子进程单独创建且保留IPC，不因父进程消失而先被连带强制结束。单个角色五分钟内第六次退出时，supervisor排空其余角色并非零退出，让外层恢复完整应用。
- 关闭前写入`lifecycle-control.jsonl`，记录原因、PID、父PID、关联ID和目标；保留原始异常在清理之前的时间。Node消息声明的调用者明确标注`declared_unverified`。不记录密钥、控制令牌或完整环境。

### 现场部署与恢复试验

本次部署在17:57正常排空旧应用、关闭独立PG后升级；17:57:59完整系统达到READY。这次关闭是本次维护操作，有`explicit_stop`审计，与14:34事故分开记录。

17:59:20.299，通过已认证内部控制接口让supervisor PID31536正常排空并退出，原因记为`recovery`，保留System的running意图和PG运行。宿主PID8596在17:59:21.435识别到supervisor确实退出，进入5秒退避；17:59:36.524自动拉起supervisor PID46896及API/web/worker/只读桥，数据库健康检查通过，重新READY。从请求排空到恢复约16.2秒。

该试验期间宿主PID8596与PG PID48124不变。此处验收的是**实际应用监督进程退出后的自动恢复**；未在正式库注入PG崩溃、整机OOM或Windows注销，不能把隔离模拟写成这些场景已经在正式库实测。

现场任务配置读回：System为Running、RestartCount=3、RestartInterval=PT1M、TriggerCount=1；Database为Ready、RestartCount=3、RestartInterval=PT1M、TriggerCount=0，两者ExecutionTimeLimit=PT0S。当前System/Database持久意图分别为running/stopped。

### 验证记录

- 新增PowerShell宿主隔离测试8项：WMI故障不误停、身份错配/unknown、停止持久化与新代次、离线Stop、真实临时任务定义升级及篡改拒绝、跨进程恢复窗口、停止期间禁止恢复、完整验证后接管。均通过；临时任务已删除。
- 新增Node故障恢复隔离测试11项：真实监听端口、真实supervisor被终止后的子进程排空、六次角色失败后的整体排空、三类关闭审计及关联ID、非法控制令牌拒绝、审计不可写时仍完成已认证停止等。均通过。
- TypeScript全项目检查通过；前端生产构建及40项测试通过；本机站点smoke通过。
- 后端全量测试初轮809/810：唯一失败为旧日志测试将JSONL按单JSON对象解析。修复测试逐行校验后，该文件3/3通过。
- 第二轮全量809/810，日志与新增恢复测试均通过；唯一报告的失败是既有detach测试删除临时目录时Windows返回`EBUSY`。在确认目标为该测试的独立临时目录后，对EBUSY/EPERM加入最多3秒的有界重试，其余错误保留；该文件7/7针对复测及tests类型检查通过。没有修改生产逻辑来绕过断言，也没有第三次重跑整套后端测试；不能将第二轮原始日志写成810/810。

来源配置前后均为717项、701启用；身份/配置/启用状态指纹为`c05305ee4f37b9326b599b03e592075f`。LLM及embedding预算开关和既有数值保留。取证和维护命令只针对独立CoreScope；未运行V2停止/重启/写入命令，V2桥仍按原有只读路径读取。正式库的自然采集会继续推进内容、游标和任务时间，不把它们的正常变化误判为配置修改。

18:05:30最终快照确认supervisor及四个应用角色仍为同一组PID，ready=true、stopping=false，角色重启次数均为0；宿主PID8596、PG PID48124保持。恢复后的`sources.schedule`在18:01:34、18:01:56、18:02:33连续成功，18:05:29又完成一轮；`content.priority`、`hot.rank`和`content.sweep`亦有成功记录。V2只读桥状态推进到18:03:42，last_error_at=null。API与网页数据库健康均为true，恢复后再次通过35项站点smoke。

V2的8775端口在本次部署前后均由PID37600监听，未对它执行停止、重启或写入。来源指纹与两项模型预算配置的前后比较一致。未释放租约、补发任务或改写队列来制造运行结果。

本机验证日志在忽略目录`.data/qa/runtime-recovery-20261023/`，不随代码提交。上述约6分钟的现场恢复后观察不等于永久可用保证；整机OOM、磁盘故障、无人登录和Windows关机仍有各自运行边界。
