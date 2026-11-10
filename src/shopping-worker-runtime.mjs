import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {readConfig} from './config.mjs';
import {findCodex} from './phone-dispatch.mjs';

export const workerFinalSchema={type:'object',additionalProperties:false,properties:{outcome:{type:'string',enum:['done','deferred','needs-browser','safety-stop']},summary:{type:'string'},reason:{type:'string'}},required:['outcome','summary','reason']};
export function shoppingWorkerArgs(config,{directory,schemaFile,resultFile,mcpScript}){
 if(!config.model)throw Error('An explicitly configured model is required.');
 const args=['exec','--skip-git-repo-check','--ephemeral','--ignore-user-config','-C',directory,'-m',config.model,'-s','read-only','--output-schema',schemaFile,'-o',resultFile,'--json'];
 const overrides={model_reasoning_effort:config.reasoningEffort??'high',approval_policy:'never',web_search:config.workerWebSearch===false?'disabled':'live','features.shell_tool':false,'features.apps':false,'features.plugins':false,'features.remote_plugin':false,'features.multi_agent':false,'features.browser_use':false,'features.browser_use_external':false,'features.computer_use':false,'features.code_mode_host':true,'features.image_generation':false,'features.hooks':false,'features.skill_mcp_dependency_install':false,'features.workspace_dependencies':false,'skills.include_instructions':false,'skills.bundled.enabled':false,'mcp_servers.shopping.command':process.execPath,'mcp_servers.shopping.args':[mcpScript],'mcp_servers.shopping.env_vars':['FAMILIEN_WORKER_ENDPOINT','FAMILIEN_WORKER_ID','FAMILIEN_WORKER_TOKEN']};
 for(const [key,value]of Object.entries(overrides))args.push('-c',key+'='+JSON.stringify(value));
 // Only these four application-owned capabilities perform the household's
 // authorized review work. Other MCP/app tools are absent, not auto-approved.
 for(const name of ['shopping_context','shopping_read','shopping_propose','shopping_checkpoint'])args.push('-c','mcp_servers.shopping.tools.'+name+'.approval_mode="approve"');
 args.push('-');return args;
}
export function createShoppingWorkerLauncher({readAgentConfig=()=>readConfig('agent.json'),spawnProcess=spawn,executable=findCodex}={}){
 return ({root,directory,workerId,token,endpoint,prompt,deadlineMs,onExit})=>{
  const config=readAgentConfig();if(config.enabled!==true)throw Error('The owner has paused the agent.');
  const cli=executable();if(!cli)throw Error('Configured Codex runtime unavailable.');
  mkdirSync(directory,{recursive:true});
  const schemaFile=join(directory,'result.schema.json'),resultFile=join(directory,'result.json'),specFile=join(directory,'worker.json');
  writeFileSync(schemaFile,JSON.stringify(workerFinalSchema),'utf8');
  const args=shoppingWorkerArgs(config,{directory,schemaFile,resultFile,mcpScript:resolve(root,'src/shopping-worker-mcp.mjs')});
  writeFileSync(specFile,JSON.stringify({executable:cli,args,prompt,resultFile,deadlineMs,model:config.model,reasoningEffort:config.reasoningEffort??'high'}),'utf8');
  // The supervisor owns the Codex child even if the web service restarts. It
  // cancels its own child on capability revocation or lost heartbeats.
  const child=spawnProcess(process.execPath,[resolve(root,'src/shopping-worker-supervisor.mjs'),specFile],{cwd:directory,windowsHide:true,stdio:'ignore',env:{...process.env,FAMILIEN_WORKER_ENDPOINT:endpoint,FAMILIEN_WORKER_ID:workerId,FAMILIEN_WORKER_TOKEN:token}});
  let ended=false;const finish=code=>{if(!ended){ended=true;onExit(code);}};child.once('error',()=>finish(-1));child.once('close',finish);return {pid:child.pid,resultFile};
 };
}
export const launchShoppingWorker=createShoppingWorkerLauncher();
