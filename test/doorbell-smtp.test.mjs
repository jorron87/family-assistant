import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {createDoorbellSmtp} from '../src/doorbell-smtp.mjs';

test('local SMTP requires camera identity and authentication, accepts alarms and refuses relaying',async()=>{
 const messages=[];
 const server=createDoorbellSmtp({host:'127.0.0.1',cameraIp:'127.0.0.1',port:0,username:'test-camera',password:'test-password',onMessage:m=>messages.push(m)});
 await server.listen();const socket=connect(server.address().port,'127.0.0.1');let output='',waiter;
 socket.setEncoding('utf8');socket.on('data',value=>{output+=value;waiter?.();});
 const expect=async(code)=>{const at=Date.now();while(!output.includes(code)){if(Date.now()-at>2000)throw Error('SMTP test timed out');await new Promise(resolve=>{waiter=resolve;setTimeout(resolve,20);});}const text=output;output='';return text;};
 const send=async(line,code)=>{socket.write(line+'\r\n');return expect(code);};
 try{
  await expect('220');await send('EHLO camera','250 SIZE');
  await send('MAIL FROM:<camera@doorbell.local>','530');
  const auth=Buffer.from('\0test-camera\0wrong-password').toString('base64');await send('AUTH PLAIN '+auth,'535');
  await send('AUTH LOGIN','334 VXN');await send(Buffer.from('test-camera').toString('base64'),'334 UGF');await send(Buffer.from('test-password').toString('base64'),'235');
  await send('MAIL FROM:<camera@doorbell.local>','250');await send('RCPT TO: <anyone@example.com>','550');await send('RCPT TO: <dashboard@doorbell.local>','250');
  await send('DATA','354');await send('Subject: alarm\r\n\r\n..Camera event\r\n.','250');
  assert.deepEqual(messages,['Subject: alarm\r\n\r\n.Camera event']);
  await send('QUIT','221');
 }finally{socket.destroy();server.close();}
});

test('SMTP rejects a non-camera connection before accepting any data',async()=>{
 const server=createDoorbellSmtp({host:'127.0.0.1',cameraIp:'192.0.2.28',port:0,username:'test',password:'test',onMessage:()=>assert.fail('wrong source accepted')});
 await server.listen();const socket=connect(server.address().port,'127.0.0.1');let response='';socket.on('data',chunk=>response+=chunk);
 try{await new Promise((resolve,reject)=>{socket.once('end',resolve);socket.once('error',reject);});assert.match(response,/554 Camera only/);}finally{socket.destroy();server.close();}
});
