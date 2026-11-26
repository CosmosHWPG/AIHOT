# CoreScope 信息源补齐与验收（2026-10-12）

在用户指定的 `565aa6be722b93fe819c2098a81bfc5b22c4b850` 上追加191个来源，保留原425个canonical ID。现在共616个来源、600个启用：245 RSS、40网页列表、20 JSON、114 X、61公众号、136外部来源（其中120启用、16关闭）。原14个暂停和2个关闭路线均未复活。

公开核查对象来自 AIHOT 网站的部分公开来源样本和原文链接，不能据此宣称复制了在线878个私有配置。原开源仓18个RSS已经由原系统融合，本次复用现有ID。9个身份仍未确定的观察目标及123个仅有名称的样本没有猜测添加。

## 差异与重复

|项目|决定|
|---|---|
|72个公开入口|新增42 RSS、25网页、5 JSON，全部正式collector入库成功|
|109个精确X账号|新增Xquik路线；按预算逐批采集|
|10个公众号入口|1个精确账号缓存，9个Dajiala url-selector，全部实测通过|
|6个已有X账号|保留原V2 ID；5个转原生Xquik，Zai原暂停保留|
|HF社区、Meta Newsroom、NVIDIA技术博客|复用45、133、33；不添加第二个collector|
|原24个历史别名|维持已融合canonical ID，不重新添加|
|5个AIHOT自站回路|9285、9614、9615、9616、9617继续排除|

已有X复用列表：

|账号|原ID|
|---|---|
|emollick|v2-source-186|
|karpathy|v2-source-3725|
|sama|v2-source-191|
|OpenAI|v2-source-190|
|GeminiApp|v2-source-188|
|Zai_org|v2-source-193|

待核查身份（本次不添加）：

- Amjad Masad：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- Google Cloud：Databases：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- Jack Clark：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- Ethan Mollick：One Useful Thing：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- 钛媒体·AGI：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- SemiAnalysis：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- 甲子光年：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- AI at Meta：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.
- 通义 QwenAudio：原创语音项目：Only a display name/channel was observed. No exact X handle, RSS feed path/query, JSON/listing endpoint, or WeChat biz was established.

初始完整差异、24个历史别名和自站排除依据见 [差异JSON](corescope-online-source-difference.json)。

## 持续采集和付费边界

补充目录分别在 `industry/corescope-online-supplement.json`、`corescope-online-x-supplement.json`、`corescope-online-mp-supplement.json`。V2导出器每次刷新都会合并这三个目录；已验证同feed（保留路径/查询/过滤范围）、同X handle、同公众号biz复用旧ID。不同发布者或同发布者的不同有效渠道保留独立来源，并用signal group避免独立热度重复计数。账户名不作为公众号去重证明。

公开入口默认120分钟、X及公众号180分钟，沿用worker定时到期调度、源级游标、错误退避和first-import规则；页面浏览不触发抓取或模型。X原生仅最近7天启动，三账号一批，未返回作者不伪造初始化水位；后续续读保存分页cursor。

本机 `.env` 配置 `X_TWITTER_SCRAPER_API_KEY`、`DAJIALA_KEY`，不提交。X预算2/分钟、20/小时、120/滚动24小时，另预留最多250 credit/24小时与100 credit余额，不提升既有模型预算。Dajiala维持5/分钟、60/小时、500/天，新增公众号每轮正文上限2篇；同biz和10分钟窗口复用历史回执、同篇正文复用付费回执。实际Dajiala余额不足时明确记录失败；用户充值后本次9个API账号全部通过。所有新增来源仍关闭公开全文和全文RSS。

## 实际验收

- 迁移前独立CoreScope数据库备份72,967,009字节，pg_restore目录可读；迁移0043仅追加credit预留字段与X预算。备份和带正文的探测文件只在忽略的`.data/qa/source-expansion-20261012`。
- 72个公开入口全部在正式CoreScope库collect成功，新增140条；X一次三账号搜索返回5条，Anthropic 2、OpenAI Developers 3，GoogleDeepMind该批未返回材料，不能称全部109账号都已产出。
- 10个公众号实测通过；阶跃星辰缓存新增2条为9月20日历史文章，其余9个API账号均成功返回列表并保存近期原文，保留真实公众号身份。
- 本次验收累计新增168条原始材料。包含历史补齐，不等于精选新闻、已完成分析或网站878源覆盖率。模型分析、事件和公开层继续遵循既有准入与预算。
- 正式库保留全部425旧ID，原关闭来源复活数为0；目录重复编译相同616条，source upgrade保留管理员字段与已运行来源的自动间隔漂移。
- 后端空库全套、TypeScript、网页构建/32项、Python23项通过；最终运行smoke和进程状态见下面附加验收。

OpenAI失准reports原站只有事件月份，明确保留发布日期unknown；Gemini与Claude应用按日期段落生成稳定fragment身份；Claude Platform RSS保留原fragment。IT之家可验证入口是全站RSS，按正常AI分析门槛筛选，未声称存在专属AI RSS。Every等来源不保证会员正文；来源解析成功不等于全文质量已确认。

逐源公开解析证据见 [verification JSON](corescope-online-source-verification.json)，运行与请求费用快照见 [runtime JSON](corescope-online-runtime-acceptance.json)，X契约与预算见 [Xquik说明](CORESCOPE_XQUIK.md)。

## 新增公开入口完整列表

|名称|类型|实际入口|
|---|---|---|
|IT之家 · 全站RSS（AI按分析筛选）|rss|https://www.ithome.com/rss/|
|Browser Use|rss|https://browser-use.com/rss.xml|
|MarkTechPost|rss|https://www.marktechpost.com/feed/|
|Cartesia 产品与研究|web_list|https://www.cartesia.ai/blog|
|Sakana AI：Blog|rss|https://sakana.ai/feed.xml|
|Recode China AI|rss|https://www.recodechinaai.com/feed|
|Every：最新文章|web_list|https://every.to/|
|ChinaTalk|rss|https://www.chinatalk.media/feed|
|Azeem Azhar：Exponential View|rss|https://www.exponentialview.co/feed|
|蚂蚁 inclusionAI：GitHub 新仓库|json_list|https://api.github.com/orgs/inclusionAI/repos?sort=created&per_page=30|
|AGIBOT 智元|web_list|https://www.agibot.com.cn/|
|Amp Chronicle|web_list|https://ampcode.com/news|
|Gary Marcus：The Road to AI We Can Trust|rss|https://garymarcus.substack.com/feed|
|OpenAI：失准报告与通报|web_list|https://alignment.openai.com/misalignment-reports/|
|Figma AI / Agent / Make|rss|https://www.figma.com/blog/feed/atom.xml|
|Ai2 / Allen Institute for AI|rss|https://allenai.org/rss.xml|
|Anthropic：Research|web_list|https://www.anthropic.com/research|
|Redwood Research：Blog|rss|https://blog.redwoodresearch.org/feed|
|Nathan Lambert：Interconnects|rss|https://www.interconnects.ai/feed|
|Prime Intellect|web_list|https://www.primeintellect.ai/blog|
|Databricks：Blog|rss|https://www.databricks.com/feed|
|Sierra：Blog|rss|https://sierra.ai/rss.xml|
|Claude：YouTube|rss|https://www.youtube.com/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg|
|Claude Code：GitHub Releases|json_list|https://api.github.com/repos/anthropics/claude-code/releases?per_page=20|
|Epoch AI：Gradient Updates|rss|https://epochai.substack.com/feed|
|Baseten 工程博客|web_list|https://www.baseten.co/blog/|
|Codex：GitHub Releases|json_list|https://api.github.com/repos/openai/codex/releases?per_page=20|
|a16z：News|rss|https://www.a16z.news/feed|
|Newcomer 新闻长文|rss|https://www.newcomer.co/feed|
|GitHub Blog|rss|https://github.blog/feed/|
|404 Media|rss|https://www.404media.co/rss/|
|Ed Zitron 长文 / Where’s Your Ed At|rss|https://www.wheresyoured.at/rss/|
|O'Reilly Radar|rss|https://www.oreilly.com/radar/feed/|
|Factory 研究 / 产品|rss|https://factory.com/news/rss|
|Tessl：产品与工程博客|rss|https://tessl.io/feed|
|Gemini API：更新日志|web_list|https://ai.google.dev/gemini-api/docs/changelog?hl=en|
|Platformer|rss|https://www.platformer.news/rss/|
|Claude：Blog|web_list|https://claude.com/blog|
|Midjourney：Updates|rss|https://updates.midjourney.com/rss/|
|Runway：News|json_list|https://runway.com/news|
|Artificial Analysis 完整文章|web_list|https://artificialanalysis.ai/articles|
|Comfy Blog|rss|https://blog.comfy.org/feed|
|Google Developers Blog|web_list|https://developers.googleblog.com/|
|LiveKit 产品与工程博客|web_list|https://livekit.com/blog|
|LlamaIndex：产品、工程与评测|web_list|https://www.llamaindex.ai/blog|
|Goodfire Research|web_list|https://www.goodfire.com/research|
|Anthropic：Claude.dev 开发者博客|rss|https://claude.dev/rss.xml|
|Augment Code 博客|rss|https://www.augmentcode.com/blog/rss.xml|
|Waymo：Blog|rss|https://waymo.com/blog/rss.xml|
|Zyphra Research|web_list|https://www.zyphra.com/our-work|
|Timothy B. Lee：Understanding AI|rss|https://www.understandingai.org/feed|
|Air Street Press|rss|https://press.airstreet.com/feed|
|Mastra Blog|web_list|https://mastra.ai/blog|
|OpenRouter：Announcements|rss|https://openrouter.ai/blog/feed.xml|
|Modem：Blog|rss|https://modem.ai/blog/rss.xml|
|OpenAI：部署安全与系统卡|rss|https://deploymentsafety.openai.com/rss.xml|
|Claude Platform：开发者版本说明|rss|https://platform.claude.com/docs/en/release-notes/feed.xml|
|Google AI：DEV 作者专属|rss|https://dev.to/feed/googleai|
|Claude 应用发布说明|web_list|https://support.claude.com/en/articles/12138966-release-notes|
|Stanford HAI News|web_list|https://hai.stanford.edu/news|
|Liquid AI 模型与工程博客|web_list|https://www.liquid.ai/blog|
|Tomasz Tunguz 博客|rss|https://tomtunguz.com/index.xml|
|英国 AI Security Institute：Blog|web_list|https://www.aisi.gov.uk/blog|
|PromptArmor：Threat Intelligence|json_list|https://www.promptarmor.com/resources|
|Preferred Networks：AI 研究与产品|web_list|https://www.preferred.jp/ja/news/|
|OpenAI：Alignment 研究博客|rss|https://alignment.openai.com/rss.xml|
|Cursor：Changelog|rss|https://cursor.com/changelog/rss.xml|
|Together AI 研究与产品博客|rss|https://www.together.ai/blog/rss.xml|
|METR：Blog|web_list|https://metr.org/blog/|
|Reflection Blog|web_list|https://reflection.ai/blog|
|Canary Media：Data Centers 原创报道|rss|https://www.canarymedia.com/rss.rss|
|Suno：Blog|web_list|https://suno.com/blog|

## 新增X账号完整列表

|名称|handle|参与方式|
|---|---|---|
|Rohan Paul · X|rohanpaul_ai|editorial|
|Tencent WorkBuddy · X|WorkBuddy_AI|editorial|
|Elon Musk · X|elonmusk|hot_signal|
|Vaibhav Srivastav · X|reach_vb|hot_signal|
|邵猛 · X|shao__meng|hot_signal|
|indigo · X|indigox|hot_signal|
|howie.serious · X|howie_serious|hot_signal|
|Oran Ge · X|oran_ge|editorial|
|Lauren Tan · X|poteto|hot_signal|
|X.PIN · X|thexpin|hot_signal|
|Testing Catalog · X|testingcatalog|hot_signal|
|Tibo · X|thsottiaux|hot_signal|
|马东锡 NLP · X|dongxi_nlp|hot_signal|
|Yuchen Jin · X|Yuchenj_UW|hot_signal|
|Thariq · X|trq212|hot_signal|
|Tripo · X|tripoai|editorial|
|Clément Delangue · X|ClementDelangue|editorial|
|Cohere · X|cohere|editorial|
|Noam Brown · X|polynoamial|hot_signal|
|星海图 Galaxea · X|GalaxeaDynamics|editorial|
|ElevenLabs · X|ElevenLabs|editorial|
|TypeSafe AI · X|typesafeai|editorial|
|Francois Chollet · X|fchollet|hot_signal|
|Nathan Lambert · X|natolambert|editorial|
|Dex Horthy · X|dexhorthy|hot_signal|
|PixVerse · X|PixVerse|editorial|
|Higgsfield AI · X|higgsfield|editorial|
|Viggle AI · X|ViggleAI|editorial|
|Arena · X|arena|editorial|
|Mustafa Suleyman · X|mustafasuleyman|hot_signal|
|Alex Heath · X|alexeheath|hot_signal|
|卡尔的 AI 沃茨 · X|aiwarts|hot_signal|
|Satya Nadella · X|satyanadella|hot_signal|
|Saito 硬地骇客 · X|SaitoWu|hot_signal|
|可灵 Kling AI · X|Kling_ai|editorial|
|蚂蚁百灵 · X|AntLingAGI|editorial|
|阶跃星辰 StepFun · X|StepFun_ai|editorial|
|Midjourney · X|midjourney|editorial|
|Cognition · X|cognition|editorial|
|OpenRouter · X|OpenRouter|editorial|
|Artificial Analysis · X|ArtificialAnlys|editorial|
|Luma AI · X|LumaLabsAI|editorial|
|Physical Intelligence · X|physical_int|editorial|
|Chelsea Finn · X|chelseabfinn|editorial|
|Noah Zweben · X|noahzweben|editorial|
|Sherwin Wu · X|sherwinwu|hot_signal|
|Eric Zakariasson · X|ericzakariasson|hot_signal|
|Suno · X|suno|editorial|
|Grok Bot · X|bot|hot_signal|
|Grok · X|grok|editorial|
|ARC Prize · X|arcprize|editorial|
|Unsloth · X|UnslothAI|editorial|
|Aravind Srinivas · X|AravSrinivas|hot_signal|
|Philipp Schmid · X|_philschmid|hot_signal|
|Thomas Wolf · X|Thom_Wolf|hot_signal|
|面壁智能 OpenBMB · X|OpenBMB|editorial|
|Ring Hyacinth · X|ring_hyacinth|hot_signal|
|Fei-Fei Li · X|drfeifei|hot_signal|
|腾讯混元 · X|TencentHunyuan|editorial|
|fal · X|fal|editorial|
|Sundar Pichai · X|sundarpichai|hot_signal|
|Demis Hassabis · X|demishassabis|hot_signal|
|SpaceXAI · X|SpaceXAI|hot_signal|
|Generalist · X|GeneralistAI|editorial|
|Odyssey · X|odysseyml|editorial|
|Waymo · X|Waymo|editorial|
|opencode · X|opencode|editorial|
|Logan Kilpatrick · X|OfficialLoganK|hot_signal|
|Arthur Mensch · X|arthurmensch|editorial|
|Wan · X|Alibaba_Wan|editorial|
|Jeff Dean · X|JeffDean|hot_signal|
|Boris Cherny · X|bcherny|hot_signal|
|Lisa Su · X|LisaSu|hot_signal|
|Cat Wu · X|_catwu|hot_signal|
|Ian Johnson · X|enjalot|editorial|
|Mark Chen · X|markchen90|hot_signal|
|Georgi Gerganov · X|ggerganov|hot_signal|
|Greg Brockman · X|gdb|hot_signal|
|Dash · X|DashHuang|hot_signal|
|Perplexity · X|perplexity_ai|editorial|
|Krea AI · X|krea_ai|editorial|
|Jim Fan · X|DrJimFan|hot_signal|
|百度 Baidu · X|Baidu_Inc|editorial|
|商汤 SenseTime · X|SenseTime_AI|editorial|
|Robbyant 蚂蚁灵波 · X|robbyant_brain|editorial|
|Josh Woodward · X|joshwoodward|hot_signal|
|UCSD Hao AI Lab · X|haoailab|editorial|
|唐杰 · X|jietang|hot_signal|
|Gemini Notebook · X|Gemini_Notebook|hot_signal|
|Meshy · X|MeshyAI|editorial|
|Tianyi Cui · X|tianyi|hot_signal|
|卡兹克 · X|Khazix0918|hot_signal|
|OpenClaw · X|openclaw|editorial|
|MiniMax · X|MiniMax_AI|editorial|
|Anthropic · X|AnthropicAI|editorial|
|ChatGPT · X|ChatGPT|editorial|
|Claude Devs · X|ClaudeDevs|editorial|
|OpenAI Developers · X|OpenAIDevs|editorial|
|Google AI · X|GoogleAI|editorial|
|Google · X|Google|editorial|
|通义千问 / Qwen · X|Alibaba_Qwen|editorial|
|OpenAI Newsroom · X|OpenAINewsroom|editorial|
|MiniMax Design (H3) · X|Hailuo_AI|editorial|
|Claude · X|claudeai|editorial|
|Cursor · X|cursor_ai|editorial|
|Microsoft Research · X|MSFTResearch|editorial|
|Manus · X|ManusAI|editorial|
|Mistral AI · X|MistralAI|editorial|
|Google DeepMind · X|GoogleDeepMind|editorial|

## 新增公众号完整列表

|名称|采集通道|本次结果|
|---|---|---|
|公众号：阶跃星辰|wx_cache|ok，列表2条|
|公众号：卡尔的AI沃茨|dajiala|ok，列表10条|
|公众号：面壁智能|dajiala|ok，列表11条|
|公众号：可灵AI|dajiala|ok，列表10条|
|公众号：昆仑万维|dajiala|ok，列表12条|
|公众号：百度智能云|dajiala|ok，列表22条|
|公众号：小红书技术|dajiala|ok，列表10条|
|公众号：腾讯元宝|dajiala|ok，列表10条|
|公众号：生数科技|dajiala|ok，列表11条|
|公众号：火山引擎|dajiala|ok，列表10条|

## 最终运行验证

2026-10-12 19:28 CST：API、web、worker、只读桥接四角色均READY；正式源目录616/600，一键Start达到READY。TypeScript、后端独立空库653/653、前端32/32、Python23/23通过，网页生产构建通过；运行smoke35项全部通过。滚动模型预算仍是LLM 20/分钟、180/小时、800/天及embedding 30/分钟、240/小时、1000/天。

运行快照材料12,018、可公开内容201、精选27；这些是全系统快照，不能全部归因于本次补齐。后续材料、分析和发布会随后台持续运行改变。
