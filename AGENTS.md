# Repository Guidelines

## 项目结构

静态 Web Serial 串口调试工具，无构建系统、无需安装依赖。入口 `index.html` 负责页面结构，并通过 CDN 加载 Bootstrap、Bootstrap Icons、xterm.js、JSZip。主要业务逻辑在 `js/common.js`（串口开关、快捷发送、日志展示、协议注册表等）；协议解析、固件升级/打包、BLU 功耗分析各自拆在 `js/` 下的独立文件里，按 `index.html` 末尾的 `<script>` 顺序加载。样式集中在 `css/style.css`，图片放在 `imgs/`。日志格式「解析」（`logType` 带 `parse`，可与 HEX/TEXT 同行显示或单独显示）由协议的 `logView(r)` 返回视图模型（不识别的帧返回 null，多帧返回数组），`js/parse-view.js` 的 `ParseView.render` 统一转义并渲染成行内 `.pv` 块，没有 `logView` 的协议退回 `formatFrame` 的老样式，底部「协议解析」面板仍用 `formatFrame`；模型里的文本一律由渲染器转义，只有 `section.html` 原样插入，只能放协议自己拼且已转义的片段。不要再加独立的实时解析开关，也不要在日志里另插解析块；`renderLogBody` 里 HEX/TEXT 并排只认 `parseLogType(t)` 拆出的 hex 与 text 同时存在，不要对 `logType` 做 `includes('&')`，因为 `&parse` 后缀里也有 `&`。含解析的历史行重渲必须按行序做完（SEK 解析会更新会话基准水量，ansi_up 也是流式状态），行数多时按时间片分批，不要改成倒序或并发；重放必须在隔离状态里做（每批换入重放用的 `skSession` 快照与 ansi_up 实例、批末换回实时状态），只有期间没有新行、也没有连接重置时，才把重放末态交给实时状态，否则批次之间到达的实时基准会被剩余历史帧覆盖，重连清掉的基准也会被恢复回来。

接收分包有两种方式（日志设置里的「超时 / 换行」，单双路各存一份 `splitMode`）：超时按字节间隔合包，0 为每次读回立即输出；换行按 `\n`（含 `\r\n`，行尾留在行内）立即成行，超时值只兜底没等到换行的残行，0 表示只等换行（发送前 `flushPendingRx` 仍会输出残行）。换行模式下 hostProto 半帧和以 SEK 帧头开头的缓冲不按 `0x0A` 切，交回协议分包，因为二进制帧里常有 0x0A。

串口调试视图的工具面板由 `js/workbench.js` 管理：每个工具是一个面板，用 `Workbench.registerPanel({ id, title, label, icon, el })` 注册，可停靠在右栏或底栏（底栏与协议解析共用外壳），最右侧停靠栏负责开合，底部状态栏显示连接时长、收发字节和运行中的后台任务。面板 DOM 是原样搬进停靠区的（不克隆），所以面板内控件的 id 和已绑定事件不受影响。新增工具时注册成面板，不要再往右栏里加 Bootstrap tab；需要跳到某个面板时调用 `Workbench.open(id)`，不要去点 DOM 按钮。右栏/底栏的开合状态沿用 `common.js` 里的 `serialRightPane` / `parsePanelDock`，不要另写一套。协议选择只有顶栏的 `#serial-protocol-select` 一处，不要在面板里再放一份镜像。随机读写、批量配置面板的「协议不支持」提示和停靠栏图标变暗，靠的是 CSS 匹配卡片上的内联 `style="display: none"`（协议模块用 `el.style.display` 控制显隐）；如果把协议模块改成切 class，要同步改 `css/style.css` 里 Workbench 段的这两个选择器，否则提示会不报错地失效。

界面有经典/现代两套布局，`html[data-layout]` 是唯一开关，首屏前由 `index.html` 按 localStorage `serial-debug-layout` 预置，运行时只能经 `window.setLayoutChoice` 切换（不刷新页面）：它先派发 `serial-layout-move`（`js/workbench.js` 搬 DOM），再派发 `serial-layout-change`（`common.js` 的右栏、底栏按新布局重放开合与宽高），两步同步做完才量尺寸。经典布局的 DOM 是基准，现代布局只换位置与外观、不改任何功能的代码路径：连接条 `#serial-connect-bar` 与状态栏 `#serial-statusbar` 搬进 `#app-shell` 网格里新建的 `#app-topbar` / `#app-statusbar`（三个视图共用，状态栏不在串口视图时也刷新），协议解析的 `#serial-parse-body` 连同锁定/清空键搬进右栏第一个标签「检查器」（工作台里 `parse` 面板在现代布局下按 `MODERN_PROFILE` 改成可搬的右栏面板，底栏没有面板时整条隐藏），检查器底部的「基于此帧」只调 `window.serialFrameActions`（重发走 `serialApi.writeRaw`，存快捷发送走 `appendQuickItem` + `saveQuickList`），固件升级面板 `#nav-firmware` 搬进固件打包页的 `#fw-pack-upgrade` 并从标签条、停靠栏隐藏，`Workbench.open('firmware')` 在现代布局下改为切到固件页。搬节点一律原样移动、不克隆，因为面板里的控件 id、已绑定事件、输入框内容与升级/测试进行中的状态都挂在节点上，克隆会丢；搬之前在原位置留注释占位，切回经典按占位放回、新建宿主删掉，并把只是 toggle 顺序变了的 class 原文写回，保证切回后经典布局的 DOM 与进入前逐字一致，新加搬运点必须同样留占位。现代布局下的面板分布、右栏宽度/开合、底栏高度/开合只写带 `Modern` 后缀的键（`workbenchStateModern`、`sidebarCollapsedModern`、`sidebarWidthsModern`、`parsePanelStateModern`，由 `window.layoutStateKey` 换算），不要写回 `workbenchState` 等经典键；本次会话里去过的布局按离开时的内联值原样还回去，不要改成经 `applyHeight` 重新钳位，视图隐藏时量不出高度会把底栏压到下限。现代布局的 CSS 一律写在 `css/style.css` 末尾现代布局段之后、选择器以 `html[data-layout='modern']` 开头，只有给经典布局里也存在的新元素做 `display: none` 的基础规则例外；经典布局的截图与 DOM 要与改动前、以及「切到现代再切回」之后逐像素一致。

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
- `node tests/sts-sim.cjs`：STS 表端与 CIU 两个模拟引擎（`js/sts-sim.js`）经假模组对的端到端回归，含会话丢弃注入、表端重启、预算耗尽，改引擎后必须跑。
- `node tests/sts-sim-panel.cjs`：「STS 模拟」面板（`js/sts-sim-panel.js`，假 DOM + 假引擎）的单路/双路隔离、配置持久化与不落盘项、启停与断线重连、启动超时退避回归，改面板后必须跑。以上 STS / hostProto 测试同样只用合成数据，不要放真实钥表、PAK 或设备标识。
- `node tests/blu-serial-lane.cjs`：功耗分析串口事件道（`js/blu-serial-lane.js`，仅现代布局显示）的纯函数回归：样点下标与墙钟的锚点映射（含停采续采间隙、墙钟回拨）、可见范围二分、密集合并、日志行分道，改该文件后必须跑。
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
