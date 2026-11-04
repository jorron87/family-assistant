// Loaded by the existing FamilienWeb task. Observe failures without suppressing
// Node's normal exit or replacing the scheduler's recovery behaviour.
const {appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync} = require('node:fs');
const {join} = require('node:path');
const logDirectory = join(process.env.LOCALAPPDATA, 'Familien', 'logs');
const logFile = join(logDirectory, 'web-process.log');
function record(kind, details) {
  try {
    mkdirSync(logDirectory, {recursive:true});
    if (existsSync(logFile) && statSync(logFile).size > 1024*1024) {
      if (existsSync(logFile+'.previous')) unlinkSync(logFile+'.previous');
      renameSync(logFile, logFile+'.previous');
    }
    appendFileSync(logFile, JSON.stringify({at:new Date().toISOString(),pid:process.pid,kind,...details})+'\n');
  } catch {} // A logging failure must not stop the family service.
}
record('start', {});
process.on('uncaughtExceptionMonitor', (error, origin) => record('crash', {origin,error:String(error.stack ?? error)}));
process.on('exit', code => record('exit', {code}));
