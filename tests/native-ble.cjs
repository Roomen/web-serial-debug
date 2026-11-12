const test = require('node:test'), assert = require('node:assert/strict')
const B = require('../js/native-ble.js'), A = require('../js/serial-adapter.js')
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)) }
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const s1='00000001-0000-0000-0000-000000000001', s2='00000002-0000-0000-0000-000000000002'
const chars=[{id:0,service:s1,characteristic:s2,props:8},{id:1,service:s2,characteristic:s1,props:16}]
const device={deviceId:'synthetic',name:'Fixture',services:[s1]}
function setup(options={}) {
 const calls=[]; let data,event,generation=0,scanDone,scanChannel,nextHandle=6
 const service=B.create({createStreamPort:A.createStreamPort,Channel:class{},toBytes:b=>Uint8Array.from(b),blocked:()=>false,boundPorts:()=>options.boundPorts ? options.boundPorts() : [],invoke:async (command,p) => {
  calls.push({command,p})
  if(command==='ble_release_owned') { if(options.release) await options.release(); if(scanDone)scanDone(); return ++generation }
  if(command==='ble_scan') {
   const at=generation; if(options.scan) await options.scan(); if(at!==generation)throw Error('取消')
   scanChannel=p.onDevice; scanChannel.onmessage({type:'started'})
   scanChannel.onmessage({type:'device',device})
   await new Promise(resolve=>{scanDone=resolve})
  }
  if(command==='ble_scan_stop') { if(options.stop)await options.stop(); if(scanDone)scanDone() }
  if(command==='ble_open') { data=p.onData; event=p.onEvent; if(options.open) await options.open(); return {handle:++nextHandle,characteristics:options.chars||chars} }
  if(command==='ble_start'&&options.start) await options.start(p, data)
  if(command==='ble_close'&&options.close) await options.close()
  if(command==='ble_write'&&options.write) await options.write(p)
 }})
 return {service,calls,event:()=>event,data:b=>data.onmessage(b),advertise:d=>scanChannel.onmessage({type:'device',device:d}),scanChannel:()=>scanChannel,lost:()=>event.onmessage({type:'lost'})}
}
async function scanned(h) { const job=h.service.scan(); await flush(); await h.service.stopScan(); await job }
async function prepare(h) { await scanned(h); const r=await h.service.inspect(device); return h.service.createPort(r,B.mapping(r.chars,0,1,true),0,1) }
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
 const gate=deferred(),h=setup({open:()=>gate.promise});await scanned(h)
 const opening=h.service.inspect(device);await flush();await h.service.release();gate.resolve();await assert.rejects(opening,/取消/)
 assert.ok(h.calls.some(c=>c.command==='ble_close'));assert.equal(h.service.isBusyForUpdate(),false)
 const scan=deferred(),g=setup({scan:()=>scan.promise});const waiting=g.service.scan();const rejected=assert.rejects(waiting,/取消/);await flush();await g.service.release();scan.resolve();await flush();await g.service.stopScan().catch(()=>{});await rejected
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

test('stream scan deduplicates advertisements, stop drains and rejects stale callbacks without invalidating preferences',async()=>{
 const h=setup(),updates=[],job=h.service.scan(d=>updates.push(d));await flush()
 assert.equal(updates.length,1);assert.equal(h.service.isBusyForUpdate(),true)
 h.advertise({...device,rssi:-40});h.advertise({...device,rssi:null,services:[s2]})
 assert.equal(h.service.devices().length,1);assert.equal(h.service.devices()[0].rssi,null)
 assert.deepEqual(h.service.devices()[0].services,[s1,s2])
 h.service.remember(device.deviceId,{alias:'My fixture',profile:B.mapping(chars,0,1,true)})
 const old=h.scanChannel();await h.service.stopScan();await job
 old.onmessage({type:'device',device:{...device,name:'stale'}})
 assert.notEqual(h.service.devices()[0].name,'stale');assert.equal(h.service.preference(device.deviceId).alias,'My fixture')
 assert.deepEqual(h.service.preference('another'),{});assert.equal(h.service.isBusyForUpdate(),false)
 const record=await h.service.inspect(device);await h.service.close(record);await h.service.release()
 assert.deepEqual(h.service.preference(device.deviceId),{});old.onmessage({type:'device',device});assert.equal(h.service.devices().length,0)
})
test('stop requested before registration waits for handshake before native stop',async()=>{
 const gate=deferred(),h=setup({scan:()=>gate.promise}),job=h.service.scan();await flush()
 const stopping=h.service.stopScan();await flush()
 assert.equal(h.calls.some(c=>c.command==='ble_scan_stop'),false)
 gate.resolve();await stopping;await job
 assert.equal(h.calls.filter(c=>c.command==='ble_scan_stop').length,1)
})
test('quick filters handle UUID/alias substrings, unknown RSSI, ordering and invalid threshold',()=>{
 const list=[{deviceId:'a',name:'Zulu',services:[s1],rssi:null,seen:1},{deviceId:'b',name:'Beta',alias:'Meter',services:[s2],rssi:-60,seen:3},{deviceId:'c',name:'Alpha',services:[],rssi:-40,seen:2}]
 assert.deepEqual(B.visibleDevices(list,'meter').map(d=>d.deviceId),['b'])
 assert.deepEqual(B.visibleDevices(list,'00000001').map(d=>d.deviceId),['a'])
 assert.deepEqual(B.visibleDevices(list,'','-70').map(d=>d.deviceId),['c','b'])
 assert.deepEqual(B.visibleDevices(list,'','','name').map(d=>d.deviceId),['c','b','a'])
 assert.deepEqual(B.visibleDevices(list,'','','recent').map(d=>d.deviceId),['b','c','a'])
 assert.throws(()=>B.visibleDevices(list,'','nope'),/RSSI/)
})
test('contextual picker release cannot close an active lane',async()=>{
 const h=setup(),{port}=await prepare(h);await port.open({});const before=h.calls.length
 await assert.rejects(h.service.releasePicker(),/本路断开/);assert.equal(h.calls.length,before)
 await port.close();await h.service.release()
})

test('stream registry is bounded across unique advertisements and still updates retained devices',async()=>{
 const h=setup(),job=h.service.scan();await flush()
 for(let i=0;i<300;i++)h.advertise({...device,deviceId:'fixture-'+i})
 assert.equal(h.service.devices().length,256)
 h.advertise({...device,rssi:-33});assert.equal(h.service.devices().find(d=>d.deviceId===device.deviceId).rssi,-33)
 await h.service.stopScan();await job;await h.service.release()
})

test('repeated equivalent unbound choices reuse a fully closed port and adopt each freshly inspected handle',async()=>{
 let bound=null;const h=setup({boundPorts:()=>bound?[bound]:[]});await scanned(h)
 let original
 for(let i=0;i<8;i++){
  bound=null // only unbound choices may be reused; selected lanes are immutable
  const record=await h.service.inspect(device),handle=record.handle
  // Equivalent selectors do not depend on object property order.
  const profile=B.mapping(record.chars,0,1,true)
  if(i)profile.tx={props:profile.tx.props,characteristic:profile.tx.characteristic,service:profile.tx.service}
  const choice=h.service.createPort(record,profile,0,1)
  if(!original)original=choice.port;else assert.equal(choice.port,original)
  assert.equal(h.calls.filter(c=>c.command==='ble_open').length,i+1)
  bound=choice.port;await choice.port.open({})
  assert.equal(h.calls.findLast(c=>c.command==='ble_start').p.handle,handle)
  const reader=choice.port.readable.getReader();h.data([i]);assert.deepEqual([...((await reader.read()).value)],[i]);await reader.cancel();reader.releaseLock()
  await choice.port.close();assert.deepEqual(h.service.ports(),[original])
  assert.equal(h.calls.findLast(c=>c.command==='ble_close').p.handle,handle)
 }
 assert.equal(h.calls.filter(c=>c.command==='ble_close').length,8)
 bound=null;await h.service.release()
})
test('profile changes prune obsolete unbound choices, preserve bound ports and never close via enumeration',async()=>{
 let bound=null;const h=setup({chars:[{...chars[0],props:12},chars[1]],boundPorts:()=>bound?[bound]:[]});await scanned(h)
 const choose=async response=>{const record=await h.service.inspect(device);return h.service.createPort(record,B.mapping(record.chars,0,1,response),0,1)}
 const original=await choose(true);bound=original.port;await original.port.open({});await original.port.close()
 const changed=await choose(false);assert.notEqual(changed.port,original.port)
 const before=h.calls.filter(c=>c.command==='ble_close').length
 assert.deepEqual(h.service.ports(),[original.port]);await changed.port.open({})
 assert.deepEqual(h.service.ports(),[original.port,changed.port]);bound=changed.port
 assert.deepEqual(h.service.ports(),[changed.port]);assert.equal(h.calls.filter(c=>c.command==='ble_close').length,before)
 await changed.port.close();bound=null
 for(let i=0;i<10;i++){
  const next=await choose(i%2===0);await next.port.open({});assert.equal(h.service.ports().length,1);await next.port.close()
  assert.equal(h.calls.findLast(c=>c.command==='ble_start').p.profile.response,i%2===0)
 }
 await h.service.release()
})
test('binding refusal discards only new choice; bound closed port stays immutable and reopens original profile',async()=>{
 let bound=null;const h=setup({chars:[{...chars[0],props:12},chars[1]],boundPorts:()=>bound?[bound]:[]});await scanned(h)
 const originalRecord=await h.service.inspect(device),first=h.service.createPort(originalRecord,B.mapping(originalRecord.chars,0,1,true),0,1);bound=first.port
 await first.port.open({});await first.port.close()
 for(const response of [true,false]){
  const record=await h.service.inspect(device),handle=record.handle,next=h.service.createPort(record,B.mapping(record.chars,0,1,response),0,1)
  assert.notEqual(next.port,first.port) // same-profile bound choices must not be adopted either
  const before=h.calls.filter(c=>c.command==='ble_close').length
  assert.deepEqual(h.service.ports(),[first.port]);assert.equal(h.calls.filter(c=>c.command==='ble_close').length,before)
  await next.discard();assert.equal(h.calls.findLast(c=>c.command==='ble_close').p.handle,handle)
  assert.equal(h.service.canSelect(),true);assert.deepEqual(h.service.ports(),[first.port])
  await first.port.open({});const start=h.calls.findLast(c=>c.command==='ble_start').p
  assert.notEqual(start.handle,handle);assert.equal(start.profile.response,true)
  await first.port.close()
 }
 bound=null;await h.service.release()
})
test('discard of a reused unbound choice closes its adopted handle and removes enumeration',async()=>{
 const h=setup(),first=await prepare(h);await first.port.open({});await first.port.close()
 const record=await h.service.inspect(device),handle=record.handle,reused=h.service.createPort(record,B.mapping(record.chars,0,1,true),0,1)
 assert.equal(reused.port,first.port);await reused.discard()
 assert.equal(h.calls.findLast(c=>c.command==='ble_close').p.handle,handle)
 assert.deepEqual(h.service.ports(),[]);assert.equal(h.service.canSelect(),true);await h.service.release()
})

test('ambiguous instance mappings never reuse a prior closed port',async()=>{
 const h=setup({chars:[...chars,{...chars[0],id:2}]}),first=await prepare(h);await first.port.open({});await first.port.close()
 const record=await h.service.inspect(device),next=h.service.createPort(record,B.mapping(record.chars,2,1,true),2,1)
 assert.notEqual(next.port,first.port);await next.port.open({})
 assert.equal(h.calls.findLast(c=>c.command==='ble_start').p.txId,2);assert.deepEqual(h.service.ports(),[next.port])
 await next.port.close();await h.service.release()
})
test('lane disconnect aborts an auto-reopen stuck in the native connect and frees the BLE claim',async()=>{
 // Rust names the handle on the event channel before connecting; ble_close cancels the pending connect.
 let hang=null,handle=40
 const h=setup({open:()=>{ if(!hang) return; const id=++handle; h.event().onmessage({type:'opening',handle:id}); return hang.promise }, close:()=>{ if(hang){ hang.reject(Error('BLE 操作已取消')); hang=null } }})
 const {port}=await prepare(h);await port.open({})
 const r=port.readable.getReader(),read=r.read();h.lost();await assert.rejects(read);r.releaseLock();await flush()
 hang=deferred()
 const reopening=port.open({});await flush()
 assert.equal(typeof port.abortOpen,'function');assert.equal(h.service.isBusyForUpdate(),true)
 await port.abortOpen();await assert.rejects(reopening,/取消/);await flush()
 assert.ok(h.calls.some(c=>c.command==='ble_close'&&c.p.handle===41))
 assert.equal(port.readable,null);assert.equal(h.service.isBusyForUpdate(),false);assert.equal(h.service.canSelect(),true)
 await h.service.release()
})
test('abort before the native handle is known closes it as soon as the opening event arrives',async()=>{
 let hang=null,announce=null
 const h=setup({open:()=>{ if(!hang) return; announce=()=>h.event().onmessage({type:'opening',handle:77}); return hang.promise }, close:()=>{ if(hang){ hang.reject(Error('BLE 操作已取消')); hang=null } }})
 const {port}=await prepare(h);await port.open({});await port.close()
 hang=deferred()
 const reopening=port.open({});await flush()
 await port.abortOpen();announce();await assert.rejects(reopening,/取消/);await flush()
 assert.ok(h.calls.some(c=>c.command==='ble_close'&&c.p.handle===77))
 assert.equal(h.service.isBusyForUpdate(),false);await h.service.release()
})
