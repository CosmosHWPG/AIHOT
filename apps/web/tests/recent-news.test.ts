import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItemSummary, PoolResponse } from "@aihot/contracts/site";
import { recentPublicNews } from "../app/features/feed/recent-news.ts";

const at = "2026-10-13T13:00:00Z";
const item = (id: string, hours = 0, selected = false): FeedItemSummary => ({ id, title:id, summary:null, reason:null,
  publishedAt:new Date(Date.parse(at)-hours*3600_000).toISOString(),timelineAt:at,category:null,tags:[],score:null,
  selected,channel:"news",source:{name:"public sample"},x:null });
const pool = (items:FeedItemSummary[]) => ({items}) as PoolResponse;
const timeline = {cards:[],generatedAt:at};

test("the public sample uses source dates and stable newest order without mutating publication fields",async()=>{
  const entries=[item("older",2),item("tie-a",1),item("tie-z",1),item("now"),item("old",48.01),item("future",-1),{...item("unknown"),publishedAt:null}];
  const before=structuredClone(entries);
  const result=await recentPublicNews(timeline,async()=>pool(entries));
  assert.deepEqual(result.map(i=>i.id),["now","tie-z","tie-a","older"]);
  assert.deepEqual(entries,before);
  assert.ok(result.every(i=>!i.selected));
  assert.equal((await recentPublicNews(timeline,async()=>pool(Array.from({length:12},(_,i)=>item(String(i),i))))).length,6);
});
test("a recent selected card avoids auxiliary loading and a folded recent selected report also hides the sample",async()=>{
  let reads=0;
  const current={...timeline,cards:[{key:"current",anchorAt:at,item:item("selected",1,true),group:null}]};
  assert.deepEqual(await recentPublicNews(current,async()=>{reads++;return pool([item("unselected")]);}),[]);
  assert.equal(reads,0);
  const folded={...timeline,cards:[{key:"old",anchorAt:at,item:item("old-selected",72,true),group:null}]};
  assert.deepEqual(await recentPublicNews(folded,async()=>pool([item("new-selected",1,true),item("unselected")])),[]);
});
test("an auxiliary API outage leaves the selected timeline usable and an invalid clock shows no false freshness",async()=>{
  assert.deepEqual(await recentPublicNews(timeline,async()=>{throw new Error("pool unavailable");}),[]);
  assert.deepEqual(await recentPublicNews({...timeline,generatedAt:"invalid"},async()=>pool([item("now")])),[]);
});
test("request cancellation is propagated instead of converted into an empty successful page",async()=>{
  const controller=new AbortController();controller.abort();
  const error=new Error("cancelled");
  await assert.rejects(recentPublicNews(timeline,async()=>{throw error;},controller.signal),e=>e===error);
});
