// Execute the real selection UI, native BLE service and stream adapter together.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const B=require('../js/native-ble.js'),A=require('../js/serial-adapter.js')
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r))}
class E {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this._text='';this._value=undefined;this.classList={add(){}}}
 appendChild(e){this.children.push(e);return e} replaceChildren(){this.children=[];this._value=undefined}
 setAttribute(k,v){this.attributes[k]=v}set textContent(v){this._text=String(v)}get textContent(){return this._text+this.children.map(c=>c.textContent).join('')}
 set value(v){this._value=String(v)}get value(){return this._value===undefined?(this.tagName==='select'&&this.children[0]?this.children[0].value:''):this._value}
 get selectedOptions(){return this.children.filter(c=>c.value===this.value)}
}
const u1='00000001-0000-0000-0000-000000000001',u2='00000002-0000-0000-0000-000000000002'
const chars=[{id:0,service:u1,characteristic:u2,props:8},{id:1,service:u2,characteristic:u1,props:16}]
function setup(options={}) {
 const calls=[],map=new Map(),store=new Map();let host,close,data,events,gen=0
 const ble=B.create({createStreamPort:A.createStreamPort,toBytes:b=>Uint8Array.from(b),Channel:class{},blocked:()=>false,invoke:async(command,p)=>{
  calls.push({command,p});if(command==='ble_release_owned')return ++gen
  if(command==='ble_scan')return [{deviceId:'fixture',name:'<Fixture>',services:[u1],rssi:-44},{deviceId:'other',name:'Other',services:[u2]}]
  if(command==='ble_open'){data=p.onData;events=p.onEvent;return{handle:1,characteristics:options.chars||chars}}
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
 return{source:map.get('connection-source'),ble,all,click,field,close:()=>close(),calls,store,data:b=>data.onmessage(b),ports:()=>provider(),usb}
}
async function discover(h){await h.click('电脑 BLE');await h.click('扫描 5 秒');h.field('扫描设备').value='fixture';await h.click('连接并发现 TX/RX')}
test('actual selector keeps USB path and exposes additional ports without switching backend',async()=>{
 const h=setup(),pending=h.source.requestPort();await h.click('普通串口');assert.equal((await pending).port,h.usb);assert.equal(h.calls.filter(c=>c.command==='ble_scan').length,0)
})
test('name/UUID AND filter, cross-service mapping preview, persisted selectors and RX through unified stream',async()=>{
 const h=setup(),pending=h.source.requestPort();await h.click('电脑 BLE');await h.click('扫描 5 秒')
 h.field('广播名包含（主要查找方式）').value='fixture';h.field('广播服务 UUID（可选，完整 128-bit）').value=u1;await h.click('应用筛选')
 assert.equal(h.field('扫描设备').children.length,2);assert.ok(h.field('扫描设备').children[1].textContent.includes('<Fixture>'))
 h.field('扫描设备').value='fixture';await h.click('连接并发现 TX/RX')
 const summary=h.all().find(e=>e.tagName==='pre');assert.ok(summary.textContent.includes(u1));assert.ok(summary.textContent.includes(u2))
 assert.equal(h.calls.some(c=>c.command==='ble_start'),false)
 await h.click('确认映射并开始透传');const chosen=await pending;assert.equal(h.source.isBusyForUpdate(),false)
 const saved=JSON.parse(h.store.get('computerBleProfile'));assert.equal(saved.tx.service,u1);assert.equal(saved.rx.service,u2);assert.equal('id' in saved.tx,false)
 await chosen.port.open({});assert.ok(h.calls.some(c=>c.command==='ble_start'))
 const r=chosen.port.readable.getReader();h.data([7,8]);assert.deepEqual([...((await r.read()).value)],[7,8]);await r.cancel();r.releaseLock();await chosen.port.close();assert.ok(h.ports().includes(chosen.port));await h.ble.release()
})
test('ambiguous TX is never auto-selected; mode validates properties; cancel after discovery releases native connection',async()=>{
 const h=setup({chars:[...chars,{...chars[0],id:2}]}),pending=h.source.requestPort();await discover(h)
 assert.equal(h.field('TX · 电脑 → 设备').value,'');await h.click('确认映射并开始透传');assert.ok(h.all().find(e=>e.attributes.role==='status').textContent.includes('请选择'))
 h.close();assert.equal(await pending,null);assert.ok(h.calls.filter(c=>c.command==='ble_release_owned').length>=2);assert.equal(h.ble.isBusyForUpdate(),false)
})
test('discard releases discovered connection when lane refuses selection',async()=>{
 const h=setup(),pending=h.source.requestPort();await discover(h);await h.click('确认映射并开始透传');const selected=await pending
 await selected.discard();assert.equal(h.calls.at(-1).command,'ble_close');assert.equal(h.ble.canSelect(),true);await h.ble.release()
})

test('SPP source uses system-selected device id, not arbitrary enumeration order',async()=>{
 let selected;const port={spp:true},classic={ports:()=>[],createPort:id=>{selected=id;return port},run:async()=>({selectedDeviceId:'chosen',devices:[{deviceId:'chosen',paired:true},{deviceId:'other',paired:true}]})}
 const h=setup({classic}),pending=h.source.requestPort();await h.click('经典蓝牙 SPP');await h.click('选择已配对设备…')
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
  const pending=h.source.requestPort();await h.click('外置 USB BLE 桥');await h.click('使用已连接桥的映射')
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
