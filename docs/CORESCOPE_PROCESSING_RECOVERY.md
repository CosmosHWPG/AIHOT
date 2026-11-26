# 固定材料补处理与模型输出修复

用于用户明确批准的有限补处理，日常最近48小时、最新2000条策略继续启用。批次许可只扩大处理范围，不赋予公开、精选、事件或热度资格，不改变来源参与方式、历史标记、供应商或预算。

## 本次范围

2026-10-15批准的两个清单分别是115条既有Bird X待处理材料，以及3条已终止的编辑材料模型处理失败。3条失败中Data Center Dynamics和AWS来自RSS，Techzine来自CoreScope的external来源；修复只处理CoreScope已存材料，不写入、启停或重新配置V2。

原始清单、数据库备份和真实运行证据仅保存在本机`.data/qa/recovery115/`及`.data/backups/`，不提交数据库、密钥、Cookie或原始模型回复。

## 机制

- 许可固定材料ID、初始revision、主来源和参与方式，以摘要绑定清单。同一批次不能扩容；撤销或完成后不能重新激活。
- 新旧任务共用入队和消费门控。仅允许突破时间或2000条数量限制；未知/未来发布时间、禁用或隔离来源、来源/类型/参与方式及非正式revision漂移仍拒绝。
- 正式正文提取会生成下一revision，其事务原子记录同一成员的许可推进和审计，不允许其他写入借此扩大许可。
- 原Windows托管worker处理任务，批次优先级低于正常近期新闻。安全网恢复遗漏的任务；不注册第二个worker或采集器。
- 继续使用原回执、逻辑身份、真实重试和额度。容量等待不会清除失败次数；pending/unknown回执不会因为补处理而重发。
- 完成判据包含材料处理、必要的事件关联、关联摘要、队列、容量延期及未知回执。存在未结算项目时拒绝标记批次完成。

## 本机操作

先把经过用户授权的固定材料快照放在私有数据目录。`plan`只读数据库并输出清单；审批式动作通过显式CLI命令完成，均写入审计。不要以临时关闭全局近期规则代替固定许可。

```powershell
node --env-file=.env scripts/corescope-processing-recovery.ts plan --input=.data/qa/recovery115/approved-manifest.json --kind=bird-pending --id=bird-pending-20261015 --out=.data/qa/recovery115/bird-plan.json
node --env-file=.env scripts/corescope-processing-recovery.ts plan --input=.data/qa/recovery115/approved-manifest.json --kind=model-failure --id=model-repair-20261015 --out=.data/qa/recovery115/repair-plan.json

node --env-file=.env scripts/corescope-processing-recovery.ts apply --plan=.data/qa/recovery115/bird-plan.json --reason="User authorized fixed115 X backlog recovery"
node --env-file=.env scripts/corescope-processing-recovery.ts apply --plan=.data/qa/recovery115/repair-plan.json --reason="User authorized three fixed model output repairs"
node --env-file=.env scripts/corescope-processing-recovery.ts retry-failed --id=model-repair-20261015 --ids=t3m1uepxzeyhnmm51ecegkl1s,ntcbdxez3ir2ycphfws6y5n3l,tv712uwgx2kbmly6cz5aw67s5 --reason="Deploy validated output fixes and resume original receipt identities"

node --env-file=.env scripts/corescope-processing-recovery.ts status --id=bird-pending-20261015
node --env-file=.env scripts/corescope-processing-recovery.ts status --id=model-repair-20261015

# 仅在status确认所有必要步骤结算后完成许可。
node --env-file=.env scripts/corescope-processing-recovery.ts complete --id=bird-pending-20261015 --reason="Verified finite recovery settlement"
# 若需停止后续任务接纳，用revoke；不会把在途请求或延期伪装成已完成。
node --env-file=.env scripts/corescope-processing-recovery.ts revoke --id=bird-pending-20261015 --reason="Operator stopped fixed recovery"
```

失败恢复仅适用于清单内3条已失败材料，并且每条只登记一次恢复。原文章重试状态写入审计后重置，历史模型回执和计数保留；不使用新的任意`attemptTag`使成功阶段重新付费。

## 模型和Bird修复的证据边界

两条旧评分失败的最近一次回答将1024输出tokens全部用于推理，未产生可解析评分。仅对本机使用的`default` / `deepseek/deepseek-v4.1-flash`评分增加有界输出空间；精确匹配旧请求全部身份且通过原schema的成功评分仍复用。增加输出长度不能保证供应商一定返回可用内容，须以新的真实回执、材料状态和公开结果验收。

Techzine的旧理解回答缺少必填`itemType`。理解提示从行业包生成允许选项，要求必填六字段和单个合法字符串；schema保持严格，不把缺失或未知类型映射成默认合法值。其已成功评分可以继续复用。

Bird的Windows当前用户凭据读取使用有上界的本机重试和固定错误类别。实际CLI调用不因此重试；退出码、信号和真实HTTP数字与目标不可用关键词分开，不再把关键词映射成未经观测的404。四个失败作者须逐个通过真实抓取回执复核，额度等待不算失败，旧成功也不代替最新恢复。身份确实失效时应更新现有凭据并走原auth，不更换账号。

2026-10-15用户指出Bird日120次是此前agent自行设置的试点保护值，并非Bird/X官方限额或用户亲自配置。按本次纠正，独立CoreScope已通过正式审计开关关闭Bird和同类embedding的内部次数拦截；LLM原本已关闭。目前三项`enabled=false`，保留原分钟/小时/日数字供以后显式开启，不清计数，所有真实请求、回执、用量和费用继续记录。上游限流、账号冷却、身份/profile互斥、pending/unknown防重发和发布门槛不变。配置位于独立数据库`budgets`表，可通过后台设置或`scripts/corescope-budgets.ts`调整；它不是BirdClaw配置。

旧容量延期须依据当前预算开关处理，不能继续以保留数字或旧重试时间宣称必须等到下午。只对明确本机次数等待、相应服务现已关闭次数拦截、无在途/未知回执或重复任务的固定批次，审计交回原worker；真实失败次数、事件延期余量和已存回执不变。因未知回执或远端不可用仍有等待/失败时，不宣称全批完成。

## 本次真实验收结果

2026-10-15 12:02两个固定许可均正式完成：X115/115必要处理链路结算，其中43条正常公开、4条自然精选、13条按领域规则过滤、59条完成原热度信号角色；3条模型修复自然公开且事件/摘要结算。固定118无失败、未知回执、活跃任务或容量延期，46条公开API/HTML原文证明全部通过，未降低发布门槛。后端784/784、web40/40、类型检查/构建及smoke35/35通过；额外两处官方入口seed校正经636+118配置和来源升级/管理员18/18验证。

四源复核中claudeai、fal、GeneralistAI原入口恢复；原SpaceXAI地址仍不可用，按官网当前SpaceXSI入口正式审计校正后抓取并入库1条、正常显示于热点。保留旧ID、参与/分级策略、原manifest及旧失败；不宣称已证明旧、新数值X账号连续。两处当前seed只改name/query，旧观察映射不回写。持续采集的新材料不并入本次固定115，也不把链路抽样通过当完整历史覆盖。最新逐条证据在本机`.data/qa/recovery115/latest.md`、`items.csv`及`latest.json`；外部服务PID变化等边界记录见[全来源验收](CORESCOPE_BIRD_FLEET_ACCEPTANCE.md)。
