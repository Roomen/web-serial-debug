# Repository Guidelines

## 项目结构

静态 Web Serial 串口调试工具，无构建系统、无需安装依赖。入口 `index.html` 负责页面结构，并通过 CDN 加载 Bootstrap、Bootstrap Icons、xterm.js、JSZip。主要业务逻辑在 `js/common.js`（串口开关、快捷发送、日志展示、协议注册表等）；协议解析、固件升级/打包、BLU 功耗分析各自拆在 `js/` 下的独立文件里，按 `index.html` 末尾的 `<script>` 顺序加载。样式集中在 `css/style.css`，图片放在 `imgs/`。日志格式「解析」（`logType` 带 `parse`，可与 HEX/TEXT 同行显示或单独显示）由协议的 `logView(r)` 返回视图模型（不识别的帧返回 null，多帧返回数组），`js/parse-view.js` 的 `ParseView.render` 统一转义并渲染成行内 `.pv` 块，没有 `logView` 的协议退回 `formatFrame` 的老样式，底部「协议解析」面板仍用 `formatFrame`；模型里的文本一律由渲染器转义，只有 `section.html` 原样插入，只能放协议自己拼且已转义的片段。不要再加独立的实时解析开关，也不要在日志里另插解析块；`renderLogBody` 里 HEX/TEXT 并排只认 `parseLogType(t)` 拆出的 hex 与 text 同时存在，不要对 `logType` 做 `includes('&')`，因为 `&parse` 后缀里也有 `&`。含解析的历史行重渲必须按行序做完（SEK 解析会更新会话基准水量，ansi_up 也是流式状态），行数多时按时间片分批，不要改成倒序或并发；重放必须在隔离状态里做（每批换入重放用的 `skSession` 快照与 ansi_up 实例、批末换回实时状态），只有期间没有新行、也没有连接重置时，才把重放末态交给实时状态，否则批次之间到达的实时基准会被剩余历史帧覆盖，重连清掉的基准也会被恢复回来。

接收分包有两种方式（日志设置里的「超时 / 换行」，单双路各存一份 `splitMode`）：超时按字节间隔合包，0 为每次读回立即输出；换行按 `\n`（含 `\r\n`，行尾留在行内）立即成行，超时值只兜底没等到换行的残行，0 表示只等换行（发送前 `flushPendingRx` 仍会输出残行）。换行模式下 hostProto 半帧和以 SEK 帧头开头的缓冲不按 `0x0A` 切，交回协议分包，因为二进制帧里常有 0x0A。

串口会话关闭后仍记着原来的口（芯片继续显示该设备，点打开即重连）。热插拔 `connect` 事件只能把新插入的口交给当前模式里的空会话，或接回同型号（VID/PID）、收到过 `disconnect` 的口所在的会话（`findRebindSession`），不要改回「找第一个没打开的会话」：Chromium 对重插的设备给新的 SerialPort 对象，而关着但仍插着的口是用户选定的设备，按「没打开」认领会让随后插入或复位重枚举的另一台设备悄悄顶掉它，再点打开显示已连接、实际开的是别的设备，双路两台同时重插还会 A/B 串台。

串口调试视图的工具面板由 `js/workbench.js` 管理：每个工具是一个面板，用 `Workbench.registerPanel({ id, title, label, icon, el })` 注册，可停靠在右栏或底栏（底栏与协议解析共用外壳），最右侧停靠栏负责开合，底部状态栏显示连接时长、收发字节和运行中的后台任务。面板 DOM 是原样搬进停靠区的（不克隆），所以面板内控件的 id 和已绑定事件不受影响。新增工具时注册成面板，不要再往右栏里加 Bootstrap tab；需要跳到某个面板时调用 `Workbench.open(id)`，不要去点 DOM 按钮。右栏/底栏的开合状态沿用 `common.js` 里的 `serialRightPane` / `parsePanelDock`，不要另写一套。协议选择只有顶栏的 `#serial-protocol-select` 一处，不要在面板里再放一份镜像。随机读写、批量配置面板的「协议不支持」提示和停靠栏图标变暗，靠的是 CSS 匹配卡片上的内联 `style="display: none"`（协议模块用 `el.style.display` 控制显隐）；如果把协议模块改成切 class，要同步改 `css/style.css` 里 Workbench 段的这两个选择器，否则提示会不报错地失效。

界面有经典/现代两套布局，`html[data-layout]` 是唯一开关，首屏前由 `index.html` 按 localStorage `serial-debug-layout` 预置，运行时只能经 `window.setLayoutChoice` 切换（不刷新页面）：它先派发 `serial-layout-move`（`js/workbench.js` 搬 DOM），再派发 `serial-layout-change`（`common.js` 的右栏、底栏按新布局重放开合与宽高），两步同步做完才量尺寸。经典布局的 DOM 是基准，现代布局只换位置与外观、不改任何功能的代码路径：连接条 `#serial-connect-bar` 与状态栏 `#serial-statusbar` 搬进 `#app-shell` 网格里新建的 `#app-topbar` / `#app-statusbar`（三个视图共用，状态栏不在串口视图时也刷新），协议解析的 `#serial-parse-body` 连同锁定/清空键搬进右栏的「检查器」面板（排在停靠栏第一位；工作台里 `parse` 面板在现代布局下按 `MODERN_PROFILE` 改成可搬的右栏面板，底栏没有面板时整条隐藏）。现代布局的右栏头部与经典布局一样只显示当前面板的图标与标题加「移到底部」「收起」，面板的切换、开合只走最右侧停靠栏，不要再在头部加一条面板标签条：它与停靠栏重复，且标签条本身不提供停靠栏没有的功能。检查器上半是 `js/modern-inspector.js` 画的结构化视图（头部方向/帧标题/协议·时间·长度·应答耗时·校验徽标、键值表、16 字节一行的字节视图、从请求到应答的相关行），数据来自 `common.js` 里 `parseProtocolBytes` 解析完派发的 `serial-parse-frame` 事件（`detail` 为 `null` 表示清空）和当前协议的 `logView(r)`，文本一律 `textContent`，只有 `section.html` 原样插入；模型没有字节偏移，所以字段悬停不高亮字节，只按 `byteMap` 的分组高亮同组字节，不要去猜偏移。没有 `logView` 或不识别的帧不在结构化视图里重画，改为自动展开下方「原始输出」折叠区——原来的 HEX 输入区（点击读剪贴板、粘贴）和 `formatFrame` 输出区原样放在里面，它们仍是解析的数据源，不要删。检查器底部的「基于此帧」只调 `window.serialFrameActions`（重发走 `serialApi.writeRaw`，存快捷发送走 `appendQuickItem` + `saveQuickList`；各协议没有「帧回填下发表单」的反解析能力，所以没有「在下发中打开」，不要在没有反解析的情况下假做）。双路视图选「气泡」时是时间线：A 路气泡靠轴列左侧、B 路靠右，中间轴列显示时间、Δ、静默分隔，派生数据由 `js/modern-timeline.js` 用 MutationObserver 算出后只写成行上的 `data-mdn-*` 属性（静默文本挂在行首 `.log-time` 上，因为伪元素只能读自己宿主的属性），由 CSS 伪元素画出；不要往 `#serial-logs-dual` 里插兄弟节点，裁剪行数按子节点数算、复制导出逐子节点读文本、持久化存整份 innerHTML，插进去的节点会被一并误删或写进导出。持久化前 `paneHtml` 经 `window.serialLogPersistClean` 去掉全部 `data-mdn-*`，切回经典布局时也清掉属性与吸顶列头 `#mdn-tl-head`（列头是日志容器外面的兄弟节点，不进日志内容）。慢应答的判据是「本路 TX 之后的第一条 RX」距该 TX 超过 1 s（`ModernTimeline.SLOW_MS`），之后同一请求的持续上报不算；相邻两条 A/B 收发行间隔超过 2 s 插入「静默」（`GAP_MS`），系统行不参与；选中帧的底带是它到本路下一条应答之间的所有行（RX 则回溯到它所应答的请求），用超大扩展阴影加 `clip-path` 画成通栏，不改行盒。固件升级面板 `#nav-firmware` 搬进固件打包页的 `#fw-pack-upgrade` 并从停靠栏隐藏（`Workbench.open('firmware')` 在现代布局下改为切到固件页），固件页再由 `js/modern-firmware.js` 重建成四步流水线（选择固件 → 生成升级包 → 升级 → 校验）：顶部四步状态条与各卡片里的新控件（产物列表、下载、「用此包升级」、分块格子图、校验页的查询键）只订阅 `js/firmware-packager.js` / `js/firmware-upgrade.js` 派发到 document 上的只读事件 `fw-pack` / `fw-upgrade` 来派生状态，动作一律驱动现有逻辑（`setFwUpgradeFile`、`FirmwarePackager.downloadBlob`、点击原 `#fw-query`），不另写业务；两个原面板里的控件节点（拖拽卡、输出类型、ZIP 开关、开始生成、固件文件卡、分片大小、解析/诊断、读取固件信息、开始/停止/查询/清空、进度条、两份日志）同样原样搬进卡片并留占位，原容器 `.fw-pack-wrapper` 与 `#fw-pack-upgrade` 只在流水线挂上后才由 `:has(> #mdn-fw)` 的 CSS 隐藏，所以流水线没挂上时还是 v1 的两栏。加挂钩只许发事件，不要动升级协议的时序与分支；分块「已确认」是设备转去请求别的块或上报下载结果（协议里没有逐块确认帧），「重发过」是设备重复请求了同一块；流水线不会在升级命令发出后自动发查询帧，校验靠用户点查询，因为设备此时在重启，自动查只会占住串口等超时；版本只显示代码里确有来源的值（裸固件取 0x4000 起、与包头 newFileInfo 同源的版本串，不是可见 ASCII 就不显示；升级包取 `FirmwareParser` 的解析结果；设备版本取查询应答），不要按文件名猜。搬节点一律原样移动、不克隆，因为面板里的控件 id、已绑定事件、输入框内容与升级/测试进行中的状态都挂在节点上，克隆会丢；搬之前在原位置留注释占位，切回经典按占位放回、新建宿主删掉，并把只是 toggle 顺序变了的 class 原文写回，保证切回后经典布局的 DOM 与进入前逐字一致，新加搬运点必须同样留占位。现代布局下的面板分布、右栏宽度/开合、底栏高度/开合只写带 `Modern` 后缀的键（`workbenchStateModern`、`sidebarCollapsedModern`、`sidebarWidthsModern`、`parsePanelStateModern`，由 `window.layoutStateKey` 换算），不要写回 `workbenchState` 等经典键；本次会话里去过的布局按离开时的内联值原样还回去，不要改成经 `applyHeight` 重新钳位，视图隐藏时量不出高度会把底栏压到下限。现代布局的 CSS 一律写在 `css/style.css` 末尾现代布局段之后、选择器以 `html[data-layout='modern']` 开头，只有给经典布局里也存在的新元素做 `display: none` 的基础规则例外；经典布局的截图与 DOM 要与改动前、以及「切到现代再切回」之后逐像素一致。功耗页的现代布局由 `js/modern-power.js` 搭：原 `.blu-connect-bar` 的控件搬进它内部新建的 `#mp-toolbar`（记录模式/存储预算与采集触发收进两枚芯片的弹出层），`.blu-wrapper` 里新建 `#mp-body`，左主区放视图工具、读数（直接搬 `#blu-current` 等原节点，由 blu-power.js 按原节奏写值，不要另起定时器或镜像副本）、波形区与光标条，右栏标签页放统计卡、各分析面板、停靠的「串口发送」面板与运行日志；右栏的分析标签只通过点击隐藏的原 `.blu-analysis-tab` 切换（它负责展开与按新尺寸强制重画），进入现代布局时不得改动分析面板的标签与收起状态，所以保存的右栏标签与原面板当前标签不一致时退回「测量」；收起态要在 blu-power.js 的 click 处理之前（捕获阶段）先写到右栏，因为展开时画布是同步重画的，面板还隐藏着就会按 8px 画完。外壳与串口页的现代形态由 `js/modern-shell.js` 搭（在 `js/workbench.js` 之后加载、之后挂载，宿主都建在 workbench 的 `#app-topbar` 等宿主里或日志/发送区内）：左栏只留串口/固件/功耗与「配置」，主题三档（新 `.ctl-seg`，调 `setThemeChoice`、跟随原 `#theme-switch` 的 `aria-checked`）和反馈/GitHub 链接收进「配置」菜单；连接栏原 `#serial-connect-bar` 整条隐藏，换成 `#mdn-connbar` 的每路连接按钮，设备芯片 `#serial-chip*`、路标签输入框、串口参数卡、主发分段、协议选择、命令键原样搬进去（参数卡只有一份，打开哪一路的菜单就挂到哪一路；菜单里的选口按钮用 CSS 排成两行网格，设备名独占第一行并可折行，改名 / 清除别名 / 取消选择三枚小键落在第二行靠右，不要改回单行 flex，名字一长小键会被挤出芯片裁掉），「+ B 路」「回到单路」只点原 `#serial-mode-*`；日志标题行隐藏，格式胶囊、分包分段与超时框、行数框、行日志/终端、自动滚动等动作组、双路列表/时间线分段原样搬进 `#mdn-logbar`；发送区标题隐藏，快捷行 `#mdn-quickrow` 的分组下拉与快捷按钮只镜像右栏快捷发送（改分组是给原 `#serial-quick-send` 赋值再派发 change，发送是点原行的 `.quick-send`），快捷行右端的「发往」分段（按钮文字取 `SerialHub.getLabelA/B`，只在双路显示）取代原来只显示「→ A路」的 `#serial-send-target`，与连接栏「主发」是同一状态，点击只转给原主发按钮，不要在发送区再放一份「发 A / 发 B」；`#serial-send-target` 不搬，仍留在被隐藏的标题行里，由 `js/workbench.js` 给经典布局写，输入行是把发送键 `#serial-send` 搬到 `.send-options` 末尾、两层改成 flex 一行；状态栏的 STS 模拟任务是 `TASKS` 里带 `modernOnly` 的一项，经典状态栏不显示。日志过滤只给不匹配的行加 `mdn-flt-out` 类（现代布局才隐藏），复制、导出仍是全部行（`getLogsText` 用 `innerText`，对 display:none 的行返回全文），类名会随 `innerHTML` 进会话缓存，所以挂载时与每批新行都会按当前过滤重算、切回经典时全部摘掉，不要改成删行或改行内容。镜像刷新不要用 `requestAnimationFrame` 合批，后台标签页里它会一直挂起；发送区不要用 `field-sizing: content`、`order` 或 `display: contents` 重排，Chrome 切回经典后会漏算这些元素的样式，把经典发送区的输入框和发送键排反；`<textarea>` 即使没有这些属性也偶发漏算（留着现代布局的 `min-height`），所以挂载/卸载末尾的 `restyleTextareas` 会把它摘出渲染树再放回逼它重算，不要删。

hostProto 模组协议与 STS 应用层协议各占一组文件：`js/hostproto-protocol.js` 是模组指令层的帧编解码，并注册成顶栏的 `hostproto` 日志解析协议；`js/hostproto-transaction.js` 是主机端事务层（串行请求应答、逐字节同帧重发、EVT 分发），平台依赖全部注入；`js/sts-ciu-protocol.js` 是应用层报文的编解码与接收判定，只导出 `window.stsCiu` 供嵌套解码和引擎使用，不单独注册成顶栏协议；`js/sts-sim.js` 是表端和 CIU 两个模拟引擎，不碰 DOM、localStorage 和 `serialApi`，只经注入的 link 与时钟工作；`js/sts-sim-panel.js` 才是「STS 模拟」面板的界面与串口接线。改引擎行为时不要把 DOM 或串口依赖带进 `js/sts-sim.js`，否则 node 里的端到端测试就跑不起来。

两端只配一个 DRN（IEC 62055-41：厂商码 + 8 位表号 + 1 位校验），应用层帧里的 8 位表号由 `drnToMeterNo` 从 DRN 里取，算法是 `(DRN / 10) mod 10^8`，不要改成按字符串位数切：模组里 DRN 是 u64 整数，厂商码的前导 0 会丢，`0101…` 存进去只剩 12 位，按位数切会取错表号，帧会悄悄发给另一只表。模拟器不做钥表下发，也不接触主密钥，PAK 输入框不落盘，PAK、钥表密钥在解析展示里一律脱敏。协议事务发整帧走 `serialApi.writeRaw(data, { logData })`：不追加 CRLF，日志只显示 `logData` 给的脱敏副本，真实串口仍写原帧；不要为了发整帧去改用户的「追加 CRLF」偏好，那个开关会被持久化，运行中用户也能重新打开，而且普通 `writeData` 会把含密钥的原帧写进日志和 sessionStorage。

表端运行值（剩余量、累计使用量、总购买量、电池、告警码）只能经 `meter.setLive` 修改，它和配置共用 `normalizeLiveFields` 这一套校验，不要在面板里另写校验；计价模式与小数位只允许停止时改，因为存量数值（余额、记录、去重的终局载荷）都按旧标度存着，运行中换标度会让它们的含义悄悄变掉。阀控测试（WRITE 0x80）的规则是：每条指令都真实动作（受理后位置报不明并置 bit2，经 `valveDelayS` 到位才给终局 0x00），关阀到位后保持 10 分钟再自动恢复成指令前状态（恢复本身也走动作过程），开阀不设保持期，受理即取消关阀保持期；「是否保持期内的同方向重发」在收到指令时判定并锁进那笔工作，不能到动作完成时再判断，因为余时可能已小于动作耗时；保持期若在这条重发动作期间到期，它按新的关阀指令收尾、重新开始 10 分钟，应恢复的原值暂存在 `restoredPre`，表体重启也要读它，否则会停在关阀。这是有意偏离协议 §7 和 C 参考实现（那里保持期内的重复写不动阀门），需求方确认：阀控测试的目的只是防止产线测试后表以关阀状态出厂，所以不要「修回」协议行为。手动改阀门位置会取消进行中的动作和保持期（在飞的阀控待办给终局 0x00），只改故障位不会；动作到位回调必须校验动作序号 `valveSeq`，保持期回调必须先确认当前保持对象仍在且已到截止时间，取消时同时清定时器，不要让迟到的回调直接覆盖阀门位置。

WorLink 会话是停等 ARQ：表端被唤醒时模组清空上行队列并发 kind=2 通知，`WOR_SET_UPLINK` 是追加入队（深度 4，空载荷清空），由每拍 DACK 捎带，下行排空后进入轮询相，由表端 END 或模组空闲看门狗（最后一次活动后约 8s，reason=8）收尾，终结经 EVT 0x0281 双侧通知。表端不要在会话外预置上行，唤醒会把它清掉。判「未 WOR_INIT」时 `ERR_NOT_INIT`(0x09) 和 `ERR_STATE`(0x06) 都要认，旧固件两态共用 0x06。不要按 `src` 过滤捎带上行（kind=4）：会话帧不带地址，实板上报的 `src` 是 0，按目标 DRN 过滤会把应答静默丢掉，认领靠应用层接收判定（表号 + TXN）。

CIU 上电后只 `WOR_INIT` 一次：启动时先查 `WOR_GET_STATUS`，未初始化（`ERR_NOT_INIT` / 旧固件 `ERR_STATE`）才发 `WOR_INIT`(role=2 INITIATOR, addr=本机 DRN)，会话前不要再发，重复 INIT 只会回 `ERR_BUSY`；会话里只有 WAKE 回未初始化（模组中途复位）才补一次 INIT 再 WAKE，补后仍未初始化就失败，不要循环。本机 DRN 取自 DEV_ID_GET，不要从 WOR_GET_STATUS 的运行地址取；CIU 既不发 `WOR_FINISH` 也不发 `WOR_ABORT`，成败都立即返回：会话由空闲看门狗或表端 END 自行收尾，之后 FINISH 只会回 ERR_STATE，也不要在 WAKE 后预挂 FINISH（会让发起端排空下行后直接发 END，表端应答没有拍可捎带）；`WOR_SEND` 回 BUSY（模组 FIFO 深度 4）隔约 1.4s 重发同一帧。除启动核对外，运行期两端都不发 WOR_GET_STATUS 和统计查询，CIU 不做会话保活，唤醒和 ACK 等待阶段保持串口安静（持续查询会反复错过 ACK）。靠硬等待超时衔接相邻会话：下一轮 WAKE 前先硬等上一已受理会话的 0x0281（上限 15s，成功和失败一视同仁，0x0281 由 CIU 级订阅记录，不随 runSession 退订），再冷却 1.2s（表端收尾还需约 1s，受应用层总预算约束），超时仍 WAKE，回 BUSY 走原有等待重试；0x0281 只在当前 WAKE 受理之后才算本轮的。CIU 的 `setTarget` 只在没有操作、没有待办、没有在飞事务时生效，会重建应用层策略并对新表重读计价模式与协议版本，不要绕过它直接改目标 DRN。

## 运行与测试

- `python3 -m http.server 8000` 起本地静态服务后用 Chrome 或 Edge 打开（Web Serial API 只有 Chromium 系支持）；`open index.html` 走 `file://` 只适合快速看布局。
- `node tests/cjt188-protocol.cjs`：CJ/T 188 协议解析的回归测试，改 `js/cjt188-protocol.js` 后必须跑。测试只用合成数据，不要放真实设备日志。
- `node tests/sts-ciu-protocol.cjs`：STS 应用层协议（`js/sts-ciu-protocol.js`）的编解码、接收判定与边界回归，改该文件后必须跑。
- `node tests/hostproto-protocol.cjs`：hostProto 模组指令层（`js/hostproto-protocol.js`）的 CRC/组帧/找帧重同步/解析展示，以及事务层（`js/hostproto-transaction.js`，假时钟）回归，改这两个文件后必须跑。
- `node tests/parse-view.cjs`：日志「解析」渲染器（`js/parse-view.js`）的转义、折叠、键值对拆分，以及 SEK / 工装 / W-MBUS 三个协议 `logView` 的模型回归，改渲染器或这些 `logView` 后必须跑。
- `node tests/serial-line-split.cjs`：接收分包（`js/common.js` 里 `//单个合并包的字节上限` 到 `//对外暴露的串口接口` 之间，按锚点注释截取，别删）的按超时 / 按换行两种方式及协议帧保护回归，改这段后必须跑。
- `node tests/serial-hotplug.cjs`：串口热插拔（`js/common.js` 里 `SerialHub` 对象与 `connect` / `disconnect` 监听两段，按 `function makeSerialSession(` 与 `function serialStatuChange(` 等锚点截取）的会话认领回归：关着的口不被别的设备顶替、重插的新对象接回原会话、双路按型号各回各路，改这两段后必须跑。
- `node tests/sts-sim.cjs`：STS 表端与 CIU 两个模拟引擎（`js/sts-sim.js`）经假模组对的端到端回归，含会话丢弃注入、表端重启、预算耗尽，改引擎后必须跑。
- `node tests/sts-sim-panel.cjs`：「STS 模拟」面板（`js/sts-sim-panel.js`，假 DOM + 假引擎）的单路/双路隔离、配置持久化与不落盘项、启停与断线重连、启动超时退避回归，改面板后必须跑。以上 STS / hostProto 测试同样只用合成数据，不要放真实钥表、PAK 或设备标识。
- `node tests/modern-timeline.cjs`：现代布局双路时间线（`js/modern-timeline.js`）与检查器结构化视图（`js/modern-inspector.js`）的纯函数回归：时间/Δ/静默格式、Δ 与静默与慢应答逐条计算（含增量与整段一致）、请求到应答的交互区间、持久化清理、视图模型拍平与头部摘要，改这两个文件后必须跑。
- `node tests/modern-firmware.cjs`：现代布局固件流水线（`js/modern-firmware.js`）的纯函数回归：裸固件内嵌版本识别、分块格子状态与合并、`fw-pack` / `fw-upgrade` 事件归约、四步状态推导、传输速率与剩余时间，改该文件或两个固件文件派发的事件后必须跑。
- `node tests/blu-serial-lane.cjs`：功耗分析串口事件道（`js/blu-serial-lane.js`，仅现代布局显示）的纯函数回归：样点下标与墙钟的锚点映射（含停采续采间隙、墙钟回拨）、可见范围二分、密集合并、日志行分道，改该文件后必须跑。
- `node tests/modern-shell.cjs`：现代布局外壳（`js/modern-shell.js`）的纯函数回归：日志过滤的语法解析（方向词、连续两位十六进制合成字节序列、关键字）与行匹配、连接按钮参数摘要，改该文件的这几个函数后必须跑。
- 其余没有自动化测试，涉及 UI 或串口逻辑的修改要在浏览器里连接真实或虚拟串口手动验证：日志相关检查 HEX、TEXT、ANSI、解析四种显示模式；发送路径检查 HEX/TEXT 输入、循环发送、CRLF 追加和快捷发送按钮；配置相关刷新页面，确认 localStorage 中的设置能正确恢复。

## 编码风格

保持原生 HTML/CSS/JavaScript：浏览器全局 API、`let`/`const`、单引号、无分号、Tab 缩进；CSS 用 Tab 缩进和简单选择器；HTML 四空格缩进，大量使用 Bootstrap 工具类。新增元素 ID 优先沿用 `serial-*` 命名模式。不要引入框架、打包器或转译工具；调整 CDN 依赖直接改 `index.html`。

布尔类控件按语义选形态，不按外观拉平，统一的类在 `css/style.css` 末尾「统一控件」段：`.ctl-switch` 用于改完立即生效并持久化的设置（悬停提示、失败继续、打包为 ZIP 之类）；`.ctl-chip` 用于修饰「待发送 / 待生成内容」的表单项（HEX、+\r\n、前导码、输出包类型、去 DC），也用于日志正文的显示格式复选（HEX / TEXT / 解析 / ANSI 彩色），选中态除了变色还加一个 ✓，不能只靠颜色区分，另有 `--mono`（协议字面量用等宽）、`--sm`、`--micro` 三个尺寸/字体修饰类，拿不到 `<input>` 的地方（JS 拼出来的工具条按钮，如 BLU 串口发送面板的 HEX/CRLF）用同款视觉的 `.ctl-chip-btn`，状态同样只认 `aria-pressed`；`.ctl-toggle` 用于工具栏上的视图/工具按下态（自动滚动、暂停滚动、均值带、±1σ、Y 轴锁定、全屏、上电），状态源**只认 `aria-pressed`**，不要再用 `.active` / `.is-on` / 按钮文案存状态——状态存在按钮文案里时，多处代码各读一遍，改文案就会让功能静默反向；`.ctl-seg` 用于 N 选一（单路/双路、主发 A/B），选中态是实心填充，跟 `.ctl-toggle` 的描边按下态必须看得出区别。展开/收起（`aria-expanded`，如协议解析折叠、停靠栏开合）不属于以上任何一类，不要套这些类。`.ctl-switch` 把 Bootstrap `form-switch` 的 float + 负 margin 排版换成了 flex，所以同时清掉了 `padding-left` / `float` / `margin`，少清一项 label 就会压到开关上。

不要设置鼠标指针样式（CSS `cursor`、JS `style.cursor`），`css/style.css` 末尾已把 Bootstrap 给按钮加的手型还原为默认；也不要给悬停状态加位移或缩放（`transform`）。指针在相邻元素间来回切换样式、元素悬停时移动导致鼠标在进出之间反复触发，移动鼠标会显得发抖。各视图顶栏统一用 `.view-bar`（功耗分析的 `.blu-connect-bar` 同样式），与串口调试的连接条同高、贴边。

## 版本号

网站版本写在 `js/version.js` 的 `window.APP_VERSION`（SemVer），左下角导航栏显示为 `vX.Y.Z`。**这是唯一来源**，不要在 HTML 里再写死一份。

提交用户可见改动时按改动类型 bump，与改动同批提交，版本号不写进 commit message：

| 改动类型 | bump |
| --- | --- |
| 破坏性变更 / 不兼容（如布局大改导致旧配置失效） | MAJOR |
| 新功能 `feat:` | MINOR |
| 缺陷修复 `fix:` | PATCH |
| 样式/文案/小优化 `style:` `refactor:` `docs:` | PATCH |
| 仅内部/无用户感知（注释、忽略文件、仓库文档等） | 不 bump |

含多种改动时取最高级别（feat+fix → MINOR）。功能分支内多个 commit 不逐次 bump，以 main 为基准按分支整体最高级别只 bump 一次。

## 分支、提交与 PR

先从最新 `main` 开 `feat/xxx` / `fix/xxx` 分支再改，不要直接改 `main`。commit message 用 Conventional Commit 前缀（`feat:`、`fix:`、`style:` 等）。

PR 正文只写 **Summary**（用户可见变化、版本号变化）；涉及界面变化附截图或录屏；修复串口设备兼容性问题时关联 issue 或说明设备/浏览器环境。**不要写 Test plan。**

## 安全与隐私

不要提交个人串口日志、设备标识、账号凭据、私有端点或其他敏感信息。

串口收到的数据和设备自报的字符串（如 USB 序列号）都是**不可信输入**，一律用 `textContent` 渲染。只有工具自己拼出来的 HTML 才允许走 `innerHTML`，且不要用"字符串里有没有 `<`"这类启发式来判断来源——要在数据结构上把两者分开。
