import { DOMAIN_TAG_RULES } from "@aihot/industry/taxonomy";

/** Keep explicit domain evidence and infer only from the industry's exclusive vocabulary. */
export function withDomainTags(tags: string[], evidenceTags: readonly string[] = []): string[] {
  const output = [...new Set(tags)];
  const evidence = new Set([...tags, ...evidenceTags]);
  for (const [domain, exclusive] of Object.entries(DOMAIN_TAG_RULES)) {
    if ((evidence.has(domain) || exclusive.some((tag) => evidence.has(tag))) && !output.includes(domain)) output.push(domain);
  }
  return output;
}
