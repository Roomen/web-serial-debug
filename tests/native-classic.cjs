const test=require('node:test'),assert=require('node:assert/strict')
const C=require('../js/native-classic.js'),A=require('../js/serial-adapter.js')
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function fake(options={}) {
 const calls=[];let data,event,releases=0
 const service=C.create({isPinned:()=>!!options.pinned,blocked:()=>false,createStreamPort:A.createStreamPort,toBytes:x=>Uint8Array.from(x),Channel:class{},invoke:async(cmd,p)=>{
  calls.push({cmd,p})
  if(cmd==='classic_release_owned'){releases++;if(options.release)await options.release(releases);return releases}
  if(cmd==='classic_discover'){if(options.discover)await options.discover();return{}}
  if(cmd==='classic_devices')return[{deviceId:'fixture',name:'Synthetic',paired:true}]
  if(cmd==='classic_open'){data=p.onData;event=p.onEvent;if(options.open)await options.open();return 1}
  if(cmd==='classic_write'&&options.write)await options.write(p)
 }})
 return {service,calls,data:x=>data.onmessage(x),lost:()=>event.onmessage({type:'lost'}),get releases(){return releases}}
}
async function connect(f){await f.service.run('pair');await f.service.run('connect',{deviceId:'fixture'});assert.equal(f.calls.findLast(c=>c.cmd==='classic_discover').p.ownerGeneration,f.releases);assert.equal(f.calls.findLast(c=>c.cmd==='classic_open').p.ownerGeneration,f.releases)}
test('shared real stream TX/RX, generation/cursor bounds and independent document namespaces',async()=>{
 const f=fake(),g=fake(),backend=A.backend;await connect(f);await connect(g)
 f.data([1,2,255]);await flush();const r=f.service.read();assert.equal(r.hex,'0102ff')
 assert.throws(()=>g.service.read({cursor:r.cursor}),/stale_cursor/)
 assert.throws(()=>f.service.read({cursor:r.cursor+'x'}),/stale_cursor/)
 await f.service.run('write',{generation:f.service.state().generation,hex:'aa bb'});assert.deepEqual(f.calls.at(-1).p.data,[170,187])
 await assert.rejects(f.service.run('write',{generation:0,hex:'aa'}),/stale_generation/)
 assert.equal(A.backend,backend);await f.service.release();assert.throws(()=>f.service.read({cursor:r.cursor}),/stale_cursor/);await g.service.release()
})
test('release during pending open rejects late result and does not start a reader',async()=>{
 const gate=deferred(),f=fake({open:()=>gate.promise});await f.service.run('pair')
 const pending=f.service.run('connect',{deviceId:'fixture'});await flush();await f.service.release();gate.resolve()
 await assert.rejects(pending,/stale_generation/);f.data([1,2]);await flush();assert.equal(f.service.state().received,0);assert.equal(f.service.state().phase,'idle');assert.equal(f.releases,2)
})
test('failed release stays retryable; late discovery cannot populate new document generation',async()=>{
 const gate=deferred(),f=fake({discover:()=>gate.promise,release:n=>{if(n===2)throw Error('native still active')}})
 const pending=f.service.run('discover');await flush();await assert.rejects(f.service.release(),/native still active/);assert.equal(f.service.state().phase,'close-failed')
 await f.service.release();gate.resolve();await assert.rejects(pending,/stale_generation/);assert.deepEqual(f.service.devices(),[]);assert.equal(f.service.state().phase,'idle')
})
test('MCP commit denial has no native effects; cancellation invalidates interactive discovery and waits for user return',async()=>{
 const gate=deferred(),f=fake({discover:()=>gate.promise})
 await assert.rejects(f.service.run('discover',{}, {start:async()=>({code:'expired_before_commit'}),step:()=>null}),/expired_before_commit/)
 assert.equal(f.calls.some(c=>c.cmd==='classic_discover'),false)
 let cancelled=false
 const pending=f.service.run('pair',{}, {start:async()=>null,step:()=>cancelled?{code:'cancelled'}:null});await flush();cancelled=true
 await new Promise(r=>setTimeout(r,130));assert.equal(f.releases,2)
 gate.resolve();await assert.rejects(pending,/stale_generation/);assert.deepEqual(f.service.devices(),[])
})
test('initial stale-owner drain failure can recover through explicit release retry',async()=>{
 const f=fake({release:n=>{if(n===1)throw Error('old document still active')}});await flush()
 assert.equal(f.service.state().phase,'close-failed');await assert.rejects(f.service.run('discover'),/old document still active/)
 await f.service.release();await connect(f);assert.equal(f.service.state().phase,'connected');await f.service.release()
})

test('update busy covers initial drain, system dialog, queued writes and failed physical release',async()=>{
 const init=deferred(),dialog=deferred(),write=deferred();let failClose=false
 const f=fake({release:n=>n===1?init.promise:failClose?Promise.reject(Error('close failed')):undefined,discover:()=>dialog.promise,write:()=>write.promise})
 assert.equal(f.service.isBusyForUpdate(),true);init.resolve();await flush();assert.equal(f.service.isBusyForUpdate(),false)
 const pairing=f.service.run('pair');assert.equal(f.service.isBusyForUpdate(),true);await flush();assert.equal(f.service.state().phase,'system-dialog');assert.equal(f.service.isBusyForUpdate(),true)
 dialog.resolve();await pairing;assert.equal(f.service.isBusyForUpdate(),false)
 await f.service.run('connect',{deviceId:'fixture'});assert.equal(f.service.isBusyForUpdate(),false,'idle reader is not active I/O')
 const p={generation:f.service.state().generation,hex:'aa'},a=f.service.run('write',p),b=f.service.run('write',p)
 assert.equal(f.service.isBusyForUpdate(),true);await flush();assert.equal(f.service.isBusyForUpdate(),true)
 write.resolve();await Promise.all([a,b]);assert.equal(f.service.isBusyForUpdate(),false)
 failClose=true;await assert.rejects(f.service.release());assert.equal(f.service.isBusyForUpdate(),true)
 failClose=false;await f.service.release();assert.equal(f.service.isBusyForUpdate(),false)
})

test('real Classic system interaction prevents update download and prepare release',async()=>{
 const gate=deferred(),f=fake({discover:()=>gate.promise}),pairing=f.service.run('pair');await flush()
 let installs=0,serial=0;const ack=[]
 const controller=require('../js/app-update.js').createController({check:async()=>({version:'test'}),install:async()=>{installs++},ack:async(...args)=>ack.push(args),setPreparing(){}},{AppPlatform:{service:n=>n==='classic'?f.service:null},serialApi:{isPinned:()=>false,prepareForAppUpdate:async()=>{serial++}},sessionStorage:{length:0}})
 await controller.check();assert.equal(await controller.install(),false);await controller.prepare({operationId:1})
 assert.equal(installs,0);assert.equal(serial,0);assert.equal(f.releases,1);assert.equal(ack[0][1],false)
 gate.resolve();await pairing;controller.finished({operationId:1,success:false});await controller.prepare({operationId:2})
 assert.equal(f.releases,2);assert.equal(serial,1);assert.equal(ack[1][1],true)
})

test('SPP lane port uses common stream contract without independent RX reader; classic MCP connect is mutually exclusive',async()=>{
 const f=fake();await f.service.run('pair');const port=f.service.createPort('fixture');assert.equal(port.getInfo().transport,'bt-classic')
 await port.open({baudRate:9600});const r=port.readable.getReader();f.data([1,2]);assert.deepEqual([...((await r.read()).value)],[1,2]);assert.equal(f.service.state().received,0)
 await assert.rejects(f.service.run('connect',{deviceId:'fixture'}),/already_open/)
 const w=port.writable.getWriter();await w.write(Uint8Array.of(255));w.releaseLock();assert.deepEqual(f.calls.at(-1).p.data,[255])
 await r.cancel();r.releaseLock();await port.close();await port.open({});await port.close();await f.service.release()
})
test('owner release invalidates a SPP lane stream and late events cannot reach its reader',async()=>{
 const f=fake();await f.service.run('pair');const port=f.service.createPort('fixture');await port.open({});const r=port.readable.getReader(),read=r.read()
 await f.service.release();await assert.rejects(read);r.releaseLock();f.data([1,2]);await flush();assert.equal(port.readable,null)
})

test('legacy Classic operations cannot interrupt a pinned communication lane',async()=>{
 const options={},f=fake(options);await f.service.run('pair');const port=f.service.createPort('fixture');await port.open({});options.pinned=true
 const before=f.calls.length;await assert.rejects(f.service.run('close'),/先停止事务/);assert.equal(f.calls.length,before)
 assert.throws(()=>f.service.read(),/serial_read/);assert.equal(f.service.state().laneOwned,true)
 options.pinned=false;await port.close();await f.service.release()
})
