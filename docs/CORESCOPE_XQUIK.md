# CoreScope Xquik 只读采集

新增 X 账号使用 `x_search`、`config.provider="xquik"`；原有未指定 provider 的来源继续使用 SocialData。只实现 Xquik 官方 SDK 0.8.0 对应的 REST 读取契约：`GET /account`、`GET /x/tweets/search`、`GET /x/articles/{tweetId}`。不导入 V2 或独立 Python 组件，不创建 monitor、webhook 或 X 写操作。

本机私有 `.env` 配置 `X_TWITTER_SCRAPER_API_KEY`，可选 `XQUIK_BASE_URL`；不得提交密钥。需执行增量迁移 `0043_xquik_credit_budget.sql`，并在 `COLLECT_KINDS` 中包含 `x_search`。2026-10-12本机已完成迁移、认证和有预算的三账号批次采集（5条），[正式验收](CORESCOPE_ONLINE_EXPANSION.md)明确区分材料返回与其余账号的持续调度。适配器回归测试使用本机HTTP stub和`corescope_test`。

## 请求与 credit 边界

- 迁移保留既有预算，首次默认 Xquik 每分钟 2、每小时 20、滚动 24 小时 120 个请求。预算行缺失即停止，任何一项为零亦停止。
- 默认 `XQUIK_PAGE_LIMIT=5`、`XQUIK_MAX_PAGES=2`、`XQUIK_INITIAL_LOOKBACK_DAYS=7`、`XQUIK_DAILY_CREDIT_LIMIT=250`、`XQUIK_CREDIT_RESERVE=100`。值必须是合法整数，范围严格验证。
- 每次新的付费尝试，在 provider advisory lock 内检查请求预算、滚动 24 小时 credit 预留和免费 `/account` 的余额。搜索按 `limit` 预留，Article 按 5 credit 预留；并发未完成及 unknown 尝试占用余额保留。
- `receipt_attempts.reserved_credits` 记录保守上界；收到响应后按返回对象数记录估计 usage/cost，单位 `CREDITS`，不伪称实际账单金额。每日上界会保留失败与 unknown 尝试的预留，因此比实际花费严格。
- 保存的收到／完成回执无需再次付费，亦不会再次请求 `/account`。网络结果未知不自动重发；继续沿用回执恢复和管理员处理规则。

## 持续采集与去重

新账号三项一批启动，首轮限一页、仅最近配置的天数。只给实际返回的作者设置其真实 tweet ID 水位和初始化标记；未出现作者仍未初始化。它们按来源 interval 继续检查，不能把一次批次成功描述为全部账号已抓到材料。

初始化后的分片按 provider 与参与模式隔离，材料始终分配给真实 `author.username` 对应的来源。每篇身份为 `x:<tweetId>`，同一推文跨来源或重试不会重复入库。完整 Note Tweet、可验证引用、互动数字、原始时间和媒体预览保留；不以抓取时间替代发布时间。

空过滤页有 `next_cursor` 时继续翻页；后续页失败先保留已经收到的材料和未读 cursor，下一轮续读。有限页数、backlog 上限和循环游标检测防止无限读取。首次历史材料走 `first-import`，不冒充今日新闻。

X Article 以包装推文的 ID 请求对应 provider，Xquik 材料不会误走 SocialData。原文正文按现有内容修订和提取流程进入分析；无法确认的正文保留 `unconfirmed`。

官方契约来源：[Xquik 官方 Python SDK](https://github.com/Xquik-dev/x-twitter-scraper-python)。本机契约审计使用已安装的 0.8.0；上游变化需重新验证，不暗示所有未来版本永久兼容。
