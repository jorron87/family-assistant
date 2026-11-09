import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loginProblems,loginSummary} from '../public/login-status.mjs';
import {weeklyLetters} from './weekly-letters.mjs';
import {sendExplorerBundle} from './library-explorer.mjs';

export function phoneHandler({odaCart=null,productImages=null,oda=null,store,root,send,body,json,onQueued=()=>{},weather=null,sessionMaintenance=null}) {
  const attempts=[];
  return async(req,res)=>{
    try {
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET') {
        const assets={'/send/profile-editor.mjs':['profile-editor.mjs','text/javascript; charset=utf-8'],'/send/profile-editor.css':['profile-editor.css','text/css; charset=utf-8'],'/send/':['phone.html','text/html; charset=utf-8'],'/send/phone.js':['phone.js','text/javascript; charset=utf-8'],'/send/phone-family.js':['phone-family.js','text/javascript; charset=utf-8'],'/send/calendar-data.mjs':['calendar-data.mjs','text/javascript; charset=utf-8'],'/send/event-display.mjs':['event-display.mjs','text/javascript; charset=utf-8'],'/send/phone.css':['phone.css','text/css; charset=utf-8'],'/send/manifest.webmanifest':['phone.webmanifest','application/manifest+json'],'/send/icon.svg':['phone-icon.svg','image/svg+xml']};
        assets['/send/dtf.mjs']=['dtf.mjs','text/javascript; charset=utf-8'];
        assets['/send/member-colors.mjs']=['member-colors.mjs','text/javascript; charset=utf-8'];
        assets['/send/celebrate.mjs']=['celebrate.mjs','text/javascript; charset=utf-8'];
        assets['/send/home-tasks.mjs']=['home-tasks.mjs','text/javascript; charset=utf-8'];
        assets['/send/shopping-view.mjs']=['shopping-view.mjs','text/javascript; charset=utf-8'];
        assets['/send/pantry-groups.mjs']=['pantry-groups.mjs','text/javascript; charset=utf-8'];
        assets['/send/barcode.mjs']=['barcode.mjs','text/javascript; charset=utf-8'];
        assets['/send/shopping.css']=['shopping.css','text/css; charset=utf-8'];
        assets['/send/phone-boot.js']=['phone-boot.js','text/javascript; charset=utf-8'];
        assets['/send/library-explorer.mjs']=['library-explorer.mjs','text/javascript; charset=utf-8'];
        assets['/send/library-explorer-core.mjs']=['library-explorer-core.mjs','text/javascript; charset=utf-8'];
        assets['/send/library-explorer.css']=['library-explorer.css','text/css; charset=utf-8'];
        if(path==='/'||path==='/send') {res.writeHead(302,{Location:'/send/'});return res.end();}
        if(assets[path])return send(res,200,readFileSync(join(root,'public',assets[path][0])),assets[path][1]);
      }
      if(req.method==='POST') {
        const origin=req.headers.origin;
        if(req.headers['x-family-request']!=='1' || (origin && new URL(origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      }
      if(path==='/send/api/pair'&&req.method==='POST') {
        while(attempts[0]<Date.now()-3600000)attempts.shift();
        if(attempts.length>=100)return send(res,429,{error:'For mange innloggingsforsøk. Prøv senere.'});
        attempts.push(Date.now());
        const device=store.phone.pair(await json(req));
        const secure=req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
        res.setHeader('Set-Cookie',`familien_phone=${device.token}; HttpOnly; SameSite=Strict; Path=/send/; Max-Age=${180*86400}${secure?'; Secure':''}`);
        return send(res,200,{paired:true});
      }
      const token=String(req.headers.cookie??'').split(';').map(item=>item.trim()).find(item=>item.startsWith('familien_phone='))?.slice(15);
      const device=store.phone.authenticate(token);
      if(!device)return send(res,401,{error:'Åpne familielenken for å knytte denne telefonen til familien.'});
      if(path==='/send/api/family'&&req.method==='GET') {
        const snapshot=store.snapshot();
        const letters=weeklyLetters(snapshot).map(letter=>({...letter,url:letter.attachmentId?`/send/api/documents/${letter.rawId}/${letter.attachmentId}`:null}));
        const members=store.profile().members.map(({id,name,role,color})=>({id,name,role,color}));
        const events=Object.values(snapshot.events).map(({id,title,kind,start,end,allDay,provisional,timeNote,cancelled,members,details,reason,checklist,task,taskSplit,visibility,calendar,sourceRefs})=>({id,title,kind,start,end,allDay,provisional,timeNote,cancelled,members,details,reason,checklist,task,taskSplit:taskSplit?{eventIds:taskSplit.eventIds}:null,visibility:visibility?{hidden:visibility.hidden,sync:visibility.sync}:null,calendarUrl:calendar?.removedAt?null:calendar?.eventUrl,sources:sourceRefs.map(rawId=>{const raw=snapshot.rawItems[rawId];return {id:rawId,title:raw.title,source:raw.source,url:raw.sourceUrl,driveUrl:raw.driveUrl,attachments:raw.attachments.map(file=>({id:file.id,name:file.fileName,url:`/send/api/documents/${rawId}/${file.id}`}))};})}));
        const login=loginSummary(loginProblems({sourceStatus:snapshot.sourceStatus,surfaces:snapshot.surfaces,session:sessionMaintenance?.snapshot()??null}));
        return send(res,200,{members,events,login,weeklyLetters:letters,childIds:store.profile().members.filter(member=>member.role==='child').map(member=>member.id)});
      }
      if(path==='/send/api/shopping/family'&&req.method==='GET')return send(res,200,{...store.shopping.familyView(),oda:oda?.status()??{connected:false}});
      if(path==='/send/api/shopping/stock-intake'&&req.method==='POST')return send(res,200,store.shopping.stockIntake.begin({...await json(req),senderMemberId:device.memberId??null}));
      const stockUpload=/^\/send\/api\/shopping\/stock-intake\/([a-f0-9-]{36})\/files\/(\d)$/.exec(path);
      if(stockUpload&&req.method==='POST')return send(res,200,store.shopping.stockIntake.upload(stockUpload[1],Number(stockUpload[2]),{bytes:await body(req,10*1024*1024),fileName:decodeURIComponent(req.headers['x-file-name']??'lagerbilde')}));
      const stockSubmit=/^\/send\/api\/shopping\/stock-intake\/([a-f0-9-]{36})\/submit$/.exec(path);
      if(stockSubmit&&req.method==='POST'){await json(req);const result=store.shopping.stockIntake.submit(stockSubmit[1]);send(res,200,result);queueMicrotask(onQueued);return;}
      if(path==='/send/api/shopping/stock-action'&&req.method==='POST')return send(res,200,store.shopping.stockIntake.action(await json(req)));
      if(path==='/send/api/shopping/stock-scan'&&req.method==='POST')return send(res,200,store.shopping.stockScan(await json(req)));
      if(path==='/send/api/shopping/image'&&req.method==='GET'&&productImages){const url=store.shopping.imageSource(new URL(req.url,'http://localhost').searchParams.get('id'));const image=url?await productImages.load(url):null;if(!image)return send(res,404,{error:'Fant ikke bildet.'});res.setHeader('Cache-Control','private, max-age=86400');return send(res,200,image.bytes,image.type);}
      if(path==='/send/api/shopping/explore'&&req.method==='GET'){const bundle=await store.shopping.explorer.bundle();if(bundle.status!=='ready')return send(res,200,{status:bundle.status});return sendExplorerBundle(req,res,bundle);}
      if(path==='/send/api/shopping/explore-ingredients'&&req.method==='GET')return send(res,200,await store.shopping.explorer.ingredients(new URL(req.url,'http://localhost').searchParams.get('q')));
      if(path==='/send/api/shopping/explore-family'&&req.method==='GET')return send(res,200,store.shopping.explorer.family(new URL(req.url,'http://localhost').searchParams.get('id')));
      if(path==='/send/api/shopping/summary'&&req.method==='GET')return send(res,200,store.shopping.familySummary());
      if(path==='/send/api/shopping/product-info'&&req.method==='GET'){const params=new URL(req.url,'http://localhost').searchParams;return send(res,200,store.shopping.productInfo({key:params.get('key'),watchId:params.get('watchId')}));}
      if(req.method==='POST'&&path==='/send/api/shopping/list'){const input=await json(req);return send(res,200,odaCart?await odaCart.list(input):store.shopping.list(input));}
      if(path==='/send/api/shopping/oda/live'&&req.method==='GET'&&odaCart)return send(res,200,await odaCart.read(new URL(req.url,'http://localhost').searchParams.has('force')));
      if(req.method==='POST'&&path==='/send/api/shopping/oda/line'&&odaCart)return send(res,200,await odaCart.change(await json(req)));
      if(req.method==='POST'&&path==='/send/api/shopping/oda/swap'&&odaCart)return send(res,200,await odaCart.swap(await json(req)));
      if(req.method==='POST'&&path==='/send/api/shopping/pantry')return send(res,200,store.shopping.pantry(await json(req)));
      if(req.method==='POST'&&path==='/send/api/shopping/item')return send(res,200,store.shopping.item(await json(req)));
      if(req.method==='POST'&&path==='/send/api/shopping/deal')return send(res,200,store.shopping.dealAction(await json(req)));
      if(req.method==='POST'&&path==='/send/api/shopping/oda/review'&&oda)return send(res,200,store.shopping.cartReview(await oda.cart()));
      if(req.method==='POST'&&path==='/send/api/shopping/oda/search'&&oda)return send(res,200,await oda.search(await json(req)));
      if(req.method==='POST'&&path==='/send/api/shopping/oda/add'&&oda)return send(res,200,await oda.addToCart(await json(req)));
      if(path==='/send/api/weather'&&req.method==='GET')return send(res,200,weather?await weather.get():{unavailable:true});
      if(path==='/send/api/profile'&&req.method==='GET') {
        const profile=store.profile();
        return send(res,200,{familyName:profile.familyName,members:profile.members.map(({id,name,role,schoolClass})=>({id,name,role,schoolClass})),facts:profile.facts.filter(f=>f.status!=='superseded').map(({id,memberId,key,text,category,confidence,status,validFrom,validTo})=>({id,memberId,key,text,category,confidence,status,validFrom,validTo}))});
      }
      if(path==='/send/api/profile/edit'&&req.method==='POST') {store.editProfile(await json(req));return send(res,200,{saved:true});}
      const task=path.match(/^\/send\/api\/events\/([a-f0-9]{24})\/tasks\/([a-zA-Z0-9:_-]{1,100})$/);
      if(task&&req.method==='POST') {store.checkTask(task[1],task[2],await json(req));return send(res,200,{saved:true});}
      const visibility=path.match(/^\/send\/api\/events\/([a-f0-9]{24})\/visibility$/);
      if(visibility&&req.method==='POST') {store.setEventVisibility(visibility[1],await json(req));send(res,200,{saved:true});queueMicrotask(onQueued);return;}
      const document=path.match(/^\/send\/api\/documents\/([a-f0-9]{24})\/([a-f0-9-]{36})$/);
      if(document&&req.method==='GET') {
        const snapshot=store.snapshot();
        const linked=Object.values(snapshot.events).some(event=>event.sourceRefs.includes(document[1]));
        const letter=weeklyLetters(snapshot).some(item=>item.rawId===document[1]&&item.attachmentId===document[2]);
        if(!linked&&!letter)return send(res,404,{error:'Dokumentet er ikke knyttet til en familieoppføring.'});
        const {attachment,bytes}=store.getAttachment(document[1],document[2]);
        const passive=['application/pdf','image/jpeg','image/png','image/webp'].includes(attachment.mimeType);
        res.setHeader('Content-Disposition',`${passive?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
        return send(res,200,bytes,passive?attachment.mimeType:'application/octet-stream');
      }
      const weekly=path.match(/^\/send\/api\/weekly-letters\/([a-f0-9]{24})$/);
      if(weekly&&req.method==='GET') {
        const snapshot=store.snapshot();
        if(!weeklyLetters(snapshot).some(item=>item.rawId===weekly[1]))return send(res,404,{error:'Ukebrevet er ikke tilgjengelig.'});
        const raw=snapshot.rawItems[weekly[1]];
        return send(res,200,{title:raw.title,body:raw.body});
      }
      if(path==='/send/api/logout'&&req.method==='POST') {res.setHeader('Set-Cookie','familien_phone=; HttpOnly; SameSite=Strict; Path=/send/; Max-Age=0');return send(res,200,store.phone.logout(token));}
      if(path==='/send/api/identity'&&req.method==='POST')return send(res,200,store.phone.identity(device.id,await json(req)));
      if(path==='/send/api/inbox'&&req.method==='GET')return send(res,200,{items:store.phone.list(device.id),senderMemberId:device.memberId??null,members:store.profile().members.map(({id,name})=>({id,name}))});
      if(path==='/send/api/inbox'&&req.method==='POST')return send(res,200,store.phone.begin(await json(req),device.id));
      const upload=path.match(/^\/send\/api\/inbox\/([a-f0-9]{24})\/files\/(\d+)$/);
      if(upload&&req.method==='POST')return send(res,200,store.phone.upload(upload[1],Number(upload[2]),{fileName:decodeURIComponent(String(req.headers['x-file-name']??'bilde')),bytes:await body(req,20*1024*1024)},device.id));
      const submit=path.match(/^\/send\/api\/inbox\/([a-f0-9]{24})\/submit$/);
      if(submit&&req.method==='POST') {const item=store.phone.submit(submit[1],device.id);send(res,200,item);queueMicrotask(onQueued);return;}
      const cancel=path.match(/^\/send\/api\/inbox\/([a-f0-9]{24})\/cancel$/);
      if(cancel&&req.method==='POST')return send(res,200,store.phone.cancel(cancel[1],device.id));
      return send(res,404,{error:'Ukjent endepunkt.'});
    } catch(error) {return send(res,422,{error:error.message});}
  };
}
