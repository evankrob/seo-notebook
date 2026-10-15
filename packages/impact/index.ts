export interface Point {page_id:string; date:string; value:number; data_state:'final'|'fresh'}
export const day = (s:string,n:number) => new Date(Date.parse(s.slice(0,10)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function windows(date:string,days=28,lag=3) {
  if (!Number.isInteger(days)||days<7||days>180||!Number.isInteger(lag)||lag<0||lag>60) throw new Error('Invalid window');
  return {pre:{start:day(date,-days),end:day(date,-1)},post:{start:day(date,lag+1),end:day(date,lag+days)},days,lag};
}
export function impact(input:{date:string;points:Point[];pages:string[];control?:string[];days?:number;lag?:number;overlaps:string[];status:string;newPage?:boolean;now?:string;metric?:string}) {
  const w=windows(input.date,input.days,input.lag), warnings:string[]=[];
  const summarize=(ids:string[],range:{start:string;end:string})=>{
    const rows=input.points.filter(p=>ids.includes(p.page_id)&&p.date>=range.start&&p.date<=range.end);
    const complete=ids.length>0 && ids.every(id=>new Set(rows.filter(p=>p.page_id===id&&p.data_state==='final').map(p=>p.date)).size===w.days) && rows.every(p=>p.data_state==='final');
    return {value:rows.reduce((s,p)=>s+p.value,0),complete};
  };
  const pre=summarize(input.pages,w.pre),post=summarize(input.pages,w.post);
  const mature=w.post.end<=(input.now??new Date().toISOString().slice(0,10));
  const scored=pre.complete&&post.complete&&mature&&input.status==='shipped'&&!input.newPage;
  const delta=scored?post.value-pre.value:null;
  const pct=scored&&pre.value>0?(post.value/pre.value-1)*100:null;
  let control=null, adjustedPercent:number|null=null;
  if(input.control?.length){
    if(input.control.some(p=>input.pages.includes(p))) throw new Error('Control must exclude changed pages');
    const a=summarize(input.control,w.pre),b=summarize(input.control,w.post);
    control={pre:a.value,post:b.value,complete:a.complete&&b.complete};
    if(scored&&a.complete&&b.complete&&a.value>0&&pre.value>0) adjustedPercent=((post.value/pre.value)-(b.value/a.value))*100;
    else warnings.push('Control data is incomplete or has a zero baseline.');
  }
  if(!scored) warnings.push('Pending: both complete final windows and a shipped change are required.');
  if(input.newPage) warnings.push('New pages have no comparable baseline. Choose predecessor pages before interpreting impact.');
  if(input.overlaps.length) warnings.push('Overlapping changes may explain the observed movement.');
  const volumeMetric=['clicks','sessions','key_events'].includes(input.metric??'clicks');
  const enough=volumeMetric&&pre.value>=100&&post.value>=100;
  let confidence:'Strong'|'Directional'|'Inconclusive'='Inconclusive';
  if(scored&&enough&&!input.overlaps.length) confidence=adjustedPercent!==null&&pct!==null&&Math.sign(adjustedPercent)===Math.sign(pct)?'Strong':'Directional';
  if(!enough) warnings.push('Low volume or a metric without a calibrated volume threshold; confidence is inconclusive.');
  return {windows:w,pre:pre.value,post:post.value,delta,percent:pct,control,adjustedPercent,confidence,scored,overlaps:input.overlaps,warnings,caveat:'Observational comparison, not proof of causality. Seasonality, paid traffic and anonymized GSC queries can affect interpretation.'};
}
