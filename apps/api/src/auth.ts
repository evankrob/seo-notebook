import type {Actor,Env} from './types';
export const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
export async function password(s:string,salt:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(s),'PBKDF2',false,['deriveBits']);return Array.from(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256))).map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function authenticate(req:Request,env:Env):Promise<Actor|null>{
 const bearer=req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
 if(bearer){const a=await env.DB.prepare('SELECT * FROM agent_token WHERE token_hash=? AND revoked=0').bind(await hash(bearer)).first<any>();return a?{id:a.id,org_id:a.org_id,name:a.name,model:a.model,kind:'agent',scopes:JSON.parse(a.scopes)}:null;}
 const token=req.headers.get('Cookie')?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];if(!token)return null;
 const m=await env.DB.prepare('SELECT m.* FROM session s JOIN member m ON m.id=s.member_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hash(token),new Date().toISOString()).first<any>();
 return m?{id:m.id,org_id:m.org_id,name:m.name,kind:'human',scopes:['write:changes','read:metrics'],role:m.role}:null;
}
