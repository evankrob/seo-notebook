import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {z} from 'zod';
import {changeSchema,getImpact,listChanges,logChange} from './service';
import type {Actor,Env} from './types';
export async function mcp(request:Request,env:Env,actor:Actor){
 const server=new McpServer({name:'seo-notebook',version:'0.1.0'});
 const wrap=(fn:()=>Promise<unknown>)=>fn().then(r=>({content:[{type:'text' as const,text:JSON.stringify(r)}]})).catch(e=>({isError:true,content:[{type:'text' as const,text:e.message}]}));
 server.registerTool('log_change',{description:'Record a change attributed to the authenticated agent. Use idempotency_key on retries.',inputSchema:{...changeSchema.shape,idempotency_key:z.string().optional()}},async({idempotency_key,...args})=>wrap(()=>logChange(env,actor,args,idempotency_key,'mcp')));
 server.registerTool('list_changes',{description:'List authorized changes; filter by client, URL or date.',inputSchema:{client:z.string().optional(),url:z.string().optional(),since:z.string().optional()}},async args=>wrap(()=>listChanges(env,actor,args)));
 server.registerTool('get_impact',{description:'Get observational before/after impact with finality and overlap warnings.',inputSchema:{change_id:z.string(),control:z.string().optional(),property:z.string().optional(),metric:z.string().optional(),days:z.number().int().optional(),lag:z.number().int().optional()}},async({change_id,days,lag,...q})=>wrap(()=>getImpact(env,actor,change_id,{...q,days:days?.toString(),lag:lag?.toString()})));
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);return transport.handleRequest(request);
}
