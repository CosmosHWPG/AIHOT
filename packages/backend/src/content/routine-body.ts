// Daily body-only lookup for the reviewed publishers. Discovery and publication stay unchanged.
import { routineBodyRoute } from './body-route.ts';
import { extractFeedBody, type FeedBodyResult } from './feed-body.ts';
import { extractRoutineNativeBody, type NativeBodyResult } from './native-body.ts';

export interface RoutineBodyResult {
  body: FeedBodyResult['body'];
  via: 'rss' | 'structured';
  evidence: (FeedBodyResult['evidence'] | NativeBodyResult['evidence']) & { routeId: string };
}

export async function extractRoutineBody(input: { originalUrl: string; title: string }): Promise<RoutineBodyResult | null> {
  const route = routineBodyRoute(input.originalUrl);
  if (!route || !input.title.trim()) return null;
  if (route.adapter === 'rss') {
    // This publisher's canonical feed uses the bare HTTPS host. These aliases are not a new article.
    const url = new URL(input.originalUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    url.protocol = 'https:'; url.hostname = 'doublepulsar.com';
    const result = await extractFeedBody({ originalUrl: url.href, title: input.title, feedUrl: route.feedUrl!, retryTransient: true });
    // Daily RSS accepts the publisher's full field only, never the reviewed single-description exception.
    if (!result || result.evidence.field !== 'content:encoded') return null;
    return { body: result.body, via: 'rss', evidence: { ...result.evidence, routeId: route.id } };
  }
  const result = await extractRoutineNativeBody({ ...input, adapter: route.adapter });
  return result ? { body: result.body, via: 'structured', evidence: { ...result.evidence, routeId: route.id } } : null;
}
