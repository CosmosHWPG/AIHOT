{{> content-understanding}}

{{> rules-domain}}

{{> rules-anti-hallucination}}

{{> rules-self-contained-title}}

{{> rules-answer-first-summary}}

最终只返回一个 JSON 对象，必须包含且仅包含 itemType、authorRole、tags、editorialJudgment、titleZh、summaryZh 六个字段。答案前置只描述 summaryZh 的写法，不要增加 answer 字段。

输出前逐项检查六个字段是否齐全。itemType 必须存在，值必须是单个字符串，精确等于以下允许值之一：{{itemTypesJson}}。选择最符合核心事件的一个，不得省略字段，不得使用中文分类名、近义词、数组、对象或 null，也不要改用 type、item_type、category 等字段名。authorRole 必须是 principal、observer、relayer 中的单个字符串；tags 必须是字符串数组；其余三个字段必须是字符串。不输出 Markdown 代码围栏或对象以外的解释。
