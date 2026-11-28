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
 assert.equal(h.calls.filter(c=>c.command==='ble_open').length,1);assert.equal(h.service.canSelect(),true)
 const next=await h.service.inspect(device),reused=h.service.createPort(next,B.mapping(next.chars,0,1,true),0,1)
 assert.equal(reused.port,port);await reused.discard()
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
test('stale timeout filters silent devices and LRU eviction drops oldest inactive device at 256 limit',async()=>{
 const now=100000
 const list=[
  {deviceId:'fresh',name:'M1',services:[],rssi:-50,seen:now-5000},
  {deviceId:'stale',name:'M2',services:[],rssi:-40,seen:now-15001},
 ]
 assert.deepEqual(B.visibleDevices(list,'','','signal',{now,staleMs:B.STALE_MS}).map(d=>d.deviceId),['fresh'])
 const h=setup(),job=h.service.scan();await flush()
 for(let i=0;i<260;i++)h.advertise({...device,deviceId:'d-'+i,name:'Meter'})
 const ids=h.service.devices().map(d=>d.deviceId)
 assert.equal(ids.length,256)
 assert.ok(ids.includes('d-259'))
 h.service.clearDevices()
 assert.equal(h.service.devices().length,0)
 await h.service.stopScan();await job;await h.service.release()
})
test('defaultMapping selects FFE1=RX and FFE2=TX by default, respects properties and rejects ambiguous multi-service',()=>{
 const svc='0000ffe0-0000-1000-8000-00805f9b34fb'
 const ffe1='0000ffe1-0000-1000-8000-00805f9b34fb'
 const ffe2='0000ffe2-0000-1000-8000-00805f9b34fb'
 // Both support write+notify -> default FFE1=RX, FFE2=TX
 assert.deepEqual(B.defaultMapping([
  {id:0,service:svc,characteristic:ffe1,props:8|16},
  {id:1,service:svc,characteristic:ffe2,props:8|16},
 ]),{txId:1,rxId:0,response:true})
 // Only writeWithoutResponse on FFE2 -> response=false
 assert.deepEqual(B.defaultMapping([
  {id:0,service:svc,characteristic:ffe1,props:16},
  {id:1,service:svc,characteristic:ffe2,props:4},
 ]),{txId:1,rxId:0,response:false})
 // Strict reverse properties -> FFE1=TX, FFE2=RX
 assert.deepEqual(B.defaultMapping([
  {id:0,service:svc,characteristic:ffe1,props:8},
  {id:1,service:svc,characteristic:ffe2,props:16},
 ]),{txId:0,rxId:1,response:true})
 // Ambiguous across two services -> null
 assert.equal(B.defaultMapping([
  {id:0,service:svc,characteristic:ffe1,props:16},
  {id:1,service:svc,characteristic:ffe2,props:8},
  {id:2,service:s1,characteristic:ffe1,props:16},
  {id:3,service:s1,characteristic:ffe2,props:8},
 ]),null)
})
test('saved BLE devices persist across instances, expose direct ports, avoid GAP name false-positives and merge multi-window writes',async()=>{
 const store=new Map()
 const storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}
 const pid='"550e8400-e29b-41d4-a716-446655440000"'
 const pid2='"550e8400-e29b-41d4-a716-446655440001"'
 const dev={deviceId:'ble-1',persistentId:pid,address:'AA:BB:CC:DD:EE:FF',name:'Meter-A',services:[s1]}
 const dev2={deviceId:'ble-2',persistentId:pid2,address:'AA:BB:CC:DD:EE:02',name:'Meter-2',services:[s1]}
 const profile=B.mapping(chars,0,1,true)
 // Two windows share localStorage: saving in window B must not clobber window A's newly saved device
 const mkSvc=(opts={})=>{
  let scanCh,scanDone
  const s=B.create({
   createStreamPort:A.createStreamPort,Channel:class{},toBytes:b=>Uint8Array.from(b),blocked:()=>false,storage,
   confirmNameChange:opts.confirmNameChange,
   invoke:async(cmd,p)=>{
    if(cmd==='ble_release_owned')return 1
    if(cmd==='ble_scan'){scanCh=p.onDevice;scanCh.onmessage({type:'started'});await new Promise(r=>{scanDone=r})}
    if(cmd==='ble_scan_stop'){if(scanDone)scanDone()}
    if(cmd==='ble_open'){if(opts.onOpen)opts.onOpen(p);return{handle:9,characteristics:chars}}
   },
  })
  return {s,adv:d=>scanCh.onmessage({type:'device',device:d})}
 }
 const winA=mkSvc(),winB=mkSvc()
 winA.s.saveDevice(dev,{alias:'1号表',profile})
 winB.s.saveDevice(dev2,{alias:'2号表',profile})
 assert.equal(winA.s.savedDevices().length,2)
 assert.equal(winB.s.savedDevices().length,2)
 // Third session (simulated reload): direct connect without scan skips broadcast name comparison
 let confirmed=[],allowChange=false,openedPayloads=[]
 const winC=mkSvc({confirmNameChange:async info=>{confirmed.push(info);return allowChange},onOpen:p=>openedPayloads.push(p)})
 const list=winC.s.ports()
 assert.equal(list.length,2)
 const p1=list.find(p=>p.getInfo().blePersistentId===pid)
 assert.equal(p1.getDisplayAlias(),'1号表')
 assert.equal(p1.isPersistentAlias(),true)
 await p1.open({})
 assert.equal(confirmed.length,0)
 assert.equal(openedPayloads[0].persistentId,pid)
 await p1.close()
 // Once an actual advertisement with a different name is observed, direct connect prompts and updates only on confirm
 const scanJob=winC.s.scan();await flush()
 winC.adv({...dev,name:'Meter-B'})
 await winC.s.stopScan();await scanJob
 await assert.rejects(p1.open({}),/广播名已变化/)
 assert.equal(confirmed.length,1);assert.equal(confirmed[0].savedName,'Meter-A');assert.equal(confirmed[0].currentName,'Meter-B')
 assert.equal(winC.s.savedDevice(pid).broadcastName,'Meter-A')
 allowChange=true
 await p1.open({})
 assert.equal(winC.s.savedDevice(pid).broadcastName,'Meter-B')
 await p1.close()
 assert.equal(winC.s.removeSavedDevice(pid),true)
 assert.equal(winC.s.removeSavedDevice(pid2),true)
 assert.equal(winC.s.ports().length,0)
 // Cap saved devices at 128 entries
 for(let i=0;i<135;i++)winC.s.saveDevice({deviceId:'s-'+i,persistentId:'"pid-'+i+'"',name:'M-'+i},{alias:'A'+i,profile})
 assert.equal(winC.s.savedDevices().length,128)
 await winA.s.release();await winB.s.release();await winC.s.release()
})

test('0xFF SK manufacturer data golden vectors, malformed payload rejection, and platform formats',()=>{
 const golden=[
  {
   meterId:[0x49,0x84,0x00,0x21,0x22,0x63,0x09,0x00,0x00,0x00],
   b64:'E0eWHYcK6B571A',
   bcd:'00000009632221008449',
   meterNo:'09632221008449',
   meterNo14:'09632221008449',
   zero:false,
  },
  {
   meterId:[0x01,0x46,0x26,0x02,0x02,0x83,0x00,0x00,0x00,0x00],
   b64:'W4WwPqfq4R571A',
   bcd:'00000000830202264601',
   meterNo:'830202264601',
   meterNo14:'00830202264601',
   zero:false,
  },
  {
   meterId:[0x98,0x76,0x54,0x32,0x10,0x98,0x76,0x54,0x32,0x20],
   b64:'wrXCDrXxl0pJ9A',
   bcd:'20325476981032547698',
   meterNo:'20325476981032547698',
   meterNo14:'20325476981032547698',
   zero:false,
  },
  {
   meterId:[0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00],
   b64:'WsOWPKVp4R571A',
   bcd:'00000000000000000000',
   meterNo:'00000000000000000000',
   meterNo14:'00000000000000',
   zero:true,
  },
 ]
 assert.equal(B.SK_COMPANY_ID,0x4b53)
 for(const g of golden){
  assert.equal(B.encodeMeterIdAdv(g.meterId),g.b64)
  const dec=B.decodeMeterIdAdv(g.b64)
  assert.ok(dec)
  assert.deepEqual([...dec.meterId],g.meterId)
  assert.equal(dec.meterIdBcd,g.bcd)
  assert.equal(dec.meterNo,g.meterNo)
  assert.equal(dec.meterNo14,g.meterNo14)
  assert.equal(dec.meterZero,g.zero)

  // Tauri / bluest / WinRT / Android split companyId = 0x4B53 + 14B data
  const asciiBytes=[...Buffer.from(g.b64,'ascii')]
  assert.equal(B.parseManufacturerMeter({companyId:0x4b53,data:asciiBytes}).meterIdBcd,g.bcd)
  assert.equal(B.parseManufacturerMeter({companyId:0x534b,data:Uint8Array.from(asciiBytes)}).meterIdBcd,g.bcd)
  // CoreBluetooth raw NSData [0x53, 0x4B, ...14B]
  assert.equal(B.parseManufacturerMeter(Uint8Array.from([0x53,0x4b,...asciiBytes])).meterIdBcd,g.bcd)
  // Vendor-prefixed 0xFF [vendorLo, vendorHi, 0x53, 0x4B, ...14B]
  assert.equal(B.parseManufacturerMeter({companyId:0x0102,data:[0x53,0x4b,...asciiBytes]}).meterIdBcd,g.bcd)
  assert.equal(B.parseManufacturerMeter(Uint8Array.from([0x01,0x02,0x53,0x4b,...asciiBytes])).meterIdBcd,g.bcd)
  // Web Bluetooth manufacturerData Map<number, DataView>
  const rawBuf=new Uint8Array([0xff,...asciiBytes,0xff])
  const wbMap=new Map([[0x4b53,new DataView(rawBuf.buffer,1,14)]])
  assert.equal(B.parseManufacturerMeter(wbMap).meterIdBcd,g.bcd)
 }

 // Strict rejection: non-zero low 4 bits in 14th char, URL-safe chars, padding, truncation, trailing bytes
 for(const bad of [
  'E0eWHYcK6B571B',
  'E0eWHYcK6B571C',
  'E0eWHYcK6B571P',
  'E0eWHYcK6B571-',
  'E0eWHYcK6B571_',
  'E0eWHYcK6B57==',
  'E0eWHYcK6B57 0',
  'E0eWHYcK6B57\x00A',
  'short',
  '',
  'E0eWHYcK6B571',
  'E0eWHYcK6B571AA',
  'E0eWHYcK6B571A==',
 ]){
  assert.equal(B.decodeMeterIdAdv(bad),null,`must reject ${JSON.stringify(bad)}`)
  assert.equal(B.parseManufacturerMeter({companyId:0x4b53,data:[...Buffer.from(bad,'latin1')]}),null)
 }
 // Non-BCD nibbles (0xA..0xF) in decoded 10-byte meterId must be rejected as dirty data
 const nonBcdEncoded=B.encodeMeterIdAdv([0xab,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00])
 assert.equal(nonBcdEncoded.length,14)
 assert.equal(B.decodeMeterIdAdv(nonBcdEncoded),null)
 // Unrelated companyId without SK prefix must be ignored
 assert.equal(B.parseManufacturerMeter({companyId:0x004c,data:[...Buffer.from('E0eWHYcK6B571A','ascii')]}),null)
 assert.equal(B.parseManufacturerMeter(Uint8Array.from([0x52,0x53,...Buffer.from('E0eWHYcK6B571A','ascii')])),null)
})

test('M95 UID advertisement + 0xFF scan response coexists with legacy SKxxxxx devices and persists meterNo',async()=>{
 const store=new Map()
 const storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}
 const ffe0='0000ffe0-0000-1000-8000-00805f9b34fb'
 const ffe1='0000ffe1-0000-1000-8000-00805f9b34fb'
 const ffe2='0000ffe2-0000-1000-8000-00805f9b34fb'
 const m95Chars=[{id:0,service:ffe0,characteristic:ffe1,props:16},{id:1,service:ffe0,characteristic:ffe2,props:8|4}]
 let scanCh,scanDone
 const svc=B.create({
  createStreamPort:A.createStreamPort,Channel:class{},toBytes:b=>Uint8Array.from(b),blocked:()=>false,storage,
  invoke:async(cmd,p)=>{
   if(cmd==='ble_release_owned')return 1
   if(cmd==='ble_scan'){scanCh=p.onDevice;scanCh.onmessage({type:'started'});await new Promise(r=>{scanDone=r})}
   if(cmd==='ble_scan_stop'){if(scanDone)scanDone()}
   if(cmd==='ble_open')return{handle:12,characteristics:m95Chars}
   if(cmd==='ble_start'||cmd==='ble_close')return
  },
 })
 const job=svc.scan();await flush()
 // 1. M95 primary ADV_IND arrives first (UID hash name, no 0xFF yet), followed by SCAN_RSP with 0xFF, then another ADV_IND without 0xFF
 const pidM95='"uuid-m95-1"'
 scanCh.onmessage({type:'device',device:{deviceId:'ble-m95',persistentId:pidM95,name:'4CE331A5',services:[ffe0],rssi:-52}})
 scanCh.onmessage({type:'device',device:{deviceId:'ble-m95',persistentId:pidM95,name:'4CE331A5',services:[ffe0],rssi:-51,manufacturerData:{companyId:0x4b53,data:[...Buffer.from('E0eWHYcK6B571A','ascii')]}}})
 scanCh.onmessage({type:'device',device:{deviceId:'ble-m95',persistentId:pidM95,name:'4CE331A5',services:[ffe0],rssi:-50}})
 // 2. Legacy SK08449 device (no 0xFF manufacturerData)
 scanCh.onmessage({type:'device',device:{deviceId:'ble-legacy',persistentId:'"uuid-legacy-1"',name:'SK08449',services:[ffe0],rssi:-60}})

 const all=svc.devices()
 assert.equal(all.length,2)
 const m95=all.find(d=>d.deviceId==='ble-m95')
 assert.equal(m95.name,'4CE331A5')
 assert.equal(m95.meterNo,'09632221008449')
 assert.equal(m95.meterIdBcd,'00000009632221008449')
 // Search matches 14-digit meterNo, 20-digit BCD, tail digits, UID Local Name, and legacy SK08449
 assert.deepEqual(B.visibleDevices(all,'09632221008449').map(d=>d.deviceId),['ble-m95'])
 assert.deepEqual(B.visibleDevices(all,'00000009632221008449').map(d=>d.deviceId),['ble-m95'])
 assert.deepEqual(B.visibleDevices(all,'4ce331a5').map(d=>d.deviceId),['ble-m95'])
 assert.deepEqual(B.visibleDevices(all,'SK08449').map(d=>d.deviceId),['ble-legacy'])
 assert.deepEqual(B.visibleDevices(all,'08449').map(d=>d.deviceId),['ble-m95','ble-legacy'])
 // Devices with decoded 0xFF meter numbers always rank ahead of stronger/newer generic BLE devices
 const rankedList=[
  {deviceId:'generic-strong',name:'AirPods',services:[],rssi:-30,seen:9999},
  {deviceId:'sk-zero',name:'E23C62B5',meterNo:'00000000000000000000',meterIdBcd:'00000000000000000000',meterZero:true,services:[ffe0],rssi:-40,seen:500},
  {deviceId:'m95-weak',name:'4CE331A5',meterNo:'09632221008449',meterIdBcd:'00000009632221008449',meterZero:false,services:[ffe0],rssi:-85,seen:100},
  {deviceId:'m95-mid',name:'9E13621B',meterNo:'830202264601',meterIdBcd:'00000000830202264601',meterZero:false,services:[ffe0],rssi:-70,seen:200},
 ]
 assert.deepEqual(B.visibleDevices(rankedList,'','','signal').map(d=>d.deviceId),['m95-mid','m95-weak','sk-zero','generic-strong'])
 assert.deepEqual(B.visibleDevices(rankedList,'','','recent').map(d=>d.deviceId),['m95-mid','m95-weak','sk-zero','generic-strong'])
 assert.deepEqual(B.visibleDevices(rankedList,'','','name').map(d=>d.deviceId),['m95-weak','m95-mid','sk-zero','generic-strong'])

 // Updating meter ID via SEK/CJ188 refreshes 0xFF ADD without changing MCU UID broadcastName
 const defMap=B.defaultMapping(m95Chars)
 const profile=B.mapping(m95Chars,defMap.txId,defMap.rxId,defMap.response)
 svc.saveDevice(m95,{profile})
 assert.equal(svc.savedDevice(pidM95).meterNo,'09632221008449')
 assert.equal(svc.savedDevice(pidM95).broadcastName,'4CE331A5')
 scanCh.onmessage({type:'device',device:{deviceId:'ble-m95',persistentId:pidM95,name:'4CE331A5',services:[ffe0],rssi:-49,manufacturerData:{companyId:0x4b53,data:[...Buffer.from('W4WwPqfq4R571A','ascii')]}}})
 const refreshed=svc.devices().find(d=>d.deviceId==='ble-m95')
 assert.equal(refreshed.meterNo,'830202264601')
 assert.equal(refreshed.nameChanged,false)

 await svc.stopScan();await job
 // Port metadata surfaces both meter number and Bluetooth UID name; legacy device keeps original label
 const m95Port=svc.ports().find(p=>p.getInfo().blePersistentId===pidM95)
 assert.equal(m95Port.getInfo().productName,'830202264601 (4CE331A5) · BLE')
 assert.equal(m95Port.getInfo().bleMeterNo,'830202264601')
 // Reconnect updates persisted meterNo to 830202264601; then resetting meter to all-zero clears stale saved meterNo
 await m95Port.open({});await m95Port.close()
 assert.equal(svc.savedDevice(pidM95).meterNo,'830202264601')
 const job2=svc.scan();await flush()
 scanCh.onmessage({type:'device',device:{deviceId:'ble-m95',persistentId:pidM95,name:'4CE331A5',services:[ffe0],rssi:-48,manufacturerData:{companyId:0x4b53,data:[...Buffer.from('WsOWPKVp4R571A','ascii')]}}})
 await svc.stopScan();await job2
 assert.equal(B.visibleDevices(svc.devices(),'830202264601').length,0,'resetting meter to all-zero must not match stale savedMeterNo')
 assert.equal(m95Port.getInfo().productName,'4CE331A5 · BLE')
 assert.equal(m95Port.getInfo().bleMeterNo,'')
 await m95Port.open({});await m95Port.close()
 assert.equal(svc.savedDevice(pidM95).meterNo,'')

 const legRec=await svc.inspect(all.find(d=>d.deviceId==='ble-legacy'))
 const legChoice=svc.createPort(legRec,profile,defMap.txId,defMap.rxId)
 assert.equal(legChoice.port.getInfo().productName,'SK08449 · BLE')
 await legChoice.discard()
 await svc.release()
})
