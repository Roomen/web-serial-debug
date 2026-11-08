const test = require('node:test'), assert = require('node:assert/strict')
const B = require('../js/native-ble.js'), A = require('../js/serial-adapter.js')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)) }
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const s1='00000001-0000-0000-0000-000000000001', s2='00000002-0000-0000-0000-000000000002'
const chars=[{id:0,service:s1,characteristic:s2,props:8},{id:1,service:s2,characteristic:s1,props:16}]
const device={deviceId:'synthetic',name:'Fixture',services:[s1]}
function setup(options={}) {
 const calls=[]; let data,event,generation=0
 const service=B.create({createStreamPort:A.createStreamPort,Channel:class{},toBytes:b=>Uint8Array.from(b),blocked:()=>false,invoke:async (command,p) => {
  calls.push({command,p})
  if(command==='ble_release_owned') { if(options.release) await options.release(); return ++generation }
  if(command==='ble_scan') { if(options.scan) await options.scan(); return [device] }
  if(command==='ble_open') { data=p.onData; event=p.onEvent; if(options.open) await options.open(); return {handle:7,characteristics:options.chars||chars} }
  if(command==='ble_start'&&options.start) await options.start(p, data)
  if(command==='ble_close'&&options.close) await options.close()
  if(command==='ble_write'&&options.write) await options.write(p)
 }})
 return {service,calls,data:b=>data.onmessage(b),lost:()=>event.onmessage({type:'lost'})}
}
async function prepare(h) { await h.service.scan(); const r=await h.service.inspect(device); return h.service.createPort(r,B.mapping(r.chars,0,1,true),0,1) }
test('broadcast name and optional service filters AND; invalid UUID cannot become unfiltered scan results',()=>{
 assert.deepEqual(B.filterDevices([device,{...device,name:'Other',deviceId:'other'}],'fix',s1),[device])
 assert.deepEqual(B.filterDevices([device],'fix',s2),[])
 assert.throws(()=>B.filterDevices([device],'','abcd'),/128-bit/)
})
test('cross-service direction mapping, write-mode validation, duplicate UUID reconnect rejection',()=>{
 const profile=B.mapping(chars,0,1,true);assert.equal(profile.tx.service,s1);assert.equal(profile.rx.service,s2)
 assert.deepEqual(B.match(chars,profile),{tx:0,rx:1})
 assert.throws(()=>B.mapping(chars,0,1,false),/写模式/)
 assert.throws(()=>B.mapping(chars,'',1,true),/选择/)
 assert.throws(()=>B.match([...chars,{...chars[0],id:2}],profile),/不唯一/)
 assert.throws(()=>B.match([{...chars[0],props:4},chars[1]],profile),/不匹配/)
})
test('discovery does not mark stream ready; subscription precedes open, early RX queued; close/reconnect validates mapping',async()=>{
 const gate=deferred(),h=setup({start:async(p,data)=>{data.onmessage([1,2]);await gate.promise}})
 const {port}=await prepare(h); assert.equal(h.service.isBusyForUpdate(),true)
 const opening=port.open({});await flush();assert.equal(port.readable,null);gate.resolve();await opening
 assert.equal(h.service.isBusyForUpdate(),false)
 const reader=port.readable.getReader();assert.deepEqual([...((await reader.read()).value)],[1,2])
 const writer=port.writable.getWriter();await writer.write(Uint8Array.of(3,4));writer.releaseLock()
 assert.deepEqual(h.calls.find(c=>c.command==='ble_write').p.data,[3,4])
 await reader.cancel();reader.releaseLock();await port.close();await port.open({});await port.close()
 assert.equal(h.calls.filter(c=>c.command==='ble_open').length,2);await h.service.release()
})
test('device loss nulls streams, releases native handle and suppresses late RX',async()=>{
 const h=setup(),{port}=await prepare(h);await port.open({});const r=port.readable.getReader()
 const read=r.read();h.lost();await assert.rejects(read);r.releaseLock();await flush()
 assert.equal(port.readable,null);assert.equal(port.writable,null);assert.ok(h.calls.some(c=>c.command==='ble_close'))
 h.data([9]);await h.service.release()
})
test('failed physical close remains retryable and blocks update; no second BLE connection',async()=>{
 let fail=true;const h=setup({close:()=>{if(fail)throw Error('not closed')}}),{port}=await prepare(h);await port.open({})
 await assert.rejects(port.close(),/not closed/);assert.equal(h.service.isBusyForUpdate(),true)
 await assert.rejects(h.service.inspect(device),/现有/);fail=false;await port.close();assert.equal(h.service.isBusyForUpdate(),false);await h.service.release()
})
test('cancel pending native open cleans late handle; pending scan cannot publish stale results',async()=>{
 const gate=deferred(),h=setup({open:()=>gate.promise});await h.service.scan()
 const opening=h.service.inspect(device);await flush();await h.service.release();gate.resolve();await assert.rejects(opening,/取消/)
 assert.ok(h.calls.some(c=>c.command==='ble_close'));assert.equal(h.service.isBusyForUpdate(),false)
 const scan=deferred(),g=setup({scan:()=>scan.promise});const waiting=g.service.scan();await flush();await g.service.release();scan.resolve();await assert.rejects(waiting,/取消/)
})
test('subscription failure releases prepared handle and discard closes a port rejected by lane binding',async()=>{
 const h=setup({start:()=>{throw Error('notify denied')}}),{port}=await prepare(h)
 await assert.rejects(port.open({}),/notify denied/);assert.equal(port.readable,null);assert.equal(h.service.canSelect(),true)
 const other=await prepare(h);await other.discard();assert.equal(h.service.canSelect(),true);await h.service.release()
})
test('pending writes block update and guard prevents IO after owner release',async()=>{
 const gate=deferred(),h=setup({write:()=>gate.promise}),{port}=await prepare(h);await port.open({})
 const w=port.writable.getWriter(),writing=w.write(Uint8Array.of(1));await flush();assert.equal(h.service.isBusyForUpdate(),true)
 gate.resolve();await writing;w.releaseLock();await h.service.release();await flush();assert.equal(port.writable,null)
})
