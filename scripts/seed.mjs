import {pbkdf2Sync,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const pass=pbkdf2Sync('notebook-demo-only','cedar-demo-salt',100000,32,'sha256').toString('hex');
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
let sql=`-- Fictional local fixtures only. Safe to rerun; leaves user-created data intact.\nINSERT OR IGNORE INTO org VALUES ('demo-org','Notebook Studio','self-host');
INSERT OR IGNORE INTO member VALUES ('demo-human','demo-org','Alex Morgan','alex@cedar.example','${pass}','cedar-demo-salt','admin');
INSERT OR IGNORE INTO agent_token(id,org_id,name,model,token_hash,scopes) VALUES ('demo-agent','demo-org','Cedar Assistant','fixture-model','${hash('demo-agent-token-not-a-secret')}','["write:changes","read:metrics"]');
INSERT OR IGNORE INTO client VALUES ('cedar','demo-org','Cedar & Finch Supply','America/New_York');
INSERT OR IGNORE INTO connection VALUES ('gsc-connection','demo-org','gsc','oauth','mock');
INSERT OR IGNORE INTO connection VALUES ('ga-connection','demo-org','ga4','service_account','mock');
INSERT OR IGNORE INTO property VALUES ('cedar-gsc','cedar','gsc_domain','sc-domain:cedar.example','gsc-connection');
INSERT OR IGNORE INTO property VALUES ('cedar-ga4','cedar','ga4','fixture-123','ga-connection');
INSERT OR IGNORE INTO page VALUES ('garden','cedar','https://cedar.example/garden-tools/','https://cedar.example/garden-tools/','["category"]');
INSERT OR IGNORE INTO page VALUES ('guides','cedar','https://cedar.example/guides/','https://cedar.example/guides/','["control"]');
INSERT OR IGNORE INTO page VALUES ('contact','cedar','https://cedar.example/contact/','https://cedar.example/contact/','["lead"]');
INSERT OR IGNORE INTO page_group VALUES ('control-guides','cedar','Control · unchanged guides','["guides"]');
`;
const changes=[
 ['title-refresh','2026-09-01','shipped','title_meta',['garden'],'Clarified the garden tools title','Test whether a specific category title improves qualified organic clicks.','demo-agent','Cedar Assistant','agent','mcp','clicks'],
 ['form-layout','2026-09-09','shipped','CRO_form',['contact'],'Shortened the wholesale inquiry form','Reduce friction by moving optional fields below the first submit step.','demo-human','Alex Morgan','human','ui','key_events'],
 ['overlap-copy','2026-09-12','shipped','content',['contact'],'Added delivery answers near the form','Address common purchase questions before visitors inquire.','demo-agent','Cedar Assistant','agent','api','sessions'],
 ['next-links','2026-10-20','planned','internal_links',['garden'],'Link buying guides to category pages','Help readers discover the next useful step.','demo-human','Alex Morgan','human','ui','clicks'],
 ['reverted-test','2026-08-12','reverted','CRO_layout',['contact'],'Reverted the sticky inquiry button','The experimental button obscured supporting information.','demo-human','Alex Morgan','human','ui','sessions']
];
for(const [id,date,status,type,pages,summary,why,author,name,kind,source,metric] of changes){sql+='INSERT OR IGNORE INTO change_entry VALUES ('+[id,'cedar',date,'America/New_York',status,type,JSON.stringify(pages),null,0,summary,why,author,name,kind,kind==='agent'?'fixture-model':null,source,'[]',metric,'[]','2026-10-14T12:00:00Z','2026-10-14T12:00:00Z'].map(v=>v===null?'NULL':quote(v)).join(',')+');\n';}
for(let d=new Date('2026-08-01T00:00:00Z');d<=new Date('2026-10-14T00:00:00Z');d.setUTCDate(d.getUTCDate()+1)){
 const date=d.toISOString().slice(0,10),day=Math.floor(d.getTime()/86400000),fresh=date>='2026-10-12';
 ['garden','guides','contact'].forEach((page,i)=>{const base=18+i*3+(day%7),uplift=date>='2026-09-05'&&i===0?1.35:1;
 for(const [property,values]of [['cedar-gsc',{clicks:Math.round(base*uplift),impressions:Math.round(base*30*uplift),ctr:1/30,position:8-i*.5}],['cedar-ga4',{sessions:Math.round(base*3*uplift),key_events:Math.round(base*.2*uplift)}]])for(const [metric,value]of Object.entries(values))sql+='INSERT OR IGNORE INTO metric_series VALUES ('+[property,page,date,metric,value,'mock:seed',fresh?'fresh':'final','2026-10-15T00:00:00Z'].map(quote).join(',')+');\n';
 });
}
sql+=`INSERT OR IGNORE INTO report VALUES ('demo-report','cedar','${hash('demo-read-only-report')}','Cedar & Finch · September notebook','2026-08-01','2026-10-31',0,'2026-10-15T00:00:00Z');\n`;
writeFileSync('fixtures/seed.sql',sql);
console.log('Generated fictional demo fixtures.');
