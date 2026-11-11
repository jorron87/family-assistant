import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {loadKey,encrypt,decrypt} from './crypto.mjs';
import {shoppingDay} from './shopping.mjs';

const endpoint=new URL('https://oda.com/mcp');
const unwrap=response=>{
  if(response.isError)throw Error('Oda avviste forespørselen.');
  const data=response.structuredContent??JSON.parse(response.content?.find(x=>x.type==='text')?.text??'null');
  if(!data)throw Error('Oda returnerte ingen lesbare data.');return data;
};
export function cartQuantity(cart,productId) {
  let total=0;
  const walk=value=>{if(!value||typeof value!=='object')return;if(value.product?.id===productId&&typeof value.quantity==='number'){total+=value.quantity;return;}for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);};
  walk(cart.groups);return total;
}
export function createOda({dataDir,shopping,redirectUrl,now=()=>new Date(),makeClient=()=>new Client({name:'Family Assistant shopping',version:'1.0.0'}),makeTransport=options=>new StreamableHTTPClientTransport(endpoint,options)}) {
  const path=join(dataDir,'oda-oauth.json.enc');let auth,key,authorizationUrl=null,client=null,transport=null,busy=false,lastError=null;
  const read=()=>{if(!auth){key=loadKey(dataDir);auth=existsSync(path)?JSON.parse(decrypt(readFileSync(path),key).toString('utf8')):{};}return auth;};
  const persist=()=>{const temp=path+'.tmp';writeFileSync(temp,encrypt(Buffer.from(JSON.stringify(auth)),key));renameSync(temp,path);};
  const provider={
    redirectUrl,
    clientMetadata:{client_name:'Family Assistant shopping',redirect_uris:[redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},
    state:()=>read().pending?.state,
    clientInformation:()=>read().client,
    saveClientInformation:value=>{read().client=value;persist();},
    tokens:()=>read().tokens,
    saveTokens:value=>{read().tokens=value;persist();},
    saveCodeVerifier:value=>{read().verifier=value;persist();},
    codeVerifier:()=>{if(!read().verifier)throw Error('Start Oda-tilkoblingen på nytt.');return auth.verifier;},
    redirectToAuthorization:value=>{if(!read().pending||Date.now()>auth.pending.expiresAt)throw Error('Koble til Oda fra oppsettet.');authorizationUrl=value.href;},
    saveDiscoveryState:value=>{read().discovery=value;persist();},
    discoveryState:()=>read().discovery,
    invalidateCredentials:scope=>{const a=read();if(scope==='all'){auth={};}else delete a[({client:'client',tokens:'tokens',verifier:'verifier',discovery:'discovery'})[scope]];persist();}
  };
  const exclusive=async fn=>{if(busy)throw Error('En Oda-operasjon pågår.');busy=true;try{return await fn();}finally{busy=false;}};
  const close=async()=>{await client?.close().catch(()=>{});client=null;transport=null;};
  async function connect() {
    if(client)return client;
    if(!read().tokens&&!read().pending)throw Error('Oda er ikke tilkoblet. Åpne oppsettet lokalt.');
    transport=makeTransport({authProvider:provider,reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
    const candidate=makeClient();
    try{await candidate.connect(transport);client=candidate;lastError=null;return client;}
    catch(error){await candidate.close().catch(()=>{});if(error instanceof UnauthorizedError&&authorizationUrl)return null;lastError='Oda-tilkoblingen må kontrolleres i oppsettet.';throw Error(lastError);}
  }
  async function call(name,args={}) {const c=await connect();if(!c)throw Error('Fullfør Oda-innloggingen i nettleseren.');return unwrap(await c.callTool({name,arguments:args},undefined,{timeout:30000}));}
  async function authorize() {return exclusive(async()=>{
    await close();authorizationUrl=null;read().pending={state:randomBytes(32).toString('base64url'),expiresAt:Date.now()+10*60000};persist();
    try{await connect();return {connected:!!client,url:authorizationUrl};}catch{delete auth.pending;persist();throw Error('Kunne ikke starte Oda-tilkoblingen. Kontroller at Oda støtter registrering av denne klienten.');}
  });}
  async function callback(query) {return exclusive(async()=>{
    const pending=read().pending;
    if(!pending||Date.now()>pending.expiresAt||query.state!==pending.state||!query.code||query.error)throw Error('Oda-innloggingen er utløpt eller ble avvist. Start på nytt.');
    try{
      transport=makeTransport({authProvider:provider});await transport.finishAuth(query.code);
      delete auth.pending;delete auth.verifier;persist();authorizationUrl=null;await connect();return {connected:true};
    }catch{lastError='Oda-innloggingen kunne ikke fullføres.';throw Error(lastError);}
  });}
  async function sync() {return exclusive(async()=>{
    const from=shopping.view().settings.historyFrom??`${Number(shoppingDay().slice(0,4))-1}${shoppingDay().slice(4)}`,today=shoppingDay();
    const known=new Set(shopping.analysis().orders.map(x=>x.orderNumber));let imported=0,complete=false,pages=0;
    for(let page=1;page<=50;page++){
      const data=await call('get_orders',{page,size:20});pages++;
      if(!Array.isArray(data.orders)||typeof data.hasMore!=='boolean')throw Error('Oda returnerte en ukjent ordreliste.');
      for(const order of data.orders){
        if(order.deliveryDate<from||order.deliveryDate>today||known.has(order.orderNumber))continue;
        const detail=await call('get_order',{order_number:order.orderNumber});
        shopping.importOrders({orders:[detail]});known.add(order.orderNumber);imported++;
      }
      if(!data.hasMore){complete=true;break;}
    }
    return {imported,pages,complete,from,to:today,note:complete?'Hele tilgjengelige ordrelisten er kontrollert.':'Odas sidegrense er nådd; historikkdekningen er ufullstendig.'};
  });}
  async function search(input) {return exclusive(async()=>{
    const query=String(input.query??'').trim();if(!query||query.length>200)throw Error('Skriv et varenavn.');
    return call('product_search',{queries:[query],page:1,size:10});
  });}
  async function tools() {return exclusive(async()=>{const c=await connect();if(!c)throw Error('Fullfør Oda-innloggingen i nettleseren.');return c.listTools();});}
  async function readCatalog(input){return exclusive(async()=>{
    const queries=[...new Set(input.queries??[])],page=input.page??1;
    if(!queries.length||queries.length>10||queries.some(q=>typeof q!=='string'||!q.trim()||q.length>200)||!Number.isInteger(page)||page<1||page>50)throw Error('Select 1–10 actual product queries and a supported Oda page.');
    const response=await call('product_search',{queries,page,size:20}),observedAt=now().toISOString();
    if(!Array.isArray(response.result)||response.result.length!==queries.length||response.result.some(row=>!queries.includes(row.query)||!Array.isArray(row.products)||row.products.length>20||typeof row.hasMore!=='boolean')||new Set(response.result.map(r=>r.query)).size!==queries.length)throw Error('Invalid Oda catalogue search receipt.');
    return {result:response.result,observedAt,page};
  });}
  async function refreshPrices(input={}) {
    const maxPages=input.maxPages??5;
    if(!Number.isInteger(maxPages)||maxPages<1||maxPages>5||input.watchIds!==undefined&&(!Array.isArray(input.watchIds)||input.watchIds.length>10||input.watchIds.some(id=>typeof id!=='string')))throw Error('Velg høyst ti varefamilier og én til fem sider.');
    if(busy)return {families:0,results:[],deferred:true,reason:'oda-busy',retryAfterMs:1000};
    return exclusive(async()=>{
    const plans=shopping.odaRefreshPlan({force:input.force===true}).filter(p=>!input.watchIds||input.watchIds.includes(p.watchId)).slice(0,10);
    if(!plans.length)return {families:0,results:[]};
    const queries=[...new Set(plans.map(p=>p.query))],collected=new Map(queries.map(query=>[query,{receipts:[],complete:false,observedAt:null}]));
    let pending=queries,searchError=null;
    try {
    for(let page=1;page<=maxPages&&pending.length;page++){
      const response=await call('product_search',{queries:pending,page,size:20}),observedAt=now().toISOString();
      if(!Array.isArray(response.result)||response.result.length!==pending.length)throw Error('Oda returnerte en ukjent prissøkliste.');
      const seen=new Set(),more=[];
      for(const row of response.result){
        if(!pending.includes(row.query)||seen.has(row.query)||!Array.isArray(row.products)||row.products.length>20||typeof row.hasMore!=='boolean')throw Error('Oda returnerte en ukjent prissøkside.');
        seen.add(row.query);const target=collected.get(row.query);target.receipts.push(...row.products.map(product=>({product,observedAt})));target.observedAt=observedAt;target.complete=!row.hasMore;
        const wanted=plans.filter(p=>p.query===row.query).flatMap(p=>p.products.map(x=>x.odaProductId));
        if(row.hasMore&&wanted.some(id=>!target.receipts.some(r=>r.product.id===id)))more.push(row.query);
      }
      pending=more;
    }
    }catch{searchError='Oda MCP kunne ikke leses fullstendig. Kontroller tilkoblingen før neste forsøk.';}
    const results=[];
    for(const plan of plans){
      results.push(shopping.odaRefreshReceive({plan,...collected.get(plan.query),searchComplete:collected.get(plan.query).complete,searchError}));
      // Each family is a complete synchronous update. Let dashboard requests
      // run before starting another one; no reader cache crosses this await.
      await new Promise(resolve=>setImmediate(resolve));
    }
    return {families:results.length,results};
  });}
  // Adds a large quantity, reads what Oda says, and always takes it back out.
  // This only runs on an explicit family request; it never places an order.
  async function probeLimit(input) {return exclusive(async()=>{
    const {productId,quantity}=input;
    if(!Number.isSafeInteger(productId)||productId<1||!Number.isInteger(quantity)||quantity<1||quantity>100)throw Error('Ugyldig grensetest.');
    const before=await call('get_cart'),initial=cartQuantity(before,productId);
    let during=null,accepted=null,error=null;
    try{
      during=await call('manipulate_cart',{operations:[{productId,quantity}]});
      accepted=cartQuantity(during,productId)-initial;
    }catch{error='Oda-testen kunne ikke bekreftes. Kontroller kurven.';}
    finally{
      // Read first: an ambiguous add may have changed nothing. Subtracting the
      // requested test quantity blindly can erase the family's existing line.
      const fresh=await call('get_cart').catch(()=>null);
      if(fresh&&cartQuantity(fresh,productId)!==initial)await call('manipulate_cart',{operations:[{productId,quantity:initial-cartQuantity(fresh,productId)}]}).catch(()=>{error='Tilbakestillingen må kontrolleres hos Oda.';});
    }
    const after=await call('get_cart'),lines=[];
    const walk=value=>{if(!value||typeof value!=='object')return;if(value.product?.id===productId){lines.push(value);return;}for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);};
    walk(during?.groups);
    return {productId,requested:quantity,accepted,error,validationMessages:during?.validationMessages??null,line:lines[0]??null,restored:cartQuantity(after,productId)===initial};
  });}
  const verifiedWrite=async(requestId,fields,write,verify)=>{
    if(!/^[a-zA-Z0-9-]{16,100}$/.test(requestId??''))throw Error('Ugyldig kurvhandling.');
    const previous=shopping.receipt(requestId);
    if(previous){if(Object.entries(fields).some(([key,value])=>previous[key]!==value))throw Error('Handlings-ID er allerede brukt.');if(previous.status==='confirmed')return previous;throw Error('Denne kurvhandlingen må kontrolleres hos Oda før et nytt forsøk.');}
    const before=await call('get_cart');
    shopping.cartReceipt(requestId,{status:'in_flight',...fields});
    try{
      await write(before);
      const after=await call('get_cart');
      if(!verify(after,before))throw Error('Mengden kunne ikke bekreftes.');
      return shopping.cartReceipt(requestId,{status:'confirmed',...fields,url:after.url});
    }catch{shopping.cartReceipt(requestId,{status:'uncertain'});throw Error('Kurvhandlingen kunne ikke bekreftes. Kontroller handlekurven hos Oda; handlingen gjentas ikke automatisk.');}
  };
  async function changeCart(input) {return exclusive(async()=>{
    const {requestId,productId,delta}=input;
    if(!Number.isSafeInteger(productId)||productId<1||!Number.isInteger(delta)||delta===0||Math.abs(delta)>200)throw Error('Ugyldig kurvhandling.');
    return verifiedWrite(requestId,{operation:'change',productId,quantity:delta},()=>call('manipulate_cart',{operations:[{productId,quantity:delta}]}),(after,before)=>cartQuantity(after,productId)===Math.max(0,cartQuantity(before,productId)+delta));
  });}
  async function swapInCart(input) {return exclusive(async()=>{
    const {requestId,fromProductId,toProductId,quantity}=input;
    if(![fromProductId,toProductId].every(id=>Number.isSafeInteger(id)&&id>0)||fromProductId===toProductId||!Number.isInteger(quantity)||quantity<1||quantity>100)throw Error('Ugyldig kurvhandling.');
    return verifiedWrite(requestId,{operation:'swap',fromProductId,productId:toProductId,quantity},before=>call('manipulate_cart',{operations:[{productId:fromProductId,quantity:-cartQuantity(before,fromProductId)},{productId:toProductId,quantity}]}),(after,before)=>cartQuantity(after,fromProductId)===0&&cartQuantity(after,toProductId)===cartQuantity(before,toProductId)+quantity);
  });}
  async function addToCart(input) {return exclusive(async()=>{
    const {requestId,productId,quantity}=input;
    if(!/^[a-zA-Z0-9-]{16,100}$/.test(requestId??'')||!Number.isSafeInteger(productId)||productId<1||!Number.isInteger(quantity)||quantity<1||quantity>100)throw Error('Ugyldig kurvhandling.');
    const previous=shopping.receipt(requestId);
    if(previous){if(previous.operation&&previous.operation!=='add'||previous.productId!==productId||previous.quantity!==quantity)throw Error('Handlings-ID er allerede brukt.');if(previous.status==='confirmed')return previous;throw Error('Denne kurvhandlingen må kontrolleres hos Oda før et nytt forsøk.');}
    const before=await call('get_cart'),initial=cartQuantity(before,productId);
    shopping.cartReceipt(requestId,{status:'in_flight',operation:'add',productId,quantity,initial});
    try{
      await call('manipulate_cart',{operations:[{productId,quantity}]});
      const after=await call('get_cart');
      if(cartQuantity(after,productId)!==initial+quantity)throw Error('Mengden kunne ikke bekreftes.');
      const link=new URL(after.url);if(link.protocol!=='https:'||link.hostname!=='oda.com')throw Error('Ukjent kurvlenke.');
      return shopping.cartReceipt(requestId,{status:'confirmed',productId,quantity,url:link.href});
    }catch{shopping.cartReceipt(requestId,{status:'uncertain'});throw Error('Kurvhandlingen kunne ikke bekreftes. Kontroller handlekurven hos Oda; handlingen gjentas ikke automatisk.');}
  });}
  function status(){const configured=existsSync(path);let connected=!!client;try{connected||=configured&&!!read().tokens;}catch{lastError='Oda-oppsettet kunne ikke leses. Kontroller oppsettet lokalt.';}return {configured,connected,busy,error:lastError};}
  return {readCatalog,refreshPrices,changeCart,swapInCart,probeLimit,tools,authorize,callback,sync,search,addToCart,status,close,cart:()=>exclusive(()=>call('get_cart'))};
}
