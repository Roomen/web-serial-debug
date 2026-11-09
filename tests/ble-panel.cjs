// Run the actual panel and inline navigation scripts against a small interactive DOM.
// This is a DOM/service integration test, not native WebView or visual verification.
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm')
const html = fs.readFileSync('index.html','utf8'), panel = fs.readFileSync('js/ble-panel.js','utf8')
class Element {
 constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.attributes={}; this.listeners={}; this._value=undefined; this._text=''; this.classes=new Set(); this.classList={toggle:(k,on)=>on?this.classes.add(k):this.classes.delete(k),contains:k=>this.classes.has(k)} }
 appendChild(e) { this.children.push(e);e.parentNode=this;return e }
 replaceChildren() { this.children=[];this._value=undefined }
 setAttribute(k,v) { this.attributes[k]=v }
 addEventListener(k,f) { (this.listeners[k] ||= []).push(f) }
 click() { for(const f of this.listeners.click||[]) f(); if(this.onclick) this.onclick() }
 set textContent(v) { this._text=String(v) }
 get textContent() { return this._text+this.children.map(e=>e.textContent).join('') }
 set value(v) { this._value=String(v) }
 get value() { return this._value===undefined?(this.tagName==='select'&&this.children[0]?this.children[0].value:''):this._value }
 querySelectorAll(sel) { return this.children.filter(e=>sel==='.rail-item[data-view]'&&e.dataset.view) }
 querySelector(sel) { const m=sel.match(/data-view="([^"]+)"/); return m?this.children.find(e=>e.dataset.view===m[1])||null:null }
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))}
function setup(allowed=true,savedView=null) {
 const els={},rail=new Element('nav'),views=[],store=new Map(),calls=[]
 if(savedView!==null)store.set('serial-debug-active-view',savedView)
 els['activity-rail']=rail
 for(const m of html.matchAll(/<button class="rail-item[^"]*" data-view="([^"]+)"([^>]*)>/g)) {
  const e=new Element('button'); e.dataset.view=m[1]; const f=m[2].match(/data-feature="([^"]+)"/); if(f)e.dataset.feature=f[1]; rail.appendChild(e)
 }
 for(const m of html.matchAll(/<div id="(view-[^"]+)" class="app-view[^"]*"/g)) {const e=new Element('div');e.id=m[1];els[e.id]=e;views.push(e)}
 els['ble-workbench']=new Element('div')
 const document={querySelector:sel=>rail.querySelector(sel),getElementById:id=>els[id],createElement:tag=>new Element(tag),querySelectorAll:sel=>sel==='.app-view'?views:[]}
 let change
 const ble={
  state:()=>({phase:'idle',scanning:false,synchronized:true,generation:7,discovery:true}),
  ports:async()=>[{deviceId:'bridge-1',name:'Synthetic bridge',portName:'test'}],
  devices:()=>[{deviceId:'dev-1',name:'<script>synthetic</script>',rssi:-40,connectable:true}],
  gatt:()=>({characteristics:[{characteristicId:'char-1',uuid:'abcd',service:'1234',props:62}]}),
  logs:()=>({events:[],dropped:0}),subscribe:fn=>{change=fn;return()=>{}},
  run:async(action,p)=>{calls.push({action,p});return{}},release:async()=>{calls.push({action:'release'})},
  profile:(...args)=>{calls.push({action:'profile',args});return{version:1,response:true,chunkSize:20}},
  resolveProfile:()=>({tx:'char-1',rx:'char-1',generation:7}),
 }
 const localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)}
 const sources={bridgePort:()=>ble.createProfilePort()}; const window={SerialHub:{activeSendPhys:()=> 'A'},serialLanes:{selectPort:async(sid,port,opts)=>{calls.push({action:'selectPort',sid,port,opts});return true}},AppPlatform:{has:id=>id!=='view.ble'||allowed,service:name=>allowed?(name==='connection-source'?sources:ble):null}}
 const ctx={window,document,localStorage,setTimeout:fn=>{fn();return 1},console}
 vm.createContext(ctx)
 const script=html.slice(html.indexOf('// 最左侧导航栏：切换工具视图'),html.indexOf('</script>',html.indexOf('// 最左侧导航栏：切换工具视图')))
 vm.runInContext(script,ctx); vm.runInContext(panel,ctx)
 const all=()=>{const out=[];function walk(e){out.push(e);e.children.forEach(walk)}walk(els['ble-workbench']);return out}
 const click=async title=>{const b=all().find(e=>e.tagName==='button'&&e.textContent===title);assert.ok(b,title);b.click();await flush()}
 return {els,rail,views,store,calls,all,click,change:()=>change&&change(),ble}
}
test('actual modern navigation selects BLE view; mounted buttons invoke service with selected opaque ids',async()=>{
 const h=setup();await flush()
 const nav=h.rail.children.find(e=>e.dataset.view==='view-ble');assert.ok(nav);nav.click()
 assert.equal(h.els['view-ble'].classList.contains('active'),true)
 assert.equal(h.store.get('serial-debug-active-view'),'view-ble')
 assert.ok(h.views.filter(v=>v.id!=='view-ble').every(v=>!v.classList.contains('active')))
 await h.click('打开桥口');assert.equal(h.calls.at(-1).action,'open');assert.equal(h.calls.at(-1).p.deviceId,'bridge-1')
 for(const [label,action] of [['扫描','scan_start'],['停止扫描','scan_stop'],['连接选中设备','connect'],['断开外设','disconnect'],['读取','read'],['订阅 RX','subscribe'],['配对','pair']]) {await h.click(label);assert.equal(h.calls.at(-1).action,action)}
 assert.equal(h.calls.find(c=>c.action==='connect').p.deviceId,'dev-1')
 assert.equal(h.calls.find(c=>c.action==='read').p.generation,7)
 const input=h.all().find(e=>e.attributes['aria-label']==='写入 HEX');input.value='01 02'
 await h.click('写入（有响应）');assert.equal(h.calls.at(-1).p.hex,'01 02');assert.equal(h.calls.at(-1).p.response,true)
 await h.click('保存 Profile');assert.ok(h.store.has('bleBridgeProfile'))
 await h.click('关闭桥口');assert.equal(h.calls.at(-1).action,'close')
 // Device name remains a text node, not HTML markup.
 assert.ok(h.all().find(e=>e.tagName==='option'&&e.textContent.includes('<script>synthetic</script>')))
})
test('web/mobile gate mounts no BLE controls and navigation falls back to serial',async()=>{
 const h=setup(false);await flush();assert.equal(h.els['ble-workbench'].children.length,0)
 h.rail.children.find(e=>e.dataset.view==='view-ble').click()
 assert.equal(h.els['view-ble'].classList.contains('active'),false)
 assert.equal(h.els['view-serial'].classList.contains('active'),true);assert.equal(h.calls.length,0)
})
test('saved removed or invalid views fall back and persist serial; valid views and old alias still restore',()=>{
 for(const saved of ['view-classic','view-missing','view-ble"]']){
  const h=setup(true,saved)
  assert.equal(h.store.get('serial-debug-active-view'),'view-serial')
  assert.equal(h.els['view-serial'].classList.contains('active'),true)
 }
 for(const [saved,expected,allowed] of [['view-ble','view-ble',true],['view-emk','view-blu',true],['view-ble','view-serial',false]]){
  const h=setup(allowed,saved)
  assert.equal(h.store.get('serial-debug-active-view'),expected)
  assert.equal(h.els[expected].classList.contains('active'),true)
 }
})
test('service errors surface in panel and pairing challenge buttons route generation',async()=>{
 const h=setup();await flush()
 h.ble.run=async()=>{throw Error('synthetic failure')};await h.click('扫描')
 assert.ok(h.all().some(e=>e.attributes.role==='status'&&e.textContent==='synthetic failure'))
 h.ble.state=()=>({phase:'connected',generation:9,challenge:{action:'confirm',value:123456}})
 h.ble.run=async(action,p)=>{h.calls.push({action,p})};h.change()
 await h.click('提交输入 / 确认一致');assert.equal(h.calls.at(-1).action,'passkey');assert.equal(h.calls.at(-1).p.passkey,1);assert.equal(h.calls.at(-1).p.generation,9)
})

test('Profile UI hands its port to the actual communication lane without opening a second reader',async()=>{
 const h=setup(),port={synthetic:true};h.ble.createProfilePort=()=>port
 await flush();await h.click('接入通信调试主发路')
 const call=h.calls.find(c=>c.action==='selectPort');assert.ok(call);assert.equal(call.sid,'A');assert.equal(call.port,port);assert.equal(call.opts.open,true)
 assert.equal(h.els['view-serial'].classList.contains('active'),true)
 assert.equal(h.all().some(e=>e.textContent==='按 Profile 发送 HEX'),false)
})
test('filter buttons use real controller, show UUID, reject invalid and refresh incremental advertisements',async()=>{
 const B=require('../js/ble-bridge.js');let feed
 const c=B.create({ports:async()=>[],open:async(id,f)=>{feed=f;return{write:async bytes=>{const m=JSON.parse(new TextDecoder().decode(bytes));feed(new TextEncoder().encode(JSON.stringify({t:'rsp',id:m.id,ok:true})+'\n'))},close:async()=>{}}}})
 await c.run('open',{});await c.run('scan_start')
 const emit=items=>feed(new TextEncoder().encode(JSON.stringify({t:'evt',e:'dev',items})+'\n'))
 const u='12345678-1234-5678-9abc-123456789abc';emit([{addr:'test-a',name:'Alpha',uuids:[u]},{addr:'test-b',name:'Beta',uuids:[u]}])
 const h=setup();h.ble.devices=p=>c.devices(p);h.change()
 const field=label=>h.all().find(e=>e.attributes['aria-label']===label),list=field('扫描设备')
 field('广播名筛选').value='ALP';field('广播服务 UUID 筛选').value=u.replaceAll('-','').toUpperCase();await h.click('应用筛选')
 assert.equal(list.children.length,1);assert.ok(list.children[0].textContent.includes(u))
 emit([{addr:'test-a',rssi:-60}]);h.change();assert.equal(list.children.length,1)
 field('广播服务 UUID 筛选').value='invalid';await h.click('应用筛选');assert.equal(list.children.length,0);assert.ok(h.all().find(e=>e.attributes.role==='status').textContent.includes('128-bit'))
 await h.click('清除筛选');assert.equal(list.children.length,2);await c.release()
})
