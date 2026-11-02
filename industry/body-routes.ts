// Normal body-only routes for approved publishers. Discovery, source IDs and publication rights stay separate.
export const BODY_ROUTES = [
  { id: "doublepulsar-rss", adapter: "rss", hosts: ["doublepulsar.com", "www.doublepulsar.com"], feedUrl: "https://doublepulsar.com/feed" },
  { id: "mittrchina-native", adapter: "mittrchina", hosts: ["mittrchina.com", "www.mittrchina.com"] },
  { id: "speechhome-native", adapter: "speechhome", hosts: ["speechhome.com", "www.speechhome.com"] },
] as const;

export const JINA_DENIED_BODY_HOSTS: readonly string[] = [
  ...BODY_ROUTES.flatMap(route => [...route.hosts]),
  'apii.web.mittrchina.com',
];
