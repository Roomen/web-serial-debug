// Execute the real selection UI, native BLE service and stream adapter together.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const B=require('../js/native-ble.js'),A=require('../js/serial-adapter.js')
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r))}
class E {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this._text='';this._value=undefined;this.classList={add(){}}}
 appendChild(e){e.parent=this;this.children.push(e);return e} insertBefore(e,at){if(e.parent)e.parent.children=e.parent.children.filter(x=>x!==e);e.parent=this;const i=this.children.indexOf(at);this.children.splice(i<0?this.children.length:i,0,e);return e} remove(){if(this.parent)this.parent.children=this.parent.children.filter(e=>e!==this)} replaceChildren(){this.children=[];this._value=undefined}
 setAttribute(k,v){this.attributes[k]=v}set textContent(v){this._text=String(v)}get textContent(){return this._text+this.children.map(c=>c.textContent).join('')}
 set value(v){this._value=String(v)}get value(){return this._value===undefined?(this.tagName==='select'&&this.children[0]?this.children[0].value:''):this._value}
 get selectedOptions(){return this.children.filter(c=>c.value===this.value)}
}
const u1='00000001-0000-0000-0000-000000000001',u2='00000002-0000-0000-0000-000000000002'
const chars=[{id:0,service:u1,characteristic:u2,props:8},{id:1,service:u2,characteristic:u1,props:16}]
function setup(options={}) {
 const calls=[],map=new Map(),store=new Map();let host,close,data,events,gen=0,scanDone,scanChannel
 const ble=B.create({createStreamPort:A.createStreamPort,toBytes:b=>Uint8Array.from(b),Channel:class{},blocked:()=>false,invoke:async(command,p)=>{
  calls.push({command,p});if(command==='ble_release_owned'){if(scanDone)scanDone();return ++gen}
  if(command==='ble_scan'){
   scanChannel=p.onDevice;scanChannel.onmessage({type:'started'})
   for(const device of [{deviceId:'fixture',name:'<Fixture>',services:[u1],rssi:-44},{deviceId:'other',name:'Other',services:[u2]}])scanChannel.onmessage({type:'device',device})
   await new Promise(r=>{scanDone=r})
  }
  if(command==='ble_scan_stop'){if(options.stop)await options.stop();if(scanDone)scanDone()}

  if(command==='ble_open'){if(options.open)await options.open();data=p.onData;events=p.onEvent;return{handle:1,characteristics:options.chars||chars}}
 }})
 map.set('computer-ble',ble)
 if(options.classic)map.set('classic',options.classic)
 if(options.bridge)map.set('ble',options.bridge)
 const usb={usb:true};let provider
 const window={AppPlatform:{service:n=>map.get(n),provide:(n,s)=>map.set(n,s)},SerialAdapter:{requestPort:async()=>usb,addPortProvider:fn=>{provider=fn}},NativeBle:B,AppDialog:{panel:opts=>new Promise(r=>{host=new E('div');close=()=>r();opts.build(host,{close})})}}
 const ctx={window,document:{createElement:t=>new E(t),querySelector:()=>null},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},console}
 if(options.hub)window.SerialHub=options.hub
 vm.runInNewContext(fs.readFileSync('js/connection-source.js','utf8'),ctx)
 const all=()=>{const out=[];const walk=e=>{out.push(e);e.children.forEach(walk)};walk(host);return out}
 const click=async text=>{const b=all().find(e=>e.tagName==='button'&&e.textContent===text);assert.ok(b,text);await b.onclick();await flush()}
 const field=label=>{const l=all().find(e=>e.tagName==='label'&&e._text===label);assert.ok(l,label);return l.children[0]}
 return{source:map.get('connection-source'),ble,all,click,field,close:()=>close(),calls,store,advertise:d=>scanChannel.onmessage({type:'device',device:d}),data:b=>data.onmessage(b),ports:()=>provider(),usb}
}
async function discover(h){await flush();const row=h.all().find(e=>e.className==='connection-device'&&e.textContent.includes('<Fixture>'));assert.ok(row);row.onclick();await h.click('连接并发现 TX/RX')}
test('serial requests bypass source screen; available services expose direct picker entries',async()=>{
 const h=setup(),selected=await h.source.requestPort();assert.equal(selected.port,h.usb);assert.equal(h.calls.filter(c=>c.command==='ble_scan').length,0)
 assert.deepEqual(JSON.parse(JSON.stringify(h.source.availableSources())),[{id:'computer-ble',label:'电脑 BLE'}])
})
test('auto streaming scan, quick filters, cross-service mapping and session alias through unified stream',async()=>{
 const h=setup(),pending=h.source.requestPort('computer-ble');await flush()
 assert.equal(h.calls.filter(c=>c.command==='ble_scan').length,1)
 const query=h.field('名称 / 广播 UUID / 别名包含');query.value='fixture';query.oninput()
 let rows=h.all().filter(e=>e.className==='connection-device');assert.equal(rows.length,1);assert.ok(rows[0].textContent.includes('<Fixture>'))
 rows[0].onclick();const selectedRow=rows[0];h.advertise({deviceId:'fixture',name:'<Fixture>',services:[u1],rssi:-30})
 assert.equal(h.all().find(e=>e.className==='connection-device'),selectedRow);assert.equal(selectedRow.attributes['aria-pressed'],'true')
 await h.click('连接并发现 TX/RX')
 assert.ok(h.calls.findIndex(c=>c.command==='ble_scan_stop')<h.calls.findIndex(c=>c.command==='ble_open'))
 const summary=h.all().find(e=>e.tagName==='pre');assert.ok(summary.textContent.includes(u1));assert.ok(summary.textContent.includes(u2))
 const alias=h.field('设备别名（仅本页面当前 BLE 会话）');alias.value='Desk fixture';alias.oninput()
 assert.equal(h.calls.some(c=>c.command==='ble_start'),false)
 await h.click('确认映射并开始透传');const chosen=await pending;assert.equal(h.source.isBusyForUpdate(),false)
 const saved=h.ble.preference('fixture').profile;assert.equal(saved.tx.service,u1);assert.equal(saved.rx.service,u2);assert.equal('id' in saved.tx,false)
 assert.equal(h.store.has('computerBleProfile'),false);assert.equal(chosen.port.getDisplayAlias(),'Desk fixture')
 chosen.port.setDisplayAlias('Renamed');assert.equal(h.ble.devices().find(d=>d.deviceId==='fixture').alias,'Renamed')
 await chosen.port.open({});assert.ok(h.calls.some(c=>c.command==='ble_start'))
 const r=chosen.port.readable.getReader();h.data([7,8]);assert.deepEqual([...((await r.read()).value)],[7,8]);await r.cancel();r.releaseLock();await chosen.port.close();assert.ok(h.ports().includes(chosen.port));await h.ble.release()
})
test('ambiguous TX is never auto-selected; mode validates properties; cancel after discovery releases native connection',async()=>{
 const h=setup({chars:[...chars,{...chars[0],id:2}]}),pending=h.source.requestPort('computer-ble');await discover(h)
 assert.equal(h.field('TX · 电脑 → 设备').value,'');await h.click('确认映射并开始透传');assert.ok(h.all().find(e=>e.attributes.role==='status').textContent.includes('请选择'))
 h.close();assert.equal(await pending,null);assert.ok(h.calls.some(c=>c.command==='ble_close'));assert.equal(h.ble.isBusyForUpdate(),false)
})
test('discard releases discovered connection when lane refuses selection',async()=>{
 const h=setup(),pending=h.source.requestPort('computer-ble');await discover(h);await h.click('确认映射并开始透传');const selected=await pending
 await selected.discard();assert.equal(h.calls.at(-1).command,'ble_close');assert.equal(h.ble.canSelect(),true);await h.ble.release()
})

test('SPP source uses system-selected device id, not arbitrary enumeration order',async()=>{
 let selected;const port={spp:true},classic={ports:()=>[],createPort:id=>{selected=id;return port},run:async()=>({selectedDeviceId:'chosen',devices:[{deviceId:'chosen',paired:true},{deviceId:'other',paired:true}]})}
 const h=setup({classic}),pending=h.source.requestPort('classic');await flush();await h.click('选择已配对设备…')
 assert.equal((await pending).port,port);assert.equal(selected,'chosen')
})

test('bridge selection reuses port after binding refusal and bounds stale mapping enumeration',async()=>{
 let generation=1,created=0,invalid=false,bound=null,closed=0
 const bridge={state:()=>({generation}),resolveProfile:p=>{if(invalid)throw Error('ambiguous mapping');return{generation,tx:p.tx,rx:p.rx}},createProfilePort:()=>({number:++created,close:()=>{closed++}})}
 const h=setup({bridge,hub:{getPort:sid=>sid==='S'?bound:null}})
 const save=(overrides={})=>h.store.set('bleBridgeProfile',JSON.stringify({version:1,tx:'tx',rx:'rx',response:true,chunkSize:20,...overrides}))
 save()
 const first=h.source.bridgePort();bound=first
 // Source modal and bridge panel call the same factory; refusal leaves no new object to leak.
 for(let i=0;i<3;i++){
  const pending=h.source.requestPort('bridge');await flush();await h.click('使用已连接桥的映射')
  assert.equal((await pending).port,first)
 }
 assert.equal(created,1);assert.deepEqual([...h.ports()],[first])
 // Resolved identities, not serialized property order, define an equivalent mapping.
 h.store.set('bleBridgeProfile',JSON.stringify({chunkSize:20,response:true,rx:'rx',tx:'tx',version:1}))
 assert.equal(h.source.bridgePort(),first)
 invalid=true;assert.throws(()=>h.source.bridgePort(),/ambiguous/);invalid=false
 save({response:false});const changed=h.source.bridgePort();assert.notEqual(changed,first)
 assert.deepEqual([...h.ports()],[first,changed]) // current lane retained while a replacement is only selected
 bound=null;assert.deepEqual([...h.ports()],[changed])
 for(let chunkSize=21;chunkSize<45;chunkSize++){save({chunkSize});h.source.bridgePort();assert.equal(h.ports().length,1)}
 const old=h.ports()[0];bound=old;generation++
 assert.equal(h.ports().length,0);const fresh=h.source.bridgePort();assert.notEqual(fresh,old)
 assert.deepEqual([...h.ports()],[fresh]);assert.equal(closed,0) // enumeration pruning never closes lane resources
})

test('cancel ongoing scan drains without inspecting or closing another lane',async()=>{
 const h=setup(),pending=h.source.requestPort('computer-ble');await flush();h.close();assert.equal(await pending,null)
 assert.ok(h.calls.some(c=>c.command==='ble_scan_stop'));assert.equal(h.calls.some(c=>c.command==='ble_open'||c.command==='ble_close'),false)
 assert.equal(h.source.isBusyForUpdate(),false);assert.equal(h.ble.isBusyForUpdate(),false)
})
test('pause/resume retains selection and alias; hidden selection cannot be connected',async()=>{
 const h=setup(),pending=h.source.requestPort('computer-ble');await flush()
 const row=h.all().find(e=>e.className==='connection-device');row.onclick();await h.click('暂停扫描')
 h.ble.remember('fixture',{alias:'Alias'});await h.click('继续扫描');await flush()
 assert.equal(h.all().find(e=>e.className==='connection-device'&&e.textContent.includes('Alias')).attributes['aria-pressed'],'true')
 const min=h.field('最低 RSSI（输入正数，如 70 表示 ≥ -70 dBm；可选）')
 assert.equal(min.min,'1');assert.equal(min.max,'127')
 min.value='40';min.oninput();assert.equal(h.all().filter(e=>e.className==='connection-device').length,0)
 min.value='70';min.oninput();assert.equal(h.all().filter(e=>e.className==='connection-device').length,1)
 assert.equal(h.all().find(e=>e.tagName==='button'&&e.textContent==='连接并发现 TX/RX').disabled,false)
 min.value='';min.oninput();assert.equal(h.all().filter(e=>e.className==='connection-device').length,2)
 const q=h.field('名称 / 广播 UUID / 别名包含');q.value='no match';q.oninput()
 assert.equal(h.all().find(e=>e.tagName==='button'&&e.textContent==='连接并发现 TX/RX').disabled,true)
 q.value='alias';q.oninput();assert.equal(h.all().filter(e=>e.className==='connection-device').length,1)
 for(const value of ['-70','200']){
  min.value=value;min.oninput()
  assert.equal(h.all().find(e=>e.tagName==='button'&&e.textContent==='连接并发现 TX/RX').disabled,true)
  assert.ok(h.all().some(e=>e.attributes.role==='status'&&e.textContent.includes('1 到 127 的正数')))
 }
 h.close();await pending
})
test('cancel in-flight inspection invalidates then drains late handle without publishing selection',async()=>{
 let resume;const gate=new Promise(r=>{resume=r}),h=setup({open:()=>gate}),pending=h.source.requestPort('computer-ble');await flush()
 h.all().find(e=>e.className==='connection-device').onclick()
 const clicking=h.click('连接并发现 TX/RX');await flush();h.close();await flush()
 assert.ok(h.calls.filter(c=>c.command==='ble_release_owned').length>=2)
 resume();await clicking;assert.equal(await pending,null);assert.ok(h.calls.some(c=>c.command==='ble_close'));assert.equal(h.ble.isBusyForUpdate(),false)
})
test('old global mapping is never applied to a new device; picker has no standalone release action',async()=>{
 const h=setup();h.store.set('computerBleProfile',JSON.stringify({tx:chars[0],rx:chars[1],response:false}))
 const pending=h.source.requestPort('computer-ble');await discover(h)
 assert.equal(h.field('TX 写入模式').value,'true')
 assert.equal(h.all().some(e=>e.tagName==='button'&&e.textContent==='重试释放电脑 BLE'),false)
 h.close();await pending
})

test('unfinished scan cleanup recovery explains retry instead of disconnecting a nonexistent lane',async()=>{
 let fail=true;const h=setup({stop:()=>{if(fail)throw Error('scan still draining')}})
 const first=h.source.requestPort('computer-ble');await flush();await h.click('暂停扫描')
 assert.equal(h.ble.canRetryRelease(),true);assert.equal(h.ble.isBusyForUpdate(),true)
 fail=false;h.close();await first
 const pending=h.source.requestPort('computer-ble');await flush()
 const status=h.all().find(e=>e.attributes.role==='status').textContent
 assert.ok(status.includes('清理尚未完成'));assert.ok(!status.includes('本路「断开」'))
 const retry=h.all().find(e=>e.tagName==='button'&&e.textContent==='重试释放未完成的选择');assert.equal(retry.hidden,false)
 await retry.onclick();await flush();assert.equal(h.ble.canRetryRelease(),false)
 assert.equal(h.calls.some(c=>c.command==='ble_close'),false)
 h.close();await pending
})
