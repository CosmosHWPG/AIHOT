// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉模型怎么归类。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
  { key: "ai-models", label: "模型", section: "模型发布/更新", guide: "新模型、模型版本、权重开放、模型能力与价格变化的发布与评测结果" },
  { key: "ai-products", label: "产品", section: "产品与网络演进", guide: "核心网网元、通信平台与网络能力，以及 AI 产品、工具、API、平台的正式发布和更新；架构落地、部署工程与商用试点的具体能力变化" },
  { key: "industry", label: "产业", section: "产业与标准进展", guide: "核心网与 AI 的标准发布、工作项目及版本阶段，政策监管、安全通报、市场竞争、公司经营、融资并购、合作与商业基础设施；标准提案与冻结要区分阶段" },
  { key: "paper", label: "研究", section: "研究与评测", guide: "核心网、6G 与 AI 的研究论文、技术报告、基准、测量方法和数据集；研究结论须保留实验范围" },
  { key: "tip", label: "工程", section: "工程与技术洞察", guide: "核心网或 AI 的架构设计、部署实践、性能与成本优化、协议分析、故障复盘、安全防御、可复用方法和深度技术讲解" },
  { key: "opinion", label: "洞察", section: "工程与技术洞察", guide: "技术与商业判断、标准路线分析、架构取舍、战略规划、竞争格局、深度访谈与趋势讨论" },
] as const;

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "产品更新", "模型发布", "论文/研究", "开源/仓库", "教程/实践", "现象/趋势", "大佬观点", "评测/基准", "安全/对齐", "行业动态", "政策/监管",
  "非AI/通用工具", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "Agent", "编码", "推理", "多模态", "语音", "视频", "图像生成", "RAG", "端侧", "数据/训练", "搜索", "部署/工程", "开源生态", "具身智能", "MCP/工具调用",
  "核心网", "AI", "5GC/核心网", "6G", "标准/协议", "云原生网络", "网络安全", "网络智能化", "网络开放/API", "专网/边缘", "网络韧性", "AI记忆", "AI评测", "AI安全", "AI基础设施", "商业/战略", "AI商业",
] as const;

/** Only domain-specific labels imply a reading perspective; generic tags and companies do not. */
export const DOMAIN_TAG_RULES: Readonly<Record<string, readonly string[]>> = {
  "AI": ["模型发布", "RAG", "AI记忆", "AI评测", "AI安全", "AI基础设施", "AI商业", "MCP/工具调用"],
  "核心网": ["5GC/核心网", "6G", "网络智能化", "网络开放/API", "专网/边缘", "网络韧性"],
};

/** 可选的实体标签（公司、机构、平台）。 */
export const ENTITY_TAGS = ["OpenAI", "Anthropic", "DeepSeek", "DeepMind", "Google", "Meta", "Microsoft", "xAI", "Hugging Face", "GitHub", "arXiv", "NVIDIA", "Ericsson", "Nokia", "华为", "中兴", "Samsung", "Cisco", "Oracle", "Red Hat", "3GPP", "ETSI", "IETF", "GSMA", "TM Forum", "O-RAN Alliance", "CNCF", "NGMN", "ITU"] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "教程/玩法": "教程/实践", "技巧/最佳实践": "教程/实践", "合作/生态": "行业动态", "融资/收购": "行业动态", "公司动态": "行业动态",
  合作: "行业动态", 生态: "行业动态", 融资: "行业动态", 收购: "行业动态", 投资: "行业动态", 并购: "行业动态",
  政策: "政策/监管", 监管: "政策/监管", 法规: "政策/监管", 安全: "安全/对齐", 对齐: "安全/对齐",
  论文: "论文/研究", 研究: "论文/研究", paper: "论文/研究", papers: "论文/研究",
  "open-source": "开源/仓库", 开源: "开源/仓库", 仓库: "开源/仓库", repo: "开源/仓库",
  教程: "教程/实践", 玩法: "教程/实践", 指南: "教程/实践", 技巧: "教程/实践", 最佳实践: "教程/实践", 实践: "教程/实践",
  产品: "产品更新", 更新: "产品更新", 发布: "模型发布", 模型: "模型发布", 趋势: "现象/趋势", 现象: "现象/趋势", 观点: "大佬观点",
  视频生成: "视频", 非ai: "非AI/通用工具", "non-ai": "非AI/通用工具", 通用工具: "非AI/通用工具", 工程工具: "非AI/通用工具",
  安全扫描: "非AI/通用工具", devops: "非AI/通用工具", 行业: "行业动态", 动态: "行业动态",
  "5GC": "5GC/核心网", "5G Core": "5GC/核心网", "5G核心网": "5GC/核心网", "移动核心网": "5GC/核心网", "EPC": "5GC/核心网",
  "通信标准": "标准/协议", "标准": "标准/协议", "协议": "标准/协议", "CNF": "云原生网络", "云原生核心网": "云原生网络",
  "NWDAF": "网络智能化", "自治网络": "网络智能化", "Network API": "网络开放/API", "CAMARA": "网络开放/API",
  "AI记忆系统": "AI记忆", "Memory": "AI记忆", "AI安全治理": "AI安全", "评测": "评测/基准",
  "爱立信": "Ericsson", "诺基亚": "Nokia", "Huawei": "华为", "ZTE": "中兴", "三星": "Samsung",
};

/** 模型漏了分类标签时，按内容类型补一个。 */
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  model_release: "模型发布", product_launch: "产品更新", tool_or_prompt: "教程/实践", research_paper: "论文/研究",
  industry_event: "行业动态", opinion_analysis: "大佬观点", tutorial_explainer: "教程/实践",
};

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/** 公司主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  openai: { name: "OpenAI", displayTag: "OpenAI", aliases: ["OpenAI", "ChatGPT", "Sora", "Codex", "GPT"] },
  anthropic: { name: "Anthropic", displayTag: "Anthropic", aliases: ["Anthropic", "Claude"] },
  google: { name: "Google", displayTag: "Google", aliases: ["Google", "DeepMind", "Gemini", "谷歌"] },
  deepseek: { name: "DeepSeek", displayTag: "DeepSeek", aliases: ["DeepSeek", "深度求索"] },
  qwen: { name: "千问 Qwen", displayTag: null, aliases: ["Qwen", "通义", "阿里"] },
  kimi: { name: "Kimi / 月之暗面", displayTag: null, aliases: ["Kimi", "月之暗面", "Moonshot"] },
  minimax: { name: "MiniMax", displayTag: null, aliases: ["MiniMax", "海螺"] },
  zhipu: { name: "智谱 GLM", displayTag: null, aliases: ["智谱", "GLM", "Z.ai"] },
  xai: { name: "xAI", displayTag: "xAI", aliases: ["xAI", "Grok"] },
  meta: { name: "Meta", displayTag: "Meta", aliases: ["Meta", "Llama"] },
  microsoft: { name: "Microsoft", displayTag: "Microsoft", aliases: ["Microsoft", "微软", "Copilot"] },
  nvidia: { name: "NVIDIA", displayTag: null, aliases: ["NVIDIA", "英伟达"] },
  "hugging-face": { name: "Hugging Face", displayTag: "Hugging Face", aliases: ["Hugging Face"] },
  cursor: { name: "Cursor", displayTag: null, aliases: ["Cursor", "Anysphere"] },
  openrouter: { name: "OpenRouter", displayTag: null, aliases: ["OpenRouter"] },
  ericsson: { name: "Ericsson 爱立信", displayTag: "Ericsson", aliases: ["Ericsson", "爱立信"] },
  nokia: { name: "Nokia 诺基亚", displayTag: "Nokia", aliases: ["Nokia", "诺基亚"] },
  huawei: { name: "华为 Huawei", displayTag: "华为", aliases: ["Huawei", "华为"] },
  zte: { name: "中兴 ZTE", displayTag: "中兴", aliases: ["ZTE", "中兴通讯"] },
  samsung: { name: "Samsung 三星", displayTag: "Samsung", aliases: ["Samsung", "三星"] },
  cisco: { name: "Cisco 思科", displayTag: "Cisco", aliases: ["Cisco", "思科"] },
  oracle: { name: "Oracle", displayTag: "Oracle", aliases: ["Oracle", "甲骨文"] },
  "red-hat": { name: "Red Hat", displayTag: "Red Hat", aliases: ["Red Hat", "红帽"] },
  "3gpp": { name: "3GPP", displayTag: "3GPP", aliases: ["3GPP", "第三代合作伙伴计划"] },
  etsi: { name: "ETSI", displayTag: "ETSI", aliases: ["ETSI", "欧洲电信标准化协会"] },
  ietf: { name: "IETF", displayTag: "IETF", aliases: ["IETF", "互联网工程任务组"] },
  gsma: { name: "GSMA", displayTag: "GSMA", aliases: ["GSMA", "GSM Association"] },
  "tm-forum": { name: "TM Forum", displayTag: "TM Forum", aliases: ["TM Forum", "TMForum", "电信管理论坛"] },
  "o-ran": { name: "O-RAN Alliance", displayTag: "O-RAN Alliance", aliases: ["O-RAN Alliance", "O-RAN联盟"] },
  cncf: { name: "CNCF", displayTag: "CNCF", aliases: ["CNCF", "Cloud Native Computing Foundation"] },
  ngmn: { name: "NGMN", displayTag: "NGMN", aliases: ["NGMN", "Next Generation Mobile Networks"] },
  itu: { name: "ITU", displayTag: "ITU", aliases: ["ITU", "国际电信联盟"] },
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 行业没有这个问题时可以留空数组。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "openai", name: "OpenAI", patterns: [/openai|chatgpt|\bgpt-?[o\d]|\bsora\b|\bcodex\b/i] },
  { id: "anthropic", name: "Anthropic", patterns: [/anthropic|\bclaude\b/i, /\b(?:opus|sonnet|haiku)\s*\d+(?:[.\-]\d+)*\b/i, /\bfable\s*\d+(?:[.\-]\d+)*\b|\bmythos\b/i] },
  { id: "google", name: "Google / Gemini", patterns: [/google|deepmind|\bgemini\b|notebooklm|\bveo\s?\d|\bAlphaFold\b|\bAMIE\b/i] },
  { id: "deepseek", name: "DeepSeek", patterns: [/deepseek|深度求索/i] },
  { id: "xai", name: "xAI / Grok", patterns: [/\bxai\b|\bgrok\b/i] },
  { id: "meta", name: "Meta / Llama", patterns: [/\bMeta\b/, /\bmeta\s?ai\b|\bllama\b/i] },
  { id: "microsoft", name: "Microsoft / Copilot", patterns: [/microsoft|copilot|微软/i] },
  { id: "nvidia", name: "NVIDIA", patterns: [/nvidia|英伟达|\bnemotron\b|\bnemo\b|\bblackwell\b|\brubin(?:\s+ultra)?\b|\bcuda\b/i] },
  { id: "qwen", name: "千问 Qwen", patterns: [/\bqwen|通义|千问/i] },
  { id: "hugging-face", name: "Hugging Face", patterns: [/hugging\s?face/i] },
  { id: "cursor", name: "Cursor", patterns: [/\bCursor\b/] },
  { id: "kimi", name: "Kimi / 月之暗面", patterns: [/\bkimi\b|月之暗面|\bmoonshot\s?ai\b/i] },
  { id: "openrouter", name: "OpenRouter", patterns: [/openrouter/i] },
  { id: "minimax", name: "MiniMax", patterns: [/minimax/i] },
  { id: "zhipu", name: "智谱 GLM", patterns: [/智谱|\bglm-?[4-9]/i] },
  { id: "hunyuan", name: "腾讯混元", patterns: [/混元|hunyuan/i] },
  { id: "doubao", name: "字节豆包", patterns: [/豆包|doubao|字节跳动|bytedance/i] },
  { id: "mistral", name: "Mistral", patterns: [/mistral/i] },
  { id: "perplexity", name: "Perplexity", patterns: [/\bPerplexity\b/] },
  { id: "runway", name: "Runway", patterns: [/\brunway\b/i] },
  { id: "suno", name: "Suno", patterns: [/\bsuno\b/i] },
  { id: "midjourney", name: "Midjourney", patterns: [/midjourney/i] },
  { id: "stability-ai", name: "Stability AI", patterns: [/stability\s?ai/i] },
  { id: "elevenlabs", name: "ElevenLabs", patterns: [/eleven\s?labs/i] },
  { id: "vllm", name: "vLLM", patterns: [/\bvllm\b/i] },
  { id: "ollama", name: "Ollama", patterns: [/\bollama\b/i] },
  { id: "windsurf", name: "Windsurf", patterns: [/windsurf/i] },
  { id: "devin", name: "Devin", patterns: [/\bdevin\b/i] },
  { id: "manus", name: "Manus", patterns: [/\bmanus\b/i] },
  { id: "apple", name: "Apple AI", patterns: [/\bapple\s?(intelligence|silicon|ai)\b|苹果(智能|\s?AI)/i] },
  { id: "amazon", name: "Amazon / AWS", patterns: [/amazon|\baws\b|亚马逊/i] },
  { id: "baidu", name: "百度文心", patterns: [/百度|baidu|文心|\bernie\s?bot\b/i] },
  { id: "ericsson", name: "Ericsson", patterns: [/\bericsson\b|爱立信/i] },
  { id: "nokia", name: "Nokia", patterns: [/\bnokia\b|诺基亚/i] },
  { id: "huawei", name: "华为", patterns: [/\bhuawei\b|华为/i] },
  { id: "zte", name: "中兴", patterns: [/\bzte\b|中兴通讯|中兴/i] },
  { id: "samsung", name: "Samsung", patterns: [/\bsamsung\b|三星/i] },
  { id: "cisco", name: "Cisco", patterns: [/\bcisco\b|思科/i] },
  { id: "oracle", name: "Oracle", patterns: [/\boracle\b|甲骨文/i] },
  { id: "red-hat", name: "Red Hat", patterns: [/\bred\s+hat\b|红帽/i] },
  { id: "3gpp", name: "3GPP", patterns: [/\b3gpp\b|第三代合作伙伴计划/i] },
  { id: "etsi", name: "ETSI", patterns: [/\betsi\b|欧洲电信标准化协会/i] },
  { id: "ietf", name: "IETF", patterns: [/\bietf\b|互联网工程任务组/i] },
  { id: "gsma", name: "GSMA", patterns: [/\bgsma\b|\bgsm\s+association\b/i] },
  { id: "tm-forum", name: "TM Forum", patterns: [/\btm\s*forum\b|电信管理论坛/i] },
  { id: "o-ran", name: "O-RAN Alliance", patterns: [/\bo-ran\s+alliance\b|O-RAN联盟/i] },
  { id: "cncf", name: "CNCF", patterns: [/\bcncf\b|cloud native computing foundation/i] },
  { id: "ngmn", name: "NGMN", patterns: [/\bngmn\b|next generation mobile networks/i] },
  { id: "itu", name: "ITU", patterns: [/\bitu(?:-t|-r)?\b|国际电信联盟/i] },
];

/** 这些域名上的文章，发布方就是对应的公司（托管平台如 GitHub、arXiv 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "openai", domains: ["openai.com"] },
  { entityId: "anthropic", domains: ["anthropic.com", "claude.com"] },
  { entityId: "google", domains: ["deepmind.google", "ai.google", "blog.google"] },
  { entityId: "deepseek", domains: ["deepseek.com"] },
  { entityId: "xai", domains: ["x.ai"] },
  { entityId: "meta", domains: ["ai.meta.com"] },
  { entityId: "microsoft", domains: ["microsoft.com"] },
  { entityId: "nvidia", domains: ["nvidia.com"] },
  { entityId: "qwen", domains: ["qwen.ai"] },
  { entityId: "cursor", domains: ["cursor.com"] },
  { entityId: "openrouter", domains: ["openrouter.ai"] },
  { entityId: "ericsson", domains: ["ericsson.com"] },
  { entityId: "nokia", domains: ["nokia.com"] },
  { entityId: "huawei", domains: ["huawei.com"] },
  { entityId: "zte", domains: ["zte.com.cn"] },
  { entityId: "samsung", domains: ["samsung.com"] },
  { entityId: "cisco", domains: ["cisco.com"] },
  { entityId: "oracle", domains: ["oracle.com"] },
  { entityId: "red-hat", domains: ["redhat.com"] },
  { entityId: "3gpp", domains: ["3gpp.org"] },
  { entityId: "etsi", domains: ["etsi.org"] },
  { entityId: "ietf", domains: ["ietf.org", "rfc-editor.org"] },
  { entityId: "gsma", domains: ["gsma.com"] },
  { entityId: "tm-forum", domains: ["tmforum.org"] },
  { entityId: "o-ran", domains: ["o-ran.org"] },
  { entityId: "cncf", domains: ["cncf.io"] },
  { entityId: "ngmn", domains: ["ngmn.org"] },
  { entityId: "itu", domains: ["itu.int"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "meta", pattern: /@AIatMeta\b/i },
  { entityId: "zhipu", pattern: /\bZhipu(?:\s+AI\b|['’]s\b)/i },
];
