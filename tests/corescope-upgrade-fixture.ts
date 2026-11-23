// Synthetic upgrade fixture. No application/provider imports and no production configuration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';

export const LEGACY_SQL_SHA256: Readonly<Record<string,string>> = {
  "0001_core.sql": "ba4cf0e345f0eaab32fac9150aab87808b398e635a0103e37d5eee2ee7c3a75d",
  "0002_events_reports.sql": "c0263f26018628788e569893d42179df91ef08cd0134a545b535b727807b2951",
  "0003_monitor_leaderboard_notify.sql": "452070bf5615f78c47a363daf60e8508cdc1c03db7f10dea16c6772423f70209",
  "0004_admin_ops.sql": "ad435396e832f83653519b24f973ed71a7bef89688e44f3bfb2bf7fdf64bfb74",
  "0005_grouping_state.sql": "05b83d2e4af4e412d66166bd51b06e60e1e5dc97a3219a460b2eceb756d147bd",
  "0006_embeddings.sql": "f8ff46c206b7c2d70b0ad620f959a5c24b0f80e68e97d324a8bddf525a4566a0",
  "0007_leaderboard_prices.sql": "166ce24631a9b0bd49eb620d5eb55650d6c584a618547ac72af9425dad3dcfbe",
  "0008_monitor_display.sql": "6c4a2aa29b6a3f3316b10880a770d2b9c7083df2836b79e10e4462f9df65e2b9",
  "0009_selectbench.sql": "2b3ab0cd31660f469e2a7084cd95475e0961dc2449ad6983eaa22b63d94f90c5",
  "0010_service_prices.sql": "70d5124065dd842102e52cf2e097ba9374a3b1fb99d1d365a445efba1957087b",
  "0011_lb_alias_unique.sql": "069783d7ed49101c8aaebed9cf07eae988bf42111ec14a07893c33e296ddf5f9",
  "0013_translation_attempts.sql": "58ce72ace64056c56aa353e4c8e82852a186e884e8f9c5e1448f343011abc8e7",
  "0014_pool_search.sql": "45546c4abe1e2c7346c1c6ea608a37349687c8d8ddddfbac3ee6cfdb7953385c",
  "0015_pool_freshness_idx.sql": "91a897168dc017400c877b8db6a8f744f60079502843884f87979cae70ac1794",
  "0016_publication_fact_release_idx.sql": "0748c6ef30f8fc7b329524ee0e1e42873b15d27a51af3811a1e4356c671901f7",
  "0017_sitemap_idx.sql": "3868e8f38c061fd9990d875df601c5fabdf2b592a11506d8498288044d321c2e",
  "0018_publication_sort_at.sql": "139ec00a433381e952c2c27e688aa3f9aced7eefba1445f4a1b4a6e1c66e8452",
  "0019_seo_indexed.sql": "a7a93ed796a9a6ba4d788f56aa5b027738b1e1b1466d8e305c4e0db1a39c8afd",
  "0020_story_summary.sql": "f747851107388e5be3d56b1aa029c0326071c06461ae9b51907f310eb6012979",
  "0021_seo_auto_index.sql": "28ea4c10fef5d8fdbe40d062e46d6b4f64b13e72193cdb9208d2226cc4e9f4e0",
  "0022_receipt_attempts_budgets.sql": "deb8ed2a4770f995b04639456ed842f2f9992f01a2300d08a038f3943cfc8385",
  "0023_processing_retry.sql": "4563f5bc1da41e3e33f843705fbe38bcede8cea56ee9312dbe66e6c393b3fbd9",
  "0024_grouping_overrides_digest_inputs.sql": "8e9510af8f5059738d29a58f726549fd0d0ea962b9c983655bfe333d6b7a2a5f",
  "0026_source_icon_checked.sql": "4ed154a6ba499d8c062b66dae4a00c196cb5e9d5d86f6639a3e00841bbca8eeb",
  "0027_feedback_forward_error.sql": "eae7d9ae326433adb86d3fbb0830a3d33b06d6350ff8de2ceaf0cb43a56a79e5",
  "0028_selectbench_mean_score.sql": "3cd1fab13375a39a34413ddd17e0f0bc26d0f4fa1216ec6e3b19934268b08f4f",
  "0029_source_config_content_public.sql": "ba55d3cb46da31b83d799fa4474426745b098045dbb70c7c733ed8b6afa1453c",
  "0030_collection_url_index.sql": "29bdacc63c64916d86be0591308bdb9741034c6b79be5bd88b9af323e0ed0ea1",
  "0031_selected_ready_index.sql": "0fe7f6996930bcafbc4391ea5e3bd21df8c13a8dc310b5c4dd8c0422fc01b273",
  "0032_regroup_pending.sql": "aa7547725e449d6a842e8bfa4888e2a368d28456bb457c1f58252a2ee97e879f",
  "0033_receipt_budget_index.sql": "5374022dc798f0e53d65f1872193f8bc3012edae98e23bf950835a1d8248c567",
  "0034_lz4_toast.sql": "c8d50799c2f64a2ff20a642b1ee27069fb9a1ffe4ea6373380ea51536510bfee",
  "0036_open_source_defaults.sql": "5c119eab2d95997e9af067744ceb552f6078b611b2deb83396f7f8954a92e94b",
  "0037_x_article.sql": "ab21cc9e6d02f4276fea6f5d824809f3a7e6afa81c0fc6c000d5edafb7e1f163",
  "0038_quote_translations.sql": "32f9674ba2e80c6faa7e53836f6b6124f5dcdbec83539dcc3ebb21e5f36c6ebe",
  "0039_oss_recovery.sql": "e8c76634a6701a14d6ba53e3753d2b5b73ba321846be7ccd58c116d53f0bde6b",
  "0040_oss_domain_recovery.sql": "fb48fadb21585f057034aff4ece226c31b6d56679ff68d7019b9f1312567d89f",
  "0041_admin_session_binding.sql": "3a14da3cdef0402023e7b51ab7d23cd01f9c40fd5f9ede02430d68acc7a10fa3",
  "0042_corescope_v2_bridge.sql": "9d9a4a4a9741fce940c473dddbc36e543981792abfb1a8f9a20ee8c135642f64",
  "0043_xquik_credit_budget.sql": "d4c11eb0c2f7a3f47dd0ac9d8e581a8b94fa200d6c6fdc29bc957048069e9d70",
  "0044_bird_collection.sql": "7d8466b7c86c1e47dc48f1fa29c74c7de2728193ecac88485e4fc87f941ae717",
  "0045_event_capacity_deferrals.sql": "4f3e1a7480d14772c8b7e62f05a9791b504d4f5383dd3c50418407807baf55ab",
  "0046_recent_content_processing.sql": "2e964687b0778a6ce127df49fa9fc3679a306b2b0ad01c354b0fcebae1027a0e",
  "0047_budget_switch.sql": "4f824bdb014ab4c390634af578b3a86b927d8da5930f2f5d1af00530adcd79cb",
  "0048_article_body_failure_cache.sql": "407c510a7790905d3e039cf0dc0eee7880b935a09f586f5ca5cd764b6d678bcf"
};

export function legacyMigrationRoot(root: string, output: string): string {
  const target = path.join(output, 'database/migrations');
  mkdirSync(target, { recursive: true });
  for (const [name, expected] of Object.entries(LEGACY_SQL_SHA256)) {
    const file = path.join(root, 'database/migrations', name);
    const hash = createHash('sha256').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
    assert.equal(hash, expected, `historical CoreScope SQL changed: ${name}`);
    copyFileSync(file, path.join(target, name));
  }
  return output;
}

/** A few dozen synthetic rows spanning the exact legacy data the upstream deletes. All sources are paused. */
export async function seedUpgradeFixture(db: postgres.Sql): Promise<void> {
  await db.begin(async tx => {
    const [clock] = await tx<{ recent: Date }[]>`SELECT now()-interval '1 second' AS recent`;
    const recent = clock!.recent;
    await tx`INSERT INTO sources (id,name,kind,config,enabled,first_party,participation_mode,imported_from)
      VALUES ('upgrade-editorial','升级合成报道','rss','{"feedUrl":"https://example.invalid/feed"}',false,true,'editorial','synthetic legacy'),
             ('upgrade-signal','升级合成热度','x_search','{"query":"from:fixture -filter:replies","provider":"bird"}',false,false,'hot_signal','synthetic legacy'),
             ('upgrade-isolated','升级合成资料','external','{}',false,false,'isolated','synthetic legacy')`;
    await tx`INSERT INTO articles (id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_text,body_status,processing_state,grouped_at)
      VALUES ('upgrade-report','upgrade-editorial','url:upgrade-report','https://example.invalid/report','升级合成报道',now()-interval '1 hour',${recent},${recent},'Synthetic confirmed body','ok','analyzed',${recent}),
             ('upgrade-signal-item','upgrade-signal','x:upgrade-signal','https://x.com/fixture/status/1','Synthetic signal',now()-interval '1 hour',${recent},${recent},'Synthetic signal body','ok','analyzed',NULL),
             ('upgrade-unknown','upgrade-editorial','url:upgrade-unknown','https://example.invalid/unknown','Synthetic unresolved body',now()-interval '1 hour',${recent},${recent},NULL,'unconfirmed','failed',NULL)`;
    await tx`UPDATE articles SET processing_attempts=3,processing_retry_at=now()+interval '1 hour' WHERE id='upgrade-unknown'`;
    for (const [key,status] of [['completed','completed'],['unknown','unknown'],['failed','failed']] as const) {
      const [receipt] = await tx`INSERT INTO receipts (logical_key,service,purpose,subject,status,attempts,origin,request,response,usage,cost,currency,cost_basis)
        VALUES (${'upgrade-'+key},'jina','body_fallback','content:upgrade-unknown',${status},1,'live','{"synthetic":true}','{"text":"synthetic evidence"}','{"tokens":7}',0.125,'USD','actual') RETURNING id`;
      await tx`INSERT INTO receipt_attempts (receipt_id,attempt,service,status,origin,cost,currency,cost_basis,usage)
        VALUES (${receipt!.id},1,'jina',${status==='completed'?'received':status},'live',0.125,'USD','actual','{"tokens":7}')`;
    }
    await tx`INSERT INTO stories (id,public_id,title,status,latest,action,frame) VALUES (91001,'00000000-0000-4000-8000-000000091001','升级合成事件','watching','Legacy latest','legacy action','{"legacy":true}')`;
    await tx`INSERT INTO facts (id,public_id,story_id,title,version) VALUES (91001,'upgrade-fact',91001,'升级合成事实',7)`;
    await tx`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (91001,'upgrade-report','primary')`;
    await tx`INSERT INTO story_signals (story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES (91001,'upgrade-signal-item','author:fixture','upgrade-signal','signal',${recent})`;
    await tx`INSERT INTO story_digests (story_id,version,digest,latest,context_article_ids) VALUES (91001,1,'Synthetic digest','Legacy digest latest',ARRAY['upgrade-report'])`;
    await tx`INSERT INTO publications (article_id,visibility,eligible,selected,title,summary,score,source_id,channel,first_party,url,published_at,discovered_at,timeline_at,sort_at,visible_after,story_id,fact_id)
      VALUES ('upgrade-report','public',true,true,'升级合成报道','合成摘要',90,'upgrade-editorial','news',true,'https://example.invalid/report',now()-interval '1 hour',${recent},${recent},${recent},now()-interval '1 minute',91001,91001),
             ('upgrade-signal-item','public',false,false,'Synthetic signal',NULL,NULL,'upgrade-signal','x',false,'https://x.com/fixture/status/1',now()-interval '1 hour',${recent},${recent},${recent},NULL,91001,NULL)`;
    await tx`INSERT INTO embeddings (kind,ref_id,model,text_hash,vector) VALUES ('article','upgrade-report','synthetic-only','fixture-hash',ARRAY[1,0,0]::real[])`;
    await tx`INSERT INTO topics (slug,name,grp,tags,definition,position) VALUES ('upgrade-topic','Legacy topic','field',ARRAY['synthetic'],'Preserve topic data',1)`;
    await tx`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,model,origin)
      VALUES ('daily','2099-01-01',now()-interval '1 day',now(),'{}',now(),'legacy-report-model','imported')`;
    await tx`INSERT INTO selected_ledger (seq,article_id,op,payload) VALUES (91001,'upgrade-report','upsert','{"synthetic":true}')`;
    await tx`INSERT INTO lb_models (id,slug,name,provider_slug,input_price_usd,output_price_usd)
      VALUES ('upgrade-model','qwen-3-4-b','Operator-owned legacy name','operator-owned',1.25,2.5)`;
    await tx`INSERT INTO monitor_posts (id,author,published_at,text,url) VALUES ('upgrade-monitor','synthetic',${recent},'Synthetic monitor evidence','https://example.invalid/monitor')`;
    await tx`INSERT INTO monitor_state (key,value) VALUES ('upgrade-monitor-state','{"offset":123}')`;
    await tx`INSERT INTO settings (key,value,updated_by) VALUES ('leaderboard.fetch','{"enabled":false}','synthetic'),('models.monitor','{"model":"preserved"}','synthetic')`;
    await tx`UPDATE settings SET value='{"enabled":true,"windowHours":48,"maxRecords":2000,"participationModes":["editorial","hot_signal"]}' WHERE key='content.recent-processing'`;
    await tx`UPDATE budgets SET enabled=false,per_minute=2,per_hour=3,per_day=4 WHERE service='bird'`;
    const [admin] = await tx`INSERT INTO admin_users (feishu_union_id,email,role) VALUES ('synthetic-feishu','synthetic@example.invalid','admin') RETURNING id`;
    await tx`INSERT INTO admin_sessions (id_hash,user_id,csrf_token,expires_at,auth_method,auth_binding,auth_claims)
      VALUES ('synthetic-hash',${admin!.id},'synthetic-csrf',now()+interval '1 day','feishu','synthetic-binding','{"synthetic":true}')`;
    await tx`INSERT INTO stored_files (key,content_type,bytes,purpose) VALUES ('synthetic-file','text/plain',7,'synthetic')`;
    await tx`INSERT INTO corescope_bridge_state (client,cursor) VALUES ('synthetic-bridge','{"id":123}')`;
    await tx`INSERT INTO corescope_bridge_ledger (client,upstream_id,source_alias,source_id,article_id,raw_fingerprint,body_evidence)
      VALUES ('synthetic-bridge',123,'synthetic-source','upgrade-editorial','upgrade-report','synthetic-hash','{"synthetic":true}')`;
    await tx`INSERT INTO bird_profile_gate (profile) VALUES ('synthetic-disabled-profile')`;
    await tx`INSERT INTO event_job_deferrals (queue,singleton_key,data,retry_at,remaining_retries,reason)
      VALUES ('events.group','upgrade-report','{"articleId":"upgrade-report"}',now()+interval '1 hour',2,'synthetic capacity evidence')`;
    await tx`INSERT INTO article_body_failure_cache (article_id,url,url_sha256,event_kind,reason,receipt_id,body_sha256)
      VALUES ('upgrade-unknown','https://example.invalid/unknown',${'a'.repeat(64)},'failure','short_body',
        (SELECT id FROM receipts WHERE logical_key='upgrade-completed'),${'b'.repeat(64)})`;
    await tx`INSERT INTO audit_log (actor,action,subject,after) VALUES ('synthetic','upgrade.fixture','fixture','{"synthetic":true}')`;
  });
}

export interface LegacySnapshot { table: string; columns: string[]; rows: unknown[] }
export async function legacySnapshot(db: postgres.Sql, previous?: LegacySnapshot[]): Promise<LegacySnapshot[]> {
  const tables = previous ?? (await db<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name NOT IN ('schema_migrations','schema_migration_holds') ORDER BY table_name`)
    .map(row => ({ table: row.table_name, columns: [] as string[], rows: [] as unknown[] }));
  const result: LegacySnapshot[] = [];
  for (const entry of tables) {
    const columns = entry.columns.length ? entry.columns : (await db<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name=${entry.table} ORDER BY ordinal_position`).map(row => row.column_name);
    const rows = await db.unsafe(`SELECT ${columns.map(c=>'"'+c.replaceAll('"','""')+'"').join(',')} FROM "${entry.table.replaceAll('"','""')}" LIMIT 101`);
    assert.ok(rows.length <= 100, `fixture exceeded its row bound: ${entry.table}`);
    result.push({ table: entry.table, columns, rows: [...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  }
  return result;
}

export function snapshotSummary(snapshot: LegacySnapshot[]) {
  return snapshot.map(({ table,columns,rows }) => ({ table,columns:columns.length,rows:rows.length,
    sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex') }));
}
