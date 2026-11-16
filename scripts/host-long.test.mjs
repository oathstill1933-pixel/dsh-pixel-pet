// Full production route, fake host/agent/Python child; no real service/network/model/audio.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/host.js'
process.env.PIXELPET_NO_AUTO_INSTALL='1'
let passed=0
const effects=[],keys=[],children=[],calls=[]
let route, handler, attachmentGate
const agent={followup:async msg=>{calls.push(msg)}}
const ctx={logger:{warn(){},info(){}},
  agents:{get:id=>['s1','session-s1'].includes(id)?agent:undefined},
  get(name){return {
    webServer:{register:r=>{route=r;return ()=>{}}},
    sessions:{list:()=>[{id:'session-s1'}]},sessionTitle:{get:()=>({title:'synthetic'})},
    tools:{register:()=>()=>{}},
    attachments:{admitPromptContent:async content=>{if(attachmentGate)await attachmentGate;return content}},
  }[name]},
  on(name,fn){if(name==='session/event')handler=fn;return ()=>{}},
  effect(fn){effects.push(fn())},
}
const child=()=>{const c=new EventEmitter();c.exitCode=null;c.signalCode=null;c.stderr=new EventEmitter();c.kill=()=>{c.exitCode=0;c.emit('exit',0)};children.push(c);return c}
apply(ctx,{dataDir:mkdtempSync(join(tmpdir(),'pixelpet-long-http-')),autoInstall:false,
  pythonManager:{path:'synthetic-python',quick:()=>'',detect:async()=>({}),snapshot:()=>({})},
  spawn:(exe,args,options)=>{keys.push(options.env.PIXELPET_BRIDGE_KEY);return child()},
})
const response=()=>{let code=0,buf;return{res:{writeHead:c=>{code=c},end:b=>{buf=b}},result:()=>({code,body:buf?JSON.parse(Buffer.from(buf).toString('utf8')):null})}}
function begin(path,body,key,delayed=false){
  const req=new PassThrough();req.method=path==='/api/relay/status'?'GET':'POST';req.url='/dsh-pixel-pet'+path
  req.headers={host:'127.0.0.1:3080',...(key?{'x-pixelpet-key':key}:{})}
  const r=response();const running=route.handler(req,r.res)
  const end=()=>req.end(body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body))
  if(!delayed)end()
  return{req,end,promise:running.then(()=>r.result())}
}
const call=(path,body,key)=>begin(path,body,key).promise
const emit=(type,data)=>handler({id:'session-s1'},{type,data})
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve()}
const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name)}
const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=','base64')
try{
  await call('/api/pet/start');let key=keys.at(-1)
  await check('new protocol capability is discoverable',async()=>assert.equal((await call('/api/relay/status')).body.protocol,1))
  await check('receipt routes require per-launch key',async()=>{
    const r=await call('/api/ask/start',{sessionId:'s1',requestId:'req-http-one',text:'synthetic'})
    assert.equal(r.code,401);assert.equal(calls.length,0)
  })
  const shot=await call('/api/shot',tinyPng,key);assert.ok(shot.body.id)
  const payload={sessionId:'s1',requestId:'req-http-one',text:'synthetic',shots:[shot.body.id]}
  await check('start returns receipt before final model turn',async()=>{
    const r=await call('/api/ask/start',payload,key);assert.equal(r.code,202);await tick()
    assert.equal(calls.length,1);assert.equal(calls[0].content.filter(b=>b.type==='image').length,1)
    const p=await call('/api/ask/result',{sessionId:'s1',requestId:payload.requestId,waitMs:0},key)
    assert.equal(p.body.accepted,true);assert.equal(p.body.state,'pending')
  })
  await check('repeat UUID works after screenshot cache consumed and does not resend',async()=>{
    const r=await call('/api/ask/start',payload,key);assert.ok(r.code===200||r.code===202)
    assert.equal(calls.length,1)
  })
  await check('same UUID with changed payload is rejected',async()=>{
    const r=await call('/api/ask/start',{...payload,text:'different'},key)
    assert.equal(r.code,409);assert.equal(r.body.delivery,'not-sent');assert.equal(calls.length,1)
  })
  await check('wrong session cannot obtain another result',async()=>{
    const r=await call('/api/ask/result',{sessionId:'other',requestId:payload.requestId,waitMs:0},key)
    assert.equal(r.code,404)
  })
  await check('full route waits after acceptance then delivers only correct-turn answer',async()=>{
    emit('turn/start',{turn:87});emit('user/message',calls[0])
    let done=false
    const p=call('/api/ask/result',{sessionId:'s1',requestId:payload.requestId,waitMs:10000,accepted:true},key).then(r=>{done=true;return r})
    await tick();assert.equal(done,false)
    emit('assistant/message',{turn:87,message:{content:[{type:'text',text:'correct synthetic reply'}]}})
    emit('assistant/message',{turn:86,message:{content:[{type:'text',text:'stale reply'}]}})
    emit('turn/end',{turn:87,reason:{kind:'completed'}})
    const r=await p;assert.equal(r.body.reply,'correct synthetic reply');assert.equal(r.body.state,'completed')
  })
  await check('old authenticated request cannot acquire new launch owner across readBody await',async()=>{
    const before=calls.length
    const p=begin('/api/ask/start',{sessionId:'s1',requestId:'req-owner-race',text:'must never send'},key,true)
    await call('/api/pet/stop');await call('/api/pet/start');key=keys.at(-1)
    p.end();const r=await p.promise
    assert.equal(r.code,401);assert.equal(calls.length,before)
  })
  await check('definitely offline submission is reported not-sent rather than accepted',async()=>{
    const payload={sessionId:'nobody',requestId:'req-offline-test',text:'synthetic'}
    assert.equal((await call('/api/ask/start',payload,key)).code,202);await tick()
    const r=await call('/api/ask/result',{...payload,waitMs:0},key)
    assert.equal(r.body.state,'failed');assert.equal(r.body.delivery,'not-sent');assert.equal(r.body.accepted,false)
  })
  console.log(`host-long: ${passed} passed, 0 failed`)
}finally{for(const cleanup of effects.reverse())if(typeof cleanup==='function')await cleanup()}
