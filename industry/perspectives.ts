// Reading perspectives use the same persisted labels as the public article APIs.
// Topic membership is editorial configuration, never a claim about article counts.
export const PERSPECTIVES = [
  {
    key: "core",
    label: "核心网",
    tag: "核心网",
    description: "架构、标准、网络安全与产业演进",
    topics: ["core-network", "5gc", "6g", "standards", "cloud-native-network", "network-security", "network-intelligence", "network-api", "private-edge", "network-resilience", "commercial-strategy", "engineering", "open-source", "ericsson", "nokia", "huawei", "zte", "samsung", "cisco", "oracle", "red-hat", "3gpp", "etsi", "ietf", "gsma", "tm-forum", "o-ran", "cncf", "ngmn", "itu"],
  },
  {
    key: "ai",
    label: "AI",
    tag: "AI",
    description: "模型、智能体、工程、安全与商业",
    topics: ["ai", "agent", "rag", "ai-memory", "ai-evaluation", "ai-safety", "ai-infrastructure", "ai-business", "commercial-strategy", "coding", "reasoning", "multimodal", "image-gen", "video", "voice", "embodied", "on-device", "open-source", "engineering", "data-training", "safety", "mcp", "openai", "anthropic", "google", "deepseek", "qwen", "kimi", "minimax", "zhipu", "xai", "meta", "microsoft", "nvidia", "hugging-face", "cursor", "openrouter", "huawei", "cisco", "oracle", "red-hat", "cncf"],
  },
] as const;

export type PerspectiveKey = (typeof PERSPECTIVES)[number]["key"];

// A topic is OR within its tags. The singleton AI topic AND the core tag is an intersection.
export function isCrossPerspective(tag: string | null | undefined, topic: string | null | undefined): boolean {
  return tag === "核心网" && topic === "ai";
}

export function perspectiveFilters(key: "all" | "cross" | PerspectiveKey): { tag: string | null; topic: string | null } {
  if (key === "cross") return { tag: "核心网", topic: "ai" };
  return { tag: PERSPECTIVES.find((p) => p.key === key)?.tag ?? null, topic: null };
}
