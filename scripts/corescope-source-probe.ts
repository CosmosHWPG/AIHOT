// Bounded, read-only admission checks. No SQL writes, model calls, paid providers or V2 imports.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import * as cheerio from "cheerio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
if (args.has("--environment-proxy")) {
  process.env.EGRESS_PROXY_URL ||= process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
}
const { guardedFetch } = await import("../packages/backend/src/lib/http-fetch.ts");
type Adapter = { kind: string; config: Record<string, unknown> };
type Check = { status: string; checkedAt: string; transport: string; httpStatus: number | null; items: number; reason: string; url?: string; datedItems?: number; latestPublishedAt?: string | null; samples?: Array<{title:string;url:string;publishedAt:string|null}>; attempts?: Check[] };
type Profile = { policy: "native"|"bridge"|"blocked"; adapter?: Adapter; participationMode: "editorial"|"isolated"; nonArticle?: boolean; frozen?: boolean; verification: Check; reason?: string; fallback?: string; catalogPlan?: Record<string,unknown>; bridgeIntakeUrlPrefixes?:string[] };
type AuditRow = {sourceId:string;name:string;previousEnabled:boolean;v2Status:string|null;accessMethod:string|null;profile:Profile};
const sourcePack = JSON.parse(readFileSync(path.join(root,"industry/sources.json"),"utf8"));
const mapping = JSON.parse(readFileSync(path.join(root,"docs/corescope-v2-sources.json"),"utf8"));
const canonical = new Map<string,any>(sourcePack.sources.map((s:any)=>[s.id,s]));
const v2 = new Map<string,any>();
for (const row of mapping.sources) {
  if (row.aihot_source_id===row.canonical_source_id && canonical.has(row.aihot_source_id)) v2.set(row.aihot_source_id,row);
}
const oldProfilesPath = path.join(root,"industry/corescope-source-profiles.json");
let oldProfiles:Record<string,Profile>={};
let oldFrozenIds:string[]=[];
try {const old=JSON.parse(readFileSync(oldProfilesPath,"utf8"));oldProfiles=old.profiles??{};oldFrozenIds=old.preserveDisabledSourceIds??[];}catch{}
const preserveDisabledSourceIds = [...new Set([...oldFrozenIds,...Object.entries(oldProfiles).filter(([,p])=>p.frozen===true).map(([id])=>id),...[...canonical.values()].filter(s=>!s.enabled&&v2.get(s.id)?.status==="暂停").map(s=>s.id)])].sort();
const privateKey = /token|secret|password|passwd|api[-_]?key|auth|signature|cookie|credential|access[-_]?key/i;
function safePublic(value:unknown):string|null {
  try {
    const u=new URL(String(value??""));
    if(!["http:","https:"].includes(u.protocol)||u.username||u.password) return null;
    if([...u.searchParams].some(([k,v])=>privateKey.test(k)||v.includes("[REDACTED]")))return null;
    if(u.pathname.includes("[REDACTED]")||/^(www\.)?(rss\.app|kill-the-newsletter\.com)$/.test(u.hostname)||(/^alerts?\.google\./.test(u.hostname)||/(^|\.)google\./.test(u.hostname))&&u.pathname.startsWith("/alerts/feeds/")) return null;
    if((u.hostname==="api.xgo.ing"&&/^\/rss\/user\/[a-f0-9]{20,}/i.test(u.pathname))||(/wechat2rss\./.test(u.hostname)&&/^\/feed\/[a-f0-9]{20,}/i.test(u.pathname))||u.hostname==="rss.jintiankansha.me")return null;
    return u.toString();
  }catch{return null;}
}
const transport = process.env.EGRESS_PROXY_URL ? "guardedFetch:configured-egress-proxy; .cn/direct routing" : "guardedFetch:direct";
function checked(status:string,reason:string):Check{return {status,reason,checkedAt:new Date().toISOString(),transport,httpStatus:null,items:0};}
function parseDate(x:unknown):string|null {
  const t=Date.parse(String(x??""));return Number.isFinite(t)?new Date(t).toISOString():null;
}
function value(x:any):string {if(x===null||x===undefined)return "";if(typeof x==="string"||typeof x==="number")return String(x);if(Array.isArray(x))return value(x[0]);return value(x["#text"]??x["#cdata"]??"");}
function arr(x:any):any[]{return x===null||x===undefined?[]:Array.isArray(x)?x:[x];}
function cleanTitle(x:unknown):string{return String(x??"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();}
function articleUrl(url:string):boolean {const u=new URL(url);return !(u.hostname==="weixin.sogou.com"&&u.pathname==="/weixin")&&!/\/search\/?$/.test(u.pathname)&&!(u.hostname.endsWith("google.com")&&u.pathname==="/search");}
type Item={title:string;url:string;publishedAt:string|null};
function rssItems(text:string,base:string):Item[]{
  if(XMLValidator.validate(text)!==true)throw new Error("Invalid XML");
  const doc=new XMLParser({ignoreAttributes:false,attributeNamePrefix:"@",textNodeName:"#text",cdataPropName:"#cdata",htmlEntities:true}).parse(text);
  const atom=doc.feed;
  const raw=atom?arr(atom.entry):doc.rss?arr(doc.rss.channel?.item):doc["rdf:RDF"]?arr(doc["rdf:RDF"].item):null;
  if(!raw)throw new Error("Not an RSS/Atom/RDF feed");
  const seen=new Set<string>();
  return raw.flatMap((x:any)=>{
    let link=value(x.link);
    if(atom){const links=arr(x.link);link=value(links.find((a:any)=>!a["@rel"]||a["@rel"]==="alternate")?.["@href"]??links[0]?.["@href"]??links[0]);}
    const guid=value(x.guid)||x["@rdf:about"]||"";
    const rawLink=link||(/^https?:\/\//.test(guid)?guid:"");
    if(!rawLink)return [];
    let url:string|null=null;try{url=safePublic(new URL(rawLink,base).toString());}catch{}
    const title=cleanTitle(value(x.title));
    if(!url||!articleUrl(url)||title.length<4||seen.has(url))return [];
    seen.add(url);
    return [{title,url,publishedAt:parseDate(value(x.pubDate??x.published??x.updated??x["dc:date"]))}];
  });
}
function success(url:string,status:number,items:Item[],reason:string):Check{
  const dated=items.filter(x=>x.publishedAt);
  return {status:items.length?"verified":"empty",checkedAt:new Date().toISOString(),transport,httpStatus:status,items:items.length,url,reason,datedItems:dated.length,latestPublishedAt:dated.map(x=>x.publishedAt!).sort().at(-1)??null,samples:items.slice(0,3)};
}
function safeError(e:any):string {return e?.cause?.code?String(e.cause.code):e?.name==="TimeoutError"?"Timeout (15s budget)":String(e?.message??e).replace(/https?:\/\/\S+/g,"[url]").replace(/[A-Z]:\\[^\s]+/gi,"[local path]").slice(0,220);}
const feedJobs = new Map<string,Promise<Check>>();
async function probeFeed(url:string):Promise<Check>{
  const prior=feedJobs.get(url);if(prior)return prior;
  const job=(async()=>{
    try {
      const res=await guardedFetch(url,{timeoutMs:15_000,maxBytes:4*1024*1024,maxRedirects:3,headers:{accept:"application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5"}});
      const final=safePublic(res.url)??url;
      if(res.status!==200)return {...checked("http_error",`HTTP ${res.status}`),url:final,httpStatus:res.status};
      const items=rssItems(res.text(),final);
      return success(final,res.status,items,items.length?"Valid XML feed with distinct public article URLs and titles; dates preserved where supplied":"Valid XML feed but no usable entries");
    }catch(e){return {...checked("parse_or_network_error",safeError(e)),url};}
  })();feedJobs.set(url,job);return job;
}
const articleRules:Record<string,string>={
  "www.3gpp.org":"^https://www\\.3gpp\\.org/news-events/(?:3gpp-news|partners-news)/[^/?#]+",
  "www.c114.com.cn":"^https?://www\\.c114\\.com\\.cn/(?:[a-z]+/)?\\d+/(?:a|a_)?\\d+",
  "www.marvell.com":"^https://www\\.marvell\\.com/company/newsroom/press-releases/[^/?#]+",
  "mem0.ai":"^https://mem0\\.ai/blog/[^/?#]+",
  "cursor.com":"^https://cursor\\.com/(?:blog|changelog)/[^/?#]+",
  "dify.ai":"^https://dify\\.ai/blog/[^/?#]+",
  "llm-d.ai":"^https://llm-d\\.ai/blog/[^/?#]+",
  "manus.im":"^https://manus\\.im/blog/[^/?#]+",
  "www.unite.ai":"^https://www\\.unite\\.ai/[^/?#]+/?$",
  "www.lmsys.org":"^https://www\\.lmsys\\.org/blog/[^/?#]+",
  "www.mindtheproduct.com":"^https://www\\.mindtheproduct\\.com/[^/?#]+/?$",
  "www.oracle.com":"^https://www\\.oracle\\.com/news/announcement/[^/?#]+",
  "www.orange-business.com":"^https://www\\.orange-business\\.com/en/press/[^/?#]+",
  "www.asml.com":"^https://www\\.asml\\.com/en/news/[^/?#]+/[^/?#]+",
  "www.iso.org":"^https://www\\.iso\\.org/news/[0-9]+/[^/?#]+",
  "www.iec.ch":"^https://www\\.iec\\.ch/blog/[^/?#]+",
  "www.telekom.com":"^https://www\\.telekom\\.com/en/media/media-information/archive/[^/?#]+",
  "www.rtecommunity.dev":"^https://www\\.rtecommunity\\.dev/blog/[^/?#]+",
  "www.datacenterdynamics.com":"^https://www\\.datacenterdynamics\\.com/en/(?:news|analysis|opinions|features)/[^/?#]+",
};
const menuWords=/^(home|about|contact|products?|solutions?|support|search|subscribe|careers?|privacy|terms|sign in|log in|news|blog|articles|latest|previous|next|read more|learn more|首页|关于我们|联系我们|更多|新闻中心|产品|解决方案)$/i;
async function probeWeb(url:string,pattern:string):Promise<{check:Check;adapter?:Adapter}>{
  try {
    const res=await guardedFetch(url,{timeoutMs:15_000,maxBytes:4*1024*1024,maxRedirects:3,headers:{accept:"text/html,application/xhtml+xml"}});
    const final=safePublic(res.url)??url;
    if(res.status!==200)return {check:{...checked("http_error",`HTTP ${res.status}`),url:final,httpStatus:res.status}};
    const $=cheerio.load(res.text()),re=new RegExp(pattern),seen=new Set<string>(),items:Item[]=[];
    const host=new URL(final).hostname;
    const articleSelector=host.endsWith("unite.ai")?"li.mvp-blog-story-wrap h2 a[href],li.mvp-blog-story-wrap h3 a[href]":host.endsWith("mindtheproduct.com")?"main h2 a[href],main h3 a[href],article h2 a[href],article h3 a[href]":"main a[href],article a[href],.content a[href],.news a[href],a[href]";
    $(articleSelector).each((_i,el)=>{
      const node=$(el),title=cleanTitle(node.text()||node.attr("title"));
      let target:string|null=null;try{target=safePublic(new URL(node.attr("href")??"",final).toString());}catch{}
      if(!target||!re.test(target)||new URL(target).origin!==new URL(final).origin||title.length<8||menuWords.test(title)||seen.has(target)||target.replace(/\/$/,"")===final.replace(/\/$/,""))return;
      const box=node.closest("article,li,.card,.post,.news-item,.entry");
      const time=box.find("time").first();
      const dateText=box.text().match(/\b(?:\d{1,2}\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{1,2},?)?\s+20\d{2}\b|20\d{2}[-/]\d{1,2}[-/]\d{1,2}/i)?.[0];
      const publishedAt=parseDate(time.attr("datetime")??time.text())??parseDate(dateText)??parseDate(/\/(20\d{2})[-/](\d{2})[-/](\d{2})/.exec(target)?.slice(1,4).join("-"));
      seen.add(target);items.push({title,url:target,publishedAt});
    });
    const check=success(final,res.status,items,items.length?"Explicit article URL pattern excludes navigation; listing dates may be absent and detail extraction must retain unknown dates":"HTML fetched but no titles matched the explicit article URL pattern");
    const pathPattern=pattern.replace(/^\^https?\??:\/\/[^/]+/,"^");
    return {check,adapter:items.length?{kind:"web_list",config:{url,adapter:"article_links",itemUrlPattern:pathPattern,itemSelector:articleSelector,minTitleLength:8,requirePublishedAt:false,_aihot:{initialBackfillLimit:2}}}:undefined};
  }catch(e){return {check:{...checked("parse_or_network_error",safeError(e)),url}};}
}
function feedIdentity(items:Check,row:any):boolean{
  // A feed attached to the wrong publisher must not silently re-label another outlet's content.
  if(!row?.original_url||!items.samples?.length)return true;
  const original=safePublic(row.original_url);if(!original)return true;
  const host=new URL(original).hostname.replace(/^www\./,"");
  if(["github.com","huggingface.co","news.ycombinator.com","hnrss.org"].includes(host))return true;
  const feedHost=new URL(items.url!).hostname.replace(/^www\./,"");
  const registrable=(h:string)=>/\.(?:com|org|net)\.cn$|\.co\.uk$|\.co\.jp$|\.com\.au$/.test(h)?h.split(".").slice(-3).join("."):h.split(".").slice(-2).join(".");
  if(registrable(host)===registrable(feedHost))return true;
  const migratedPublishers:Record<string,string[]>={
    "qbitai.cn":["qbitai.com"],"andrewchen.co":["andrewchen.com"],
    "githubengineering.com":["github.blog"],"shopifyengineering.myshopify.com":["shopify.engineering"],
    "interaction-design.org":["ixdf.org"],"feeds.feedburner.com":["spring.org.uk"],
    "microsoft.github.io":["github.com"],
  };
  if(migratedPublishers[host]?.includes(feedHost))return true;
  if(feedHost===host||feedHost.endsWith("."+host)||["feedburner.com","feeds.feedburner.com"].includes(feedHost))return true;
  if(/rsshub|rssforever|rss\.site|rsshub\.app/.test(feedHost))return true;
  return items.samples.some(x=>{const h=new URL(x.url).hostname.replace(/^www\./,"");return h===host||h.endsWith("."+host);});
}
const catalogPlans:Record<string,Record<string,unknown>>={
  "v2-source-27":{type:"forum",required:"Explicit Intel forum/board watchlist and original post timestamps",suggested:"Reuse existing Cloud/AI Khoros adapters; do not relabel entire community navigation as news"},
  "v2-source-28":{type:"research_portal",required:"A verified DAMO research/news listing and original publication dates",suggested:"Monitor DAMO news/research output as isolated resources"},
  "v2-source-38":{type:"newsletter_issue",required:"Current issue RSS rather than permanently revisiting issue 736",suggestedFeed:"https://frontendfoc.us/rss"},
  "v2-source-41":{type:"repository_catalog",required:"User-defined GitLab repository/release watchlist",suggested:"GitLab project releases API or project Atom feeds"},
  "v2-source-44":{type:"container_catalog",required:"User-defined image repository/tag watchlist",suggested:"Docker Hub repository tags API; retain actual last_updated timestamp"},
  "v2-source-47":{type:"model_catalog",required:"Model tag/owner watchlist; catalog records remain isolated",suggested:"Hugging Face public models API with createdAt/lastModified provenance"},
  "v2-source-71":{type:"package_catalog",required:"Explicit Python package watchlist",suggested:"PyPI package release RSS/JSON; retain release upload_time"},
  "v2-source-129":{type:"thesis_catalog",required:"Verified thesis records and original record publication dates",suggested:"Dedicated thesis list parser; never promote site navigation as article"},
  "v2-source-146":{type:"package_catalog",required:"Explicit npm package watchlist",suggested:"npm registry package version/time API"},
  "v2-source-180":{type:"podcast",required:"Verified per-episode list/feed with original audio/title/date",suggested:"Podcast-specific episode adapter; isolated resource lane"},
};
const catalogPresentation:Record<string,{category:string;description:string;publicUrl:string}>={
  "v2-source-27":{category:"社区技术博客",description:"监测 Intel Community 公开博客记录，保留文章原始发表时间，作为独立技术资源展示。",publicUrl:"https://community.intel.com/t5/Blogs/ct-p/Blogs"},
  "v2-source-28":{category:"研究机构资源",description:"达摩院官网参考入口。当前页面未检出稳定的成果列表，暂保留官网链接供人工查看。",publicUrl:"https://damo.alibaba.com/"},
  "v2-source-38":{category:"开发者期刊",description:"监测 Frontend Focus 最新期刊及原始发行日期，已改用持续更新的期刊入口。",publicUrl:"https://frontendfoc.us/"},
  "v2-source-41":{category:"开源项目目录",description:"监测 GitLab 标记 machine-learning 的公共项目，按项目实际创建时间展示；不代表全部 AI 项目。",publicUrl:"https://gitlab.com/explore/projects/topics/machine-learning"},
  "v2-source-44":{category:"容器资源",description:"监测 vLLM 官方 vllm/vllm-openai 容器标签及实际推送时间，可扩展关注对象；当前不监听整个 Docker Hub。",publicUrl:"https://hub.docker.com/r/vllm/vllm-openai/tags"},
  "v2-source-47":{category:"模型资源",description:"监测 Hugging Face 公共模型目录中的最新创建记录，展示模型标识与原始创建时间。",publicUrl:"https://huggingface.co/models"},
  "v2-source-71":{category:"开发组件",description:"读取 PyPI 全站软件包更新元数据及原始更新日期，作为开发资源动态展示。",publicUrl:"https://pypi.org/"},
  "v2-source-129":{category:"学术资源",description:"论文目录参考入口。已解析到记录标题和链接，但缺少原始发布日期，暂不自动导入时间线。",publicUrl:"https://www.linkresearcher.com/theses"},
  "v2-source-146":{category:"开发组件",description:"监测 npm 公共目录中 AI 关键词的软件包元数据和版本日期，范围限定为该检索结果。",publicUrl:"https://www.npmjs.com/search?q=keywords%3Aai"},
  "v2-source-180":{category:"播客资源",description:"监测原配置小宇宙播客的公开节目标题、链接和原始发布时间，仅覆盖该播客。",publicUrl:"https://www.xiaoyuzhoufm.com/podcast/667d1ecfc13b46d76c3f64b8"},
};
const jsonPlans:Record<string,Adapter>={
  "v2-source-638":{kind:"json_list",config:{url:"https://agent.me.news/skill/aimpact/articles?page=1&size=8&category=ai",itemsPath:"data.list",titlePaths:["title"],urlTemplate:"{raw:source_url}",urlTemplateFallback:"https://www.me.news/aimpact/articles/{id}",publishedAtPath:"published_at",publishedAtUtcOffset:"+08:00",summaryPaths:["summary","content"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-213330":{kind:"json_list",config:{url:"https://agent.me.news/skill/flash/list?page=1&size=8&category=ai",itemsPath:"items",titlePaths:["title"],urlTemplate:"{raw:source_url}",urlTemplateFallback:"{raw:url}",publishedAtPath:"published_at",publishedAtUtcOffset:"+08:00",summaryPaths:["summary","content"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-49165":{kind:"json_list",config:{url:"https://community.intel.com/api/2.0/search?q="+encodeURIComponent("select * from messages where board.id = 'blog-cloud' and depth = 0 order by post_time desc limit 8"),itemsPath:"data.items",titlePaths:["subject"],urlTemplate:"{raw:view_href}",publishedAtPath:"post_time",summaryPaths:["teaser","search_snippet"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-49166":{kind:"json_list",config:{url:"https://community.intel.com/api/2.0/search?q="+encodeURIComponent("select * from messages where board.id = 'blog-ai' and depth = 0 order by post_time desc limit 8"),itemsPath:"data.items",titlePaths:["subject"],urlTemplate:"{raw:view_href}",publishedAtPath:"post_time",summaryPaths:["teaser","search_snippet"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-176":{kind:"json_list",config:{url:"https://www.vodafone.com/news/newsroom?async=1&page=1&categories=*&tags=*&year=*&sortorder=desc&search=*&freetext=*",itemsPath:"data",titlePaths:["newsTitle"],urlTemplate:"https://www.vodafone.com{raw:newsUrl}",urlTemplateFallback:"https://www.vodafone.com/news/newsroom/{newsSlug}",publishedAtPath:"newsDate",publishedAtUtcOffset:"+00:00",summaryPaths:["newsDesc"],_aihot:{initialBackfillLimit:2}}},
  "v2-source-32":{kind:"json_list",config:{url:"https://dev.to/api/articles?top=7&per_page=8",titlePaths:["title"],urlTemplate:"{raw:url}",publishedAtPath:"published_at",summaryPaths:["description"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-47":{kind:"json_list",config:{url:"https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=8&full=true",titlePaths:["id"],urlTemplate:"https://huggingface.co/{raw:id}",publishedAtPath:"createdAt",externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-41":{kind:"json_list",config:{url:"https://gitlab.com/api/v4/projects?topic=machine-learning&visibility=public&order_by=created_at&sort=desc&per_page=8&simple=true",titlePaths:["name_with_namespace","name"],urlTemplate:"{raw:web_url}",publishedAtPath:"created_at",summaryPaths:["description"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-27":{kind:"json_list",config:{url:"https://community.intel.com/api/2.0/search?q="+encodeURIComponent("select * from messages where depth = 0 and conversation.style = 'blog' order by post_time desc limit 8"),itemsPath:"data.items",titlePaths:["subject"],urlTemplate:"{raw:view_href}",publishedAtPath:"post_time",summaryPaths:["teaser","search_snippet"],externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-44":{kind:"json_list",config:{url:"https://hub.docker.com/v2/repositories/vllm/vllm-openai/tags?page_size=8&ordering=last_updated",itemsPath:"results",titlePaths:["name"],urlTemplate:"https://hub.docker.com/r/vllm/vllm-openai/tags?name={name}",publishedAtPath:"tag_last_pushed",externalIdPath:"id",_aihot:{initialBackfillLimit:2}}},
  "v2-source-180":{kind:"json_list",config:{url:"https://www.xiaoyuzhoufm.com/podcast/667d1ecfc13b46d76c3f64b8",mode:"html_json_key",jsonKey:"episodes",titlePaths:["title"],urlTemplate:"https://www.xiaoyuzhoufm.com/episode/{eid}",publishedAtPath:"pubDate",summaryPaths:["description"],externalIdPath:"eid",_aihot:{initialBackfillLimit:2}}},
  "v2-source-146":{kind:"json_list",config:{url:"https://registry.npmjs.org/-/v1/search?text=keywords:ai&size=8&from=0",itemsPath:"objects",titlePaths:["package.name"],urlTemplate:"{raw:package.links.npm}",publishedAtPath:"package.date",summaryPaths:["package.description"],externalIdPath:"package.name",_aihot:{initialBackfillLimit:2}}},
  "v2-source-58457":{kind:"json_list",config:{url:"https://www.zte.com.cn/bin/articleList",method:"POST",bodyJson:{basePath:"/content/zte-site/www-zte-com-cn/global/about/magazine/zte-technologies",primaryType:"cq:Page",pageType:"article",orderBy:"jcr:content/createDate",sortOrder:"desc",offset:0,limit:8,resourceType:"'zte-site/components/structure/communication-detail-page'",createDateStart:"2026-01-01",createDateEnd:"2026-12-31"},itemsPath:"results.results",titlePaths:["jcr:content/pageTitle","name"],urlTemplate:"https://www.zte.com.cn{raw:path}.html",itemUrlPrefixRewrite:{from:"https://www.zte.com.cn/content/zte-site/www-zte-com-cn/",to:"https://www.zte.com.cn/"},publishedAtPath:"jcr:content/createDate",publishedAtUtcOffset:"+08:00",externalIdPath:"path",_aihot:{initialBackfillLimit:2}}},
};
function get(obj:any,key:string):any{return key.split(".").reduce((x,k)=>x?.[k],obj);}
function arrayForKey(obj:any,key:string,depth=0):any[]|null{if(depth>12||!obj||typeof obj!=="object")return null;if(Array.isArray(obj[key]))return obj[key];for(const value of Object.values(obj)){const found=arrayForKey(value,key,depth+1);if(found)return found;}return null;}
function render(template:string,record:any):string|null {let missing=false;const out=template.replace(/\{(raw:)?([^}]+)\}/g,(_m,raw,key)=>{const x=get(record,key);if(x===null||x===undefined||x===""){missing=true;return "";}return raw?String(x):encodeURIComponent(String(x));});return missing?null:out;}
async function probeJson(adapter:Adapter):Promise<Check>{
  const c=adapter.config,url=String(c.url);
  try {
    const res=await guardedFetch(url,{timeoutMs:15_000,maxBytes:8*1024*1024,maxRedirects:3,method:c.method?String(c.method):"GET",body:c.bodyJson?JSON.stringify(c.bodyJson):undefined,headers:{accept:"application/json",...(c.bodyJson?{"content-type":"application/json"}:{})}});
    if(res.status!==200)return {...checked("http_error",`HTTP ${res.status}`),url,httpStatus:res.status};
    let data:any;
    if(c.mode==="html_json_key"){
      const $=cheerio.load(res.text());
      for(const el of $('script[type="application/json"],script#__NEXT_DATA__').toArray()){
        try{const found=arrayForKey(JSON.parse($(el).text()),String(c.jsonKey));if(found){data={[String(c.jsonKey)]:found};break;}}catch{}
      }
      if(!data)throw new Error("Explicit public JSON script array is not present in the HTML response");
    }else data=JSON.parse(res.text());
    const rows=c.itemsPath?get(data,String(c.itemsPath)):c.jsonKey?get(data,String(c.jsonKey)):data;
    if(!Array.isArray(rows))return {...checked("parse_or_network_error","JSON itemsPath is not an array"),url,httpStatus:res.status};
    const items:Item[]=rows.flatMap((r:any)=>{
      const title=cleanTitle((c.titlePaths as string[]).map(p=>get(r,p)).find(Boolean));
      let rendered=render(String(c.urlTemplate),r)??(c.urlTemplateFallback?render(String(c.urlTemplateFallback),r):null);
      const rewrite=c.itemUrlPrefixRewrite as {from:string;to:string}|undefined;
      if(rendered&&rewrite&&rendered.startsWith(rewrite.from))rendered=rewrite.to+rendered.slice(rewrite.from.length);
      const target=safePublic(rendered);
      const rawDate=get(r,String(c.publishedAtPath??""));
      const normalizedDate=typeof rawDate==="string"&&/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(rawDate)&&!/[zZ]|[+-]\d{2}:?\d{2}$/.test(rawDate)?rawDate.replace(" ","T")+String(c.publishedAtUtcOffset??"+00:00"):rawDate;
      const date=c.publishedAtUnit==="epoch_s"||c.publishedAtUnit==="epoch_ms"?Number.isFinite(Number(rawDate))?new Date(Number(rawDate)*(c.publishedAtUnit==="epoch_s"?1000:1)).toISOString():null:parseDate(normalizedDate);
      return title.length>=4&&target?[{title,url:target,publishedAt:date}]:[];
    });
    return success(url,res.status,items,"Public JSON array mapped using explicit title/URL/publication-date fields; no synthetic crawl-time dates");
  }catch(e){return {...checked("parse_or_network_error",safeError(e)),url};}
}
async function probeConfiguredWeb(source:any,adapter:Adapter):Promise<Check>{
  const c=adapter.config,url=safePublic(c.url);
  if(!url||url.startsWith("https://r.jina.ai/"))return checked("private_or_paid_transport","This probe only reads safe public listings without a paid reader");
  try{
    const res=await guardedFetch(url,{timeoutMs:15_000,maxBytes:8*1024*1024,maxRedirects:3,headers:{accept:"text/html,application/xhtml+xml"}});
    if(res.status!==200)return {...checked("http_error",`HTTP ${res.status}`),httpStatus:res.status,url};
    const final=safePublic(res.url)??url;
    let items:Item[]=[];
    if(c.parseMode==="docusaurus_changelog"){
      const $=cheerio.load(res.text());let sectionDate:string|null=null;
      for(const node of $("article h2[id],article h3[id],.markdown h2[id],.markdown h3[id]").toArray()){
        const heading=$(node),title=cleanTitle(heading.text().replace(/\u200b/g,"").replace(/#$/,"")),id=heading.attr("id");
        const match=/^(?:[^\d:：]{1,12}[:：])?\s*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(title);
        if(match){sectionDate=parseDate(`${match[1]}-${match[2]!.padStart(2,"0")}-${match[3]!.padStart(2,"0")}T00:00:00${c.publishedAtUtcOffset??"+08:00"}`);continue;}
        if(heading.is("h2"))sectionDate=null;
        if(title.length>=4&&id)items.push({title,url:new URL(`#${id}`,final).toString(),publishedAt:sectionDate});
      }
    }else{
      // Use the production pure HTML parser; this import performs no SQL or provider requests.
      const {fromHtml}=await import("../packages/backend/src/sources/web-list.ts");
      const candidates=fromHtml(res.text(),String(c.baseUrl??final),{...source,kind:"web_list",config:c,cursor:null,fail_count:0});
      items=candidates.flatMap(x=>{const target=safePublic(x.url);return target&&articleUrl(target)&&cleanTitle(x.title).length>=4?[{title:cleanTitle(x.title),url:target,publishedAt:x.publishedAt?.toISOString()??null}]:[];});
    }
    return success(final,res.status,items,"Existing native profile parsed using its actual selectors or changelog sections; absent publication dates remain null");
  }catch(e){return {...checked("parse_or_network_error",safeError(e)),url};}
}
async function inspect(source:any):Promise<AuditRow>{
  const row=v2.get(source.id),base={sourceId:source.id,name:source.name,previousEnabled:source.enabled,v2Status:row?.status??null,accessMethod:row?.access_method??null};
  if(preserveDisabledSourceIds.includes(source.id))return {...base,profile:{policy:"blocked",participationMode:"editorial",frozen:true,verification:checked("not_requested","Original paused source is frozen; no network probe"),reason:"preserve_original_paused"}};
  const nonArticle=row?.status==="非文章页";
  const configured=oldProfiles[source.id];
  if(configured?.policy==="native"&&configured.adapter&&configured.adapter.kind!=="mp_account"){
    const adapter=configured.adapter;
    const check=adapter.kind==="rss"?safePublic(adapter.config.feedUrl)?await probeFeed(String(adapter.config.feedUrl)):checked("private_transport","Public feed route is unavailable")
      :adapter.kind==="json_list"?await probeJson(adapter):adapter.kind==="web_list"?await probeConfiguredWeb(source,adapter):checked("adapter_required","Native route needs a dedicated verifier");
    const verified=check.status==="verified"&&(!nonArticle||!!check.datedItems);
    return {...base,profile:{...configured,policy:verified?"native":nonArticle?"blocked":"bridge",adapter:verified?adapter:undefined,verification:check,fallback:verified?undefined:"Configured native route failed the bounded recheck; preserve an explicit dependency status until reviewed"}};
  }
  if(nonArticle){
    if(source.id==="v2-source-71"){
      const url="https://pypi.org/rss/updates.xml",check=await probeFeed(url);
      return {...base,profile:{policy:check.status==="verified"&&check.datedItems?"native":"blocked",nonArticle:true,participationMode:"isolated",adapter:check.status==="verified"&&check.datedItems?{kind:"rss",config:{feedUrl:url,_aihot:{initialBackfillLimit:2}}}:undefined,verification:check,catalogPlan:{...catalogPlans[source.id],scope:"PyPI global package update metadata; no invented package watchlist and no editorial admission"}}};
    }
    if(jsonPlans[source.id]){
      const adapter=jsonPlans[source.id],check=await probeJson(adapter);
      const scope:Record<string,Record<string,unknown>>={
        "v2-source-41":{scope:"Public GitLab projects explicitly assigned topic=machine-learning; newest first by actual project created_at. Exact topic=ai returned no records during admission",provenance:"https://docs.gitlab.com/api/topics/#list-all-projects-assigned-to-a-topic"},
        "v2-source-27":{scope:"Unauthenticated public Intel Community blog records only (depth=0, conversation.style=blog); forum resource lane with original post_time"},
        "v2-source-44":{scope:"vLLM official vllm/vllm-openai container tags only; watch targets may be extended",provenance:"https://docs.vllm.ai/en/stable/deployment/docker/",timestampMeaning:"Original tag_last_pushed is an artifact update time, not a synthetic first-release date"},
        "v2-source-146":{scope:"npm public package search with keywords:ai; resource metadata, not curated news"},
        "v2-source-47":{scope:"Public Hugging Face model catalog, newest createdAt records; not a claim of complete model coverage"},
        "v2-source-180":{scope:"Episodes from the configured podcast only; preserve public pubDate, never crawl private subscriptions"},
      };
      return {...base,profile:{policy:check.status==="verified"&&check.datedItems?"native":"blocked",nonArticle:true,participationMode:"isolated",adapter:check.status==="verified"&&check.datedItems?adapter:undefined,verification:check,catalogPlan:{...catalogPlans[source.id],...scope[source.id]}}};
    }
    if(source.id==="v2-source-28"||source.id==="v2-source-129"){
      const original=safePublic(row.original_url)!;
      const pattern=source.id==="v2-source-28"?"^https://damo\\.alibaba\\.com/(?:news|research)/(?:detail/)?[^/?#]+":"^https://www\\.linkresearcher\\.com/(?:thesis|theses)/[^/?#]+";
      const web=await probeWeb(original,pattern);
      const check=web.check.status==="verified"&&!web.check.datedItems?{...web.check,status:"date_evidence_missing",reason:"Record URLs/titles parsed but original publication dates are absent; catalog admission is blocked"}:web.check;
      return {...base,profile:{policy:check.status==="verified"&&check.datedItems?"native":"blocked",nonArticle:true,participationMode:"isolated",adapter:check.status==="verified"&&check.datedItems?web.adapter:undefined,verification:check,catalogPlan:catalogPlans[source.id],reason:"A catalog listing must expose true record URLs/titles/dates before admission"}};
    }
    if(source.id==="v2-source-38"){
      const check=await probeFeed("https://frontendfoc.us/rss");
      if(check.status==="verified")return {...base,profile:{policy:"native",nonArticle:true,participationMode:"isolated",adapter:{kind:"rss",config:{feedUrl:"https://frontendfoc.us/rss",_aihot:{initialBackfillLimit:2}}},verification:check,catalogPlan:catalogPlans[source.id]}};
      return {...base,profile:{policy:"blocked",nonArticle:true,participationMode:"isolated",verification:check,catalogPlan:catalogPlans[source.id],reason:"newsletter_feed_unverified"}};
    }
    return {...base,profile:{policy:"blocked",nonArticle:true,participationMode:"isolated",verification:checked("catalog_requires_adapter","A resource catalog requires an explicit watchlist or verified record adapter; no fabricated article route"),reason:"catalog_requires_watchlist_or_adapter",catalogPlan:catalogPlans[source.id]}};
  }
  if(row?.access_method==="微信公众号(wx-cli)"){
    if(process.env.WX_CACHE_DIRECTORY){
      try{
        const {readWxCache}=await import("../packages/backend/src/sources/wx-cache.ts");
        const adapter={kind:"mp_account",config:{transport:"wx_cache",account:row.name,cacheDirectoryEnv:"WX_CACHE_DIRECTORY",limit:8,lookbackDays:7,fetchPublicContent:true}};
        const cache=readWxCache({config:adapter.config});
        const items=cache.candidates.flatMap(x=>{const url=safePublic(x.url);return url&&cleanTitle(x.title).length>=4?[{title:cleanTitle(x.title),url,publishedAt:x.publishedAt?.toISOString()??null}]:[];});
        const check={...success("",0,items,cache.stale?"Authorized public-account cache is stale (>48h); no cache writes or daemon calls":"Exact public account matched; only mmreader public articles read from query_only SQLite; original pub_time retained"),transport:"read-only-wx-public-account-cache",httpStatus:null};
        delete check.url;
        if(cache.stale)check.status="stale_cache";
        return {...base,profile:{policy:check.status==="verified"?"native":"bridge",participationMode:"editorial",adapter:check.status==="verified"?adapter:undefined,verification:check,fallback:check.status==="verified"?undefined:"V2 read-only bridge; current authorized cache has no fresh article candidates"}};
      }catch(e){return {...base,profile:{policy:"bridge",participationMode:"editorial",verification:{...checked("local_adapter_unavailable",safeError(e)),transport:"read-only-wx-public-account-cache"},fallback:"V2 readonly bridge; exact public account/cache table not verified"}};}
    }
    return {...base,profile:{policy:"bridge",participationMode:"editorial",verification:checked("local_adapter_pending","Independent wx_cli/cache route requires separate readonly credential/profile proof; no paid Dajiala request"),fallback:"V2 read-only bridge until independent local collector proof succeeds"}};
  }
  if(row?.credentials_redacted)return {...base,profile:{policy:"bridge",participationMode:"editorial",verification:checked("private_transport","Private feed or subscription identifier is not present in public profiles"),fallback:"V2 read-only bridge; private source URL is never copied"}};
  const feed=safePublic(source.kind==="rss"?source.config.feedUrl:row?.rss_url);
  const attempts:Check[]=[];
  if(jsonPlans[source.id]){
    const adapter=jsonPlans[source.id],check=await probeJson(adapter);attempts.push(check);
    if(check.status==="verified")return {...base,profile:{policy:"native",participationMode:"editorial",adapter,verification:check}};
  }
  if(feed){
    const check=await probeFeed(feed);attempts.push(check);
    if(check.status==="verified"&&feedIdentity(check,row))return {...base,profile:{policy:"native",participationMode:"editorial",adapter:{kind:"rss",config:{feedUrl:feed,_aihot:{initialBackfillLimit:2}}},verification:check}};
    if(check.status==="verified")attempts[0]={...check,status:"publisher_mismatch",reason:"Parsed feed samples belong to a different publisher than the named original source"};
  }
  const original=safePublic(row?.original_url),pattern=original?articleRules[new URL(original).hostname]:undefined;
  if(original&&pattern){
    const web=await probeWeb(original,pattern);attempts.push(web.check);
    if(web.check.status==="verified"&&web.adapter)return {...base,profile:{policy:"native",participationMode:"editorial",adapter:web.adapter,verification:{...web.check,attempts}}};
  }
  const check=attempts.at(-1)??checked("adapter_required","No safe public feed or explicit article listing parser is available");
  return {...base,profile:{policy:"bridge",participationMode:"editorial",verification:{...check,attempts},reason:"native_route_unverified",fallback:"V2 read-only bridge; this is collection eligibility, not proof of current origin-site collection"}};
}
const limitArg=process.argv.find(x=>x.startsWith("--limit="));
const onlyArg=process.argv.find(x=>x.startsWith("--ids="));
const mergeArgs=process.argv.filter(x=>x.startsWith("--merge-verified="));
const ids=onlyArg?new Set(onlyArg.slice(6).split(",")):null;
let jobs=mergeArgs.length?[]:[...canonical.values()].filter(s=>!ids||ids.has(s.id));
if(limitArg)jobs=jobs.slice(0,Number(limitArg.slice(8)));
const results:AuditRow[]=[];let next=0;
const progressPath=path.join(root,".data/qa/source-admission-progress.json");
mkdirSync(path.dirname(progressPath),{recursive:true});
if(args.has("--resume")){
  try{
    const prior=JSON.parse(readFileSync(progressPath,"utf8"));
    if(prior.networkPath===transport){
      for(const row of prior.sources??[])if(jobs.some(s=>s.id===row.sourceId))results.push(row);
      const complete=new Set(results.map(x=>x.sourceId));jobs=jobs.filter(s=>!complete.has(s.id));
    }
  }catch{}
}
const total=jobs.length+results.length;
await Promise.all(Array.from({length:4},async()=>{
  while(next<jobs.length){const source=jobs[next++];const result=await inspect(source);results.push(result);if(!args.has("--no-write"))writeFileSync(progressPath,JSON.stringify({generatedAt:new Date().toISOString(),networkPath:transport,sources:results})+"\n");if(results.length%20===0)console.log(JSON.stringify({checked:results.length,total,native:results.filter(x=>x.profile.policy==="native").length,transport}));}
}));
if(args.has("--no-write")){
  console.log(JSON.stringify({checked:results.length,native:results.filter(x=>x.profile.policy==="native").length,transport,sources:results.map(x=>({sourceId:x.sourceId,policy:x.profile.policy,status:x.profile.verification.status,items:x.profile.verification.items,datedItems:x.profile.verification.datedItems,reason:x.profile.verification.reason}))}));
  process.exit(0);
}
const profiles:Record<string,Profile> = ids||limitArg||mergeArgs.length?{...oldProfiles}:{};
for(const row of results)profiles[row.sourceId]=row.profile;
const payload={schemaVersion:1,generatedAt:new Date().toISOString(),networkPath:transport,preserveDisabledSourceIds,profiles};
writeFileSync(oldProfilesPath,JSON.stringify(payload,null,2)+"\n");
const auditPath=path.join(root,"docs/corescope-source-admission-audit.json");
let oldAuditRows:AuditRow[]=[];try{oldAuditRows=JSON.parse(readFileSync(auditPath,"utf8")).sources??[];}catch{}
const resultById=new Map((ids||limitArg||mergeArgs.length?oldAuditRows:[]).map(x=>[x.sourceId,x]));for(const x of results)resultById.set(x.sourceId,x);
for(const arg of mergeArgs){
  const file=path.resolve(root,arg.slice("--merge-verified=".length));
  if(!file.startsWith(root+path.sep))throw new Error("Verified audit merge must stay inside the CoreScope project");
  for(const entry of JSON.parse(readFileSync(file,"utf8"))){
    if(!canonical.has(entry.sourceId)||preserveDisabledSourceIds.includes(entry.sourceId)||entry.verification?.status!=="verified"||!entry.verification?.items||!entry.adapter)continue;
    if(!entry.verification.datedItems&&!/date/i.test(String(entry.verification.reason??"")))continue;
    const previous=resultById.get(entry.sourceId)!;
    const profile:Profile={policy:"native",participationMode:"editorial",adapter:entry.adapter,verification:{reason:"Explicit publisher-owned adapter validated against real public source responses",...entry.verification}};
    profiles[entry.sourceId]=profile;resultById.set(entry.sourceId,{...previous,profile});
  }
}
const sources=[...resultById.values()].sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
for(const row of sources){
  if(row.profile.adapter?.kind==="mp_account"){
    delete row.profile.adapter.config._aihot;
    profiles[row.sourceId]=row.profile;
  }
  if(row.profile.policy==="bridge"&&row.sourceId==="v2-source-183"){
    row.profile.bridgeIntakeUrlPrefixes=["https://qwen.ai/blog/","https://qwenlm.github.io/blog/"];
    row.profile.fallback="Only confirmed official Qwen blog article URL prefixes may enter through V2; unrelated ifanr feed items are refused";
    profiles[row.sourceId]=row.profile;
  }
  if(row.profile.policy==="bridge"&&row.sourceId==="v2-source-3335"){
    row.profile.bridgeIntakeUrlPrefixes=[];
    row.profile.verification.status="article_url_missing";
    row.profile.verification.reason="Relay samples point to Sogou search pages rather than original articles; original publisher identity is unproved";
    row.profile.fallback="Publisher identity of the old Sohu/relay entry is unproved; all bridge intake is refused until corrected. Exact public WeChat account is independently covered by v2-source-6834";
    profiles[row.sourceId]=row.profile;
  }
  if(row.profile.adapter?.kind==="rss"&&!safePublic(row.profile.adapter.config.feedUrl)){
    row.profile={policy:"bridge",participationMode:"editorial",verification:checked("private_transport","Opaque subscription/account feed route is not copied to public profiles"),fallback:"V2 readonly bridge; private route requires local-only configuration"};
    profiles[row.sourceId]=row.profile;
  }
  if(row.profile.nonArticle){
    const original=v2.get(row.sourceId);
    row.profile.catalogPlan={...row.profile.catalogPlan,...catalogPresentation[row.sourceId],title:row.sourceId==="v2-source-38"?"Frontend Focus · 最新期刊":row.name,publicUrl:catalogPresentation[row.sourceId]?.publicUrl??safePublic(original?.original_url),status:row.profile.policy==="native"?"connected":"reference",newsParticipation:"isolated"};
    profiles[row.sourceId]=row.profile;
  }
  if(row.profile.verification.status==="publisher_mismatch"){
    const original=v2.get(row.sourceId);
    const feed=safePublic(original?.rss_url);
    if(feed&&feedIdentity(row.profile.verification,original)){
      row.profile={policy:"native",participationMode:"editorial",adapter:{kind:"rss",config:{feedUrl:feed,_aihot:{initialBackfillLimit:2}}},verification:{...row.profile.verification,status:"verified",reason:"Parsed public RSS is the same publisher, including documented legacy domain/official repository migration"}};
      profiles[row.sourceId]=row.profile;
    }else if(!feed){
      row.profile={policy:"bridge",participationMode:"editorial",verification:checked("private_transport","Opaque subscription/account feed route is not copied to public profiles"),fallback:"V2 readonly bridge; private route requires local-only configuration"};
      profiles[row.sourceId]=row.profile;
    }
  }
  if(row.profile.nonArticle&&row.profile.policy==="blocked"&&row.profile.verification.status==="verified"&&!row.profile.verification.datedItems){
    row.profile.verification.status="date_evidence_missing";
    row.profile.verification.reason="True record URLs and titles were found, but authoritative original dates were not exposed; resource route stays blocked";
    profiles[row.sourceId]=row.profile;
  }
  const scrubCheck=(check:Check)=>{
    if(check.url&&!safePublic(check.url))delete check.url;
    for(const attempt of check.attempts??[])scrubCheck(attempt);
  };
  scrubCheck(row.profile.verification);
}
writeFileSync(oldProfilesPath,JSON.stringify({...payload,profiles},null,2)+"\n");
const summary={configuredSources:canonical.size,checkedSources:sources.length,native:sources.filter(x=>x.profile.policy==="native").length,bridge:sources.filter(x=>x.profile.policy==="bridge").length,blocked:sources.filter(x=>x.profile.policy==="blocked").length,pausedPreserved:preserveDisabledSourceIds.length,nonArticle:sources.filter(x=>x.profile.nonArticle).length,paidRequests:0,modelRequests:0,v2Writes:0};
writeFileSync(auditPath,JSON.stringify({schemaVersion:1,generatedAt:payload.generatedAt,networkPath:transport,method:"4 concurrent sources, 15s per request, at most feed + explicit original list; no body/model/paid-provider fetch",summary,sources},null,2)+"\n");
console.log(JSON.stringify(summary));
