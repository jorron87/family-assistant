// Job-scoped stdio bridge. The model never receives its capability token and
// cannot choose an endpoint, lease, worker ID or arbitrary HTTP operation.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {workerTools} from './shopping-worker-contract.mjs';
import {createWorkerToolCaller} from './shopping-worker-transport.mjs';
const endpoint=process.env.FAMILIEN_WORKER_ENDPOINT,workerId=process.env.FAMILIEN_WORKER_ID,token=process.env.FAMILIEN_WORKER_TOKEN;
if(!endpoint||!workerId||!token)throw Error('Missing scoped worker capability.');
const server=new Server({name:'family-shopping-worker',version:'1.0.0'},{capabilities:{tools:{}}});
const call=createWorkerToolCaller({endpoint,workerId,token});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:workerTools}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
 if(!workerTools.some(t=>t.name===params.name))throw Error('Unknown worker tool.');
 return call(params.name,params.arguments??{});
});
process.stdin.on('end',()=>process.exit(0));
await server.connect(new StdioServerTransport());
