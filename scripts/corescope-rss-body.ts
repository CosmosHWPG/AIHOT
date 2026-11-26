// Audited fixed single-article RSS recovery. This only produces jobs for the existing worker.
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { audit } from '@aihot/backend/audit';
import { queueProcessing } from '@aihot/backend/jobs/content';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { applyRecoveryBatch, getRecoveryRssBodyPolicy, parseRecoveryPlan, planRecoveryBatch,
  recoveryBatchStatus, stopRecoveryBatch, RECOVERY_BATCH_PREFIX } from '@aihot/backend/jobs/processing-recovery';

const dbUrl = new URL(config.databaseUrl);
if (!['127.0.0.1','localhost'].includes(dbUrl.hostname) || dbUrl.port !== '5448' || dbUrl.pathname !== '/corescope') throw Error('Independent local CoreScope only');
const actor='corescope-rss-body-operations';
const option = (name: string) => process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const command=process.argv[2] ?? 'status';
try {
  if (command === 'plan') {
    const request=option('request'),output=option('out');
    if (!request||!output) throw Error('Use plan --request=<json> --out=<json>');
    const input=JSON.parse(readFileSync(request,'utf8').replace(/^\uFEFF/,''));
    if (!Array.isArray(input.articleIds)||input.articleIds.length>3||input.articleIds.some((id:string)=>!input.rssBodies?.[id])) throw Error('One to three fixed IDs with explicit no-Jina RSS strategies required');
    const plan=await sql.begin(async tx=>{
      await tx`SET TRANSACTION READ ONLY`;
      return planRecoveryBatch({id:input.id,kind:'web-body-recovery',articleIds:input.articleIds,evidence:input.evidence,rssBodies:input.rssBodies},tx);
    });
    writeFileSync(output,JSON.stringify(plan,null,2));
    console.log(JSON.stringify({id:plan.id,digest:plan.digest,members:plan.members.length,readOnly:true}));
  } else if (command === 'apply'||command === 'enqueue') {
    const file=option('plan'); if(!file)throw Error('Use --plan=<frozen-json>');
    const plan=parseRecoveryPlan(JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
    if(plan.kind!=='web-body-recovery'||plan.members.some(m=>!m.rssBody))throw Error('Exact RSS body plan required');
    if(command==='apply') {
      const batch=await applyRecoveryBatch(plan,actor,'User authorized exact RSS body recovery without Jina, source or publication changes');
      console.log(JSON.stringify({id:batch.id,status:batch.status,digest:batch.digest}));
    } else {
      const results=[];
      for(const member of plan.members) results.push(await sql.begin(async tx=>{
        await tx`SELECT id FROM sources WHERE id=${member.sourceId} FOR SHARE`;
        const [article]=await tx`SELECT id,revision,body_status,processing_state FROM articles WHERE id=${member.articleId} FOR UPDATE`;
        await tx`SELECT key FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + plan.id} FOR UPDATE`;
        const policy=await getRecoveryRssBodyPolicy(member.articleId,tx);
        if(!article||policy.strategy?.batchId!==plan.id||policy.strategy.batchDigest!==plan.digest||!policy.denyJina)throw Error('Active exact RSS member required');
        const requestId=`rss-body-${plan.digest.slice(0,16)}-${member.articleId}`;
        const [prior]=await tx`SELECT after->>'jobId' AS job_id FROM audit_log WHERE actor=${actor}
          AND action='content.rss-body.enqueue' AND subject=${'content:'+member.articleId} AND request_id=${requestId} ORDER BY id DESC LIMIT 1`;
        if(prior)return{id:member.articleId,state:'already-handed-off',jobId:prior.job_id};
        if(article.body_status==='ok')return{id:member.articleId,state:'already-body-ok'};
        const [blocked]=await tx`SELECT 1 WHERE EXISTS(SELECT 1 FROM pgboss.job WHERE data->>'articleId'=${member.articleId} AND state IN('created','retry','active'))
          OR EXISTS(SELECT 1 FROM receipts WHERE status IN('pending','unknown') AND (substring(subject from '^article:([^@:#]+)')=${member.articleId} OR (service='jina' AND request->>'url'=${member.url!})))
          OR EXISTS(SELECT 1 FROM event_job_deferrals WHERE data->>'articleId'=${member.articleId})`;
        if(blocked)throw Error('Existing job, deferral or unresolved receipt must settle');
        if(!['new','analyzed','failed'].includes(article.processing_state))throw Error('Not an admitted initial body state');
        await tx`UPDATE articles SET body_status='pending',processing_state='new',processing_error=NULL,processing_retry_at=NULL WHERE id=${member.articleId}`;
        const jobId=await queueProcessing(member.articleId,{step:'extract',db:tx});
        if(!jobId)throw Error('Normal extraction queue refused; rollback');
        await audit(actor,'content.rss-body.enqueue','content:'+member.articleId,'Fixed RSS body recovery without Jina or re-evaluation',
          {revision:article.revision},{batchId:plan.id,jobId,allowJina:false,revision:article.revision},{db:tx,requestId});
        return{id:member.articleId,state:'queued',jobId};
      }));
      console.log(JSON.stringify({id:plan.id,rows:results,workersRegistered:false,sourceChanges:false}));
    }
  } else if(command==='status'||command==='complete') {
    const id=option('id');if(!id)throw Error('Use --id=<fixed-batch>');
    const status=await recoveryBatchStatus(id);if(!status)throw Error('Unknown batch');
    if(command==='complete') {
      if(!status.completeable||status.members.some(m=>m.bodyStatus!=='ok'))throw Error('All fixed RSS bodies and downstream work must really settle');
      await stopRecoveryBatch(id,'complete',actor,'Verified all exact RSS bodies, current revision processing and normal publication outcomes; no new Jina calls');
    }
    console.log(JSON.stringify(command==='status'?status:{id,status:'complete',noJinaInstructionRetained:true}));
  } else throw Error('Use plan/apply/enqueue/status/complete');
} finally {await stopBoss();await closeDb();}
