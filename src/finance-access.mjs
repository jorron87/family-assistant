// Adult PIN sessions for finance on browsers that are not an enrolled adult phone,
// such as the household PC. Sessions live in memory only: a restart locks everything.
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

const SCRYPT={N:2**15,r:8,p:1,maxmem:96*1024*1024};
export const PIN_PATTERN=/^\d{6,12}$/;

export function hashPin(pin) {
  if (!PIN_PATTERN.test(pin)) throw Error('PIN-koden må være 6–12 sifre.');
  const salt=randomBytes(16);
  return 'scrypt:'+salt.toString('base64')+':'+scryptSync(pin,salt,32,SCRYPT).toString('base64');
}

export function verifyPin(pin, stored) {
  const [kind,salt,key]=String(stored||'').split(':');
  if (kind!=='scrypt'||!salt||!key||!PIN_PATTERN.test(String(pin))) return false;
  const expected=Buffer.from(key,'base64');
  const actual=scryptSync(String(pin),Buffer.from(salt,'base64'),expected.length,SCRYPT);
  return timingSafeEqual(actual,expected);
}

export function createFinanceSessions({clock=Date.now, idleMs=20*60000, maxMs=8*3600000, maxFailures=5, lockoutMs=15*60000}={}) {
  const sessions=new Map();
  let failures=[];
  function prune() {
    const now=clock();
    for (const [id,s] of sessions) if (now-s.seen>idleMs||now-s.created>maxMs) sessions.delete(id);
    failures=failures.filter(t=>now-t<lockoutMs);
  }
  return {
    unlock(pin, owners) {
      prune();
      if (failures.length>=maxFailures) throw Error('For mange feil PIN-forsøk. Vent et kvarter.');
      const owner=owners.find(o=>o.pinHash&&verifyPin(pin,o.pinHash));
      if (!owner) {failures.push(clock());throw Error('Feil PIN-kode.');}
      failures=[];
      const id=randomBytes(32).toString('hex'),now=clock();
      sessions.set(id,{owner:owner.id,created:now,seen:now});
      return {id,owner:owner.id,idleMinutes:Math.round(idleMs/60000)};
    },
    check(id) {
      prune();
      const s=id&&sessions.get(id);
      if (!s) return null;
      s.seen=clock();
      return s.owner;
    },
    lock(id) {sessions.delete(id);},
    lockOwner(ownerId) {for (const [id,s] of sessions) if (s.owner===ownerId) sessions.delete(id);}
  };
}

export const SESSION_COOKIE='familien_finance';
export function readCookie(req, name=SESSION_COOKIE) {
  return String(req.headers.cookie??'').split(';').map(item=>item.trim()).find(item=>item.startsWith(name+'='))?.slice(name.length+1)||null;
}
export function sessionCookie(id, {path, secure, clear=false}) {
  return `${SESSION_COOKIE}=${clear?'':id}; HttpOnly; SameSite=Strict; Path=${path}${clear?'; Max-Age=0':''}${secure?'; Secure':''}`;
}
