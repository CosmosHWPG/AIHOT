// Routine publisher bodies use ordinary queues, unknown future IDs, and offline responses only.
import { gate, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { extractArticleBody, extractFromUrl } from '@aihot/backend/content/extract';
import { sanitizeFeedBody } from '@aihot/backend/content/feed-body';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { sha256 } from '@aihot/backend/lib/ids';
import { queueProcessing } from '@aihot/backend/jobs/content';
import { getBoss, stopBoss } from '@aihot/backend/jobs/queue';
import { RECENT_CONTENT_POLICY_KEY, setRecentContentPolicy, invalidateRecentContentCache } from '@aihot/backend/jobs/recent-content';

const prefix=tag(), sourceIds=[`${prefix}-routine-a`,`${prefix}-routine-b`], ids:string[]=[];
let mock:MockAgent, oldProxy:string|null, oldPrivate:boolean, savedPolicy:any[]=[], apiHits=0, jinaHits=0, counter=850000;
const previousDispatcher=getGlobalDispatcher();
const raw='<h2>Measured model engineering</h2><p>Independent research describes verified acoustic model architecture, reproducible evidence and its limitations.</p>'.repeat(7)
  +'<p>The investigation concludes with the observed engineering tradeoffs.</p>';
before(async()=>{
  oldProxy=config.egressProxyUrl;oldPrivate=config.allowPrivateNetworkFetch;
  config.egressProxyUrl=null;config.allowPrivateNetworkFetch=true;
  mock=new MockAgent();mock.disableNetConnect();setGlobalDispatcher(mock);
  process.env.JINA_BASE_URL='https://jina.example.com';process.env.JINA_API_KEY='offline-routine-only';
  mock.get('https://jina.example.com').intercept({path:/.*/}).reply(()=>{jinaHits++;return{statusCode:200,data:'Forbidden paid fallback'};}).persist();
  await getBoss();savedPolicy=await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await setRecentContentPolicy(true,'offline-test','Keep the existing rolling processing window');
  for(const id of sourceIds)await sql`INSERT INTO sources(id,name,kind,enabled,tier,participation_mode,first_party,site_fulltext,syndicate_fulltext,config)
    VALUES(${id},'Original collector identity','rss',true,'T2','editorial',false,false,false,'{}')`;
});
afterEach(async()=>{
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  await sql`UPDATE sources SET config='{}',enabled=true,participation_mode='editorial' WHERE id=ANY(${sourceIds}::text[])`;
  ids.length=0;invalidateRecentContentCache();assert.equal(jinaHits,0);
});
after(async()=>{
  await sql`DELETE FROM sources WHERE id=ANY(${sourceIds}::text[])`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for(const row of savedPolicy)await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value)},${row.updated_by},${row.updated_at})`;
  await stopBoss();await closeDb();setGlobalDispatcher(previousDispatcher);await mock.close();
  config.egressProxyUrl=oldProxy;config.allowPrivateNetworkFetch=oldPrivate;
});
type Adapter='doublepulsar'|'mittrchina'|'speechhome';
async function fixture(adapter:Adapter='mittrchina'){
  const number=String(++counter), title=`Original ${adapter} measured engineering report ${number}`;
  const url=adapter==='doublepulsar'?`https://doublepulsar.com/routine-engineering-report-${number.padStart(12,'a')}`
    :adapter==='mittrchina'?`https://www.mittrchina.com/news/detail/${number}`:`https://speechhome.com/post/21161164443${number}`;
  const result=await upsertMaterial({sourceId:sourceIds[0]!,url,title,author:'Original collector author',publishedAt:new Date(Date.now()-3600000),
    excerpt:'Original listing summary',bodyText:'A collector preview with partial content that must not prevent the approved routine body route.',bodyStatus:'pending',via:'fetch'});
  ids.push(result.articleId);await sql`UPDATE articles SET processing_attempt_tag='existing-evaluation' WHERE id=${result.articleId}`;
  const body=sanitizeFeedBody(raw,url);
  const response=adapter==='mittrchina'?{code:10000,data:{id:Number(number),name:title,status:1,is_vip:2,content:raw}}
    :{status:200,data:{isSucceed:true,result:{id:new URL(url).pathname.split('/').at(-1),title,statusCode:0,content:raw}}};
  const endpoint=adapter==='mittrchina'?`https://apii.web.mittrchina.com/information/details?id=${number}`
    :`https://speechhome.com/api/api/post/detail/${new URL(url).pathname.split('/').at(-1)}`;
  return{id:result.articleId,url,title,adapter,body,response,endpoint};
}
function reply(f:Awaited<ReturnType<typeof fixture>>,payload:unknown=f.response){
  const url=new URL(f.endpoint);mock.get(url.origin).intercept({path:url.pathname+url.search}).reply(()=>{
    apiHits++;return{statusCode:200,data:JSON.stringify(payload),responseOptions:{headers:{'content-type':'application/json'}}};
  });
}
const frozen=async(id:string)=>(await sql`SELECT a.source_id,a.url,a.title,a.author,a.published_at,a.processing_attempt_tag,
 s.site_fulltext,s.syndicate_fulltext,s.first_party,s.participation_mode,s.tier,s.config FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${id}`)[0];
async function successfulQueueFlow(f:Awaited<ReturnType<typeof fixture>>){
  const before=await frozen(f.id),beforeHits=apiHits;
  const jobId=await queueProcessing(f.id);assert.ok(jobId);
  const [queued]=await sql`SELECT name,data FROM pgboss.job WHERE id=${jobId!}`;
  assert.equal(queued!.name,'content.extract-body');assert.equal(queued!.data.articleId,f.id);
  assert.equal(await extractArticleBody(f.id,true),'ok');assert.deepEqual(await frozen(f.id),before);
  const [saved]=await sql`SELECT revision,body_text,body_status,processing_state FROM articles WHERE id=${f.id}`;
  assert.equal(saved!.revision,2);assert.equal(saved!.body_status,'ok');assert.equal(saved!.body_text,f.body.text);assert.equal(saved!.processing_state,'new');
  const audits=await sql`SELECT after FROM audit_log WHERE action='content.body-restored' AND subject=${'content:'+f.id}`;
  assert.equal(audits.length,1);assert.equal(audits[0]!.after.scope,'routine');assert.equal(audits[0]!.after.allowJina,false);
  assert.equal(audits[0]!.after.bodySha256,sha256(f.body.text));assert.ok(audits[0]!.after.routeId);
  const analyzeJob=await queueProcessing(f.id);assert.ok(analyzeJob);
  const [analysis]=await sql`SELECT name,data FROM pgboss.job WHERE id=${analyzeJob!}`;
  assert.equal(analysis!.name,'content.analyze');assert.equal(analysis!.data.attemptTag,'existing-evaluation');
  assert.equal(await extractArticleBody(f.id,true),'skipped');assert.equal(apiHits,beforeHits+(f.adapter==='doublepulsar'?0:1));
  assert.equal((await sql`SELECT revision FROM articles WHERE id=${f.id}`)[0]!.revision,2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM settings WHERE key LIKE 'content.processing-recovery.%'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(value->'members') m WHERE m->>'articleId'=${f.id})`)[0]!.n,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE service='jina' AND subject=${'article:'+f.id}`)[0]!.n,0);
}

test('future DoublePulsar RSS items extract normally without a batch/hash and missing items never buy Jina',async()=>{
  const f=await fixture('doublepulsar'),missing=await fixture('doublepulsar');
  const xml=`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Approved publisher</title><item><title>${f.title}</title><link>${f.url}?source=rss----8343faddf0ec---4</link><content:encoded><![CDATA[${raw}]]></content:encoded></item></channel></rss>`;
  mock.get('https://doublepulsar.com').intercept({path:'/feed'}).reply(200,xml,{headers:{'content-type':'application/rss+xml'}});
  await successfulQueueFlow(f);
  assert.equal(await extractArticleBody(missing.id,true),'unconfirmed');assert.equal(jinaHits,0);
});
for(const adapter of ['mittrchina','speechhome'] as const)test(`future ${adapter} unknown IDs pass normal queue, extraction, audit and analysis handoff without a fixed plan`,async()=>{
  const f=await fixture(adapter);reply(f);await successfulQueueFlow(f);
});
for(const adapter of ['mittrchina','speechhome'] as const)test(`${adapter} invalid public detail remains unconfirmed and never falls back to Jina`,async()=>{
  const f=await fixture(adapter);reply(f,{});const before=await frozen(f.id);
  assert.equal(await extractArticleBody(f.id,true),'unconfirmed');assert.deepEqual(await frozen(f.id),before);
  assert.equal((await sql`SELECT revision FROM articles WHERE id=${f.id}`)[0]!.revision,1);
});
test('unsupported publisher paths still cannot use the generic Jina fallback',async()=>{
  for(const origin of ['https://doublepulsar.com','https://www.mittrchina.com','https://speechhome.com']){
    const path=`/unsupported-${prefix}`;
    mock.get(origin).intercept({path}).reply(200,'<html><body><div id="app"></div></body></html>',{headers:{'content-type':'text/html'}});
    const result=await extractFromUrl(origin+path,{allowJina:true,subject:`offline:${prefix}`});
    assert.equal(result.body,null);assert.equal(jinaHits,0);
  }
});
for(const change of ['paused','noneditorial'] as const)test(`${change} sources cannot acquire a routine body`,async()=>{
  const f=await fixture();reply(f);const beforeHits=apiHits;
  if(change==='paused')await sql`UPDATE sources SET enabled=false WHERE id=${sourceIds[0]!}`;
  else await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${sourceIds[0]!}`;
  assert.equal(await extractArticleBody(f.id,true),'skipped');assert.equal(apiHits,beforeHits);
  assert.equal((await sql`SELECT revision,body_status FROM articles WHERE id=${f.id}`)[0]!.revision,1);
});
for(const change of ['source','config','revision','url','paused','noneditorial'] as const)test(`${change} drift while native HTTP is in flight cannot write a stale routine body`,async()=>{
  const f=await fixture(),entered=gate(),url=new URL(f.endpoint);
  mock.get(url.origin).intercept({path:url.pathname+url.search}).reply(()=>{
    entered.open();return{statusCode:200,data:JSON.stringify(f.response),responseOptions:{headers:{'content-type':'application/json'}}};
  }).delay(180);
  const pending=extractArticleBody(f.id,true);
  await Promise.race([entered.promise,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('No local native dispatch')),5000);t.unref();})]);
  if(change==='source')await sql`UPDATE articles SET source_id=${sourceIds[1]!} WHERE id=${f.id}`;
  if(change==='config')await sql`UPDATE sources SET config='{"changed":true}' WHERE id=${sourceIds[0]!}`;
  if(change==='revision')await sql`UPDATE articles SET revision=revision+1 WHERE id=${f.id}`;
  if(change==='url')await sql`UPDATE articles SET url=${f.url+'?changed=1'} WHERE id=${f.id}`;
  if(change==='paused')await sql`UPDATE sources SET enabled=false WHERE id=${sourceIds[0]!}`;
  if(change==='noneditorial')await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${sourceIds[0]!}`;
  assert.equal(await pending,'skipped');
  const [saved]=await sql`SELECT body_status,body_text FROM articles WHERE id=${f.id}`;
  assert.equal(saved!.body_status,'pending');assert.notEqual(saved!.body_text,f.body.text);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.body-restored' AND subject=${'content:'+f.id}`)[0]!.n,0);
});
