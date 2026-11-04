// Camera intake + dashboard proxy; family collection keeps its existing process.
import {createServer,request} from 'node:http';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHomeAssistant} from '../src/home-assistant.mjs';
import {createDoorbell} from '../src/doorbell.mjs';
import {DATA_DIR} from '../src/store.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),port=Number(process.env.FAMILIEN_DOORBELL_PORT??15319),familyPort=Number(process.env.FAMILIEN_DASHBOARD_PORT??4319);
const homeAssistant=createHomeAssistant({config:JSON.parse(readFileSync(join(root,'config','home-assistant.json'))),dataDir:DATA_DIR});
const doorbell=createDoorbell({config:JSON.parse(readFileSync(join(root,'config','doorbell.json'))),dataDir:DATA_DIR,homeAssistant});
const send=(res,status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(data):data);};
const files=new Map([['/doorbell-view.mjs',['doorbell-view.mjs','text/javascript; charset=utf-8']],['/doorbell.css',['doorbell.css','text/css; charset=utf-8']]]);
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&files.has(path)){const [name,type]=files.get(path);return send(res,200,readFileSync(join(root,'public',name)),type);}
  // /health follows the family server too: the kiosk must notice family code
  // deployments even while this camera gateway keeps the same process.
  if(path==='/api/doorbell/status'&&req.method==='GET')return send(res,200,await doorbell.status());
  if(path==='/api/doorbell/events'&&req.method==='GET')return doorbell.sse(req,res);
  if(path==='/api/doorbell/frame'&&req.method==='POST'){
   if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)return send(res,413,{error:'Ugyldig bildemåling.'});chunks.push(chunk);}
   return send(res,200,doorbell.recordFrame(JSON.parse(Buffer.concat(chunks).toString())));
  }
  if(path.startsWith('/api/doorbell/'))return send(res,404,{error:'Ukjent ringeklokkeendepunkt.'});
  const upstream=request({hostname:'127.0.0.1',port:familyPort,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.setTimeout(30000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)send(res,503,{error:'Familiedashboardet er midlertidig utilgjengelig.'});else res.destroy();});req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 }catch{if(!res.headersSent)send(res,422,{error:'Forespørselen kunne ikke behandles.'});else res.destroy();}
});
doorbell.attach(server);
server.listen(port,'127.0.0.1',()=>console.log(`Ringeklokke og dashboard: http://127.0.0.1:${port}; data: ${DATA_DIR}.`));
await doorbell.start();
function close(){doorbell.close();homeAssistant.close();server.close(()=>process.exit(0));}
process.once('SIGINT',close);process.once('SIGTERM',close);
