import {connector} from '../../../packages/connectors';
import {parseCSV} from '../../../packages/connectors/csv';
import {day,date,logChange,storeMetrics} from './service';
import type {Env,Job,Metric} from './types';
import {z} from 'zod';
export async function fanout(env:Env,propertyId?:string,backfill=false){
 const today=new Date().toISOString().slice(0,10);
 const props=propertyId?[{id:propertyId}]:(await env.DB.prepare("SELECT id FROM property WHERE type IN ('gsc_domain','gsc_url_prefix','ga4')").all<{id:string}>()).results;
 const start=new Date(today);if(backfill)start.setUTCMonth(start.getUTCMonth()-16);else start.setUTCDate(start.getUTCDate()-7);
 let count=0;
 for(const p of props){let messages:{body:Job}[]=[];for(let d=start.toISOString().slice(0,10);d<today;d=day(d,1)){messages.push({body:{kind:'sync',propertyId:p.id,date:d}});count++;if(messages.length===100){await env.JOBS.sendBatch(messages);messages=[];}}if(messages.length)await env.JOBS.sendBatch(messages);}
 return count;
}
const metricSchema=z.object({property_id:z.string(),page_id:z.string(),date,metric:z.enum(['clicks','impressions','ctr','position','sessions','key_events','revenue','custom']),value:z.coerce.number().finite().nonnegative(),data_state:z.enum(['final','fresh']).default('final')});
export async function processJob(env:Env,job:Job){
 if(job.kind==='sync'){
  const p=await env.DB.prepare('SELECT * FROM property WHERE id=?').bind(job.propertyId).first<any>();if(!p)throw new Error('Property missing');
  const pages=(await env.DB.prepare('SELECT id,url FROM page WHERE client_id=?').bind(p.client_id).all<{id:string;url:string}>()).results;
  const rows=await connector(p.type==='ga4'?'ga4':'gsc',env.CONNECTOR_MODE).sync({propertyId:p.id,pages,date:job.date,today:new Date().toISOString().slice(0,10)});
  await storeMetrics(env,rows);return;
 }
 const j=await env.DB.prepare('SELECT * FROM import_job WHERE id=?').bind(job.id).first<any>();if(!j||j.status==='completed')return;
 try{
  const obj=await env.UPLOADS.get(j.object_key);if(!obj)throw new Error('Raw upload missing');const body=await obj.text();const rows:Record<string,any>[]=j.kind.endsWith('json')?JSON.parse(body):parseCSV(body);
  if(!Array.isArray(rows)||rows.length>5000)throw new Error('Expected at most 5000 rows');
  const actor=JSON.parse(j.actor_json);let count=0;
  if(j.kind.startsWith('changes')){
    // Validate every row before writing; retries use stable per-row idempotency keys.
    const changes=rows.map(r=>({client_id:j.client_id,occurred_at:r.occurred_at,timezone:r.timezone||'UTC',status:r.status||'shipped',type:r.type,summary:r.summary,rationale:r.rationale,page_ids:r.page_id?[r.page_id]:[],sitewide:r.sitewide==='true',...(r.group_id?{group_id:r.group_id}:{})}));
    const {changeSchema}=await import('./service');for(const c of changes)changeSchema.parse(c);
    for(const c of changes){await logChange(env,actor,c,`import:${j.id}:${count}`,'import');count++;}
  }else{
    const metrics:Metric[]=[];
    for(const row of rows){const m=metricSchema.parse(row);const valid=await env.DB.prepare('SELECT p.id FROM property p JOIN page pg ON pg.client_id=p.client_id WHERE p.id=? AND pg.id=? AND p.client_id=?').bind(m.property_id,m.page_id,j.client_id).first();if(!valid)throw new Error('Metric property/page outside client');metrics.push({...m,source:'import'});}
    await storeMetrics(env,metrics);count=metrics.length;
  }
  await env.DB.prepare("UPDATE import_job SET status='completed',error=NULL,row_count=? WHERE id=?").bind(count,j.id).run();
 }catch(e){await env.DB.prepare("UPDATE import_job SET status='failed',error=? WHERE id=?").bind(e instanceof Error?e.message:'Import failed',job.id).run();throw e;}
}
