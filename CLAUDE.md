# Repository Guidelines

## 项目结构与模块组织

本仓库是一个静态 Web Serial 串口调试工具。入口文件是 `index.html`，负责页面结构并通过 CDN 加载 Bootstrap、Bootstrap Icons、xterm.js、JSZip。主要业务逻辑在 `js/common.js`，包括串口打开/关闭、快捷发送、日志展示、协议注册表等。协议解析、固件升级/打包、BLU 功耗分析各自拆在 `js/` 下的独立文件里，按 `index.html` 末尾的 `<script>` 顺序加载。样式集中在 `css/style.css`，图片和界面截图放在 `imgs/`。当前没有 `tests/` 目录，也没有构建系统。

串口调试视图的工具面板由 `js/workbench.js` 管理：每个工具是一个面板，用 `Workbench.registerPanel({ id, title, label, icon, el })` 注册，可停靠在右栏或底栏（底栏与协议解析共用外壳），最右侧停靠栏负责开合，底部状态栏显示连接时长、收发字节和运行中的后台任务。面板 DOM 是原样搬进停靠区的（不克隆），所以面板内控件的 id 和已绑定事件不受影响。新增工具时注册成面板，不要再往右栏里加 Bootstrap tab；需要跳到某个面板时调用 `Workbench.open(id)`，不要去点 DOM 按钮。右栏/底栏的开合状态沿用 `common.js` 里的 `serialRightPane` / `parsePanelDock`，不要另写一套。协议选择只有顶栏的 `#serial-protocol-select` 一处，不要在面板里再放一份镜像。随机读写、批量配置面板的「协议不支持」提示和停靠栏图标变暗，靠的是 CSS 匹配卡片上的内联 `style="display: none"`（协议模块用 `el.style.display` 控制显隐）；如果把协议模块改成切 class，要同步改 `css/style.css` 里 Workbench 段的这两个选择器，否则提示会不报错地失效。

## 构建、测试与本地运行

项目无需安装依赖或编译。

- `open index.html`：在 macOS 上直接打开页面，适合快速检查布局。
- `python3 -m http.server 8000`：启动本地静态服务，适合排查 `file://` 与浏览器安全策略差异。
- 使用 Edge 或 Chrome 做功能验证，因为 Web Serial API 依赖浏览器支持。

验证串口功能时，连接真实或虚拟串口设备，授权浏览器访问后，检查打开/关闭、参数修改、发送模式、日志显示、自动重连、配置导入导出等流程。

## 编码风格与命名约定

保持现有的原生 HTML/CSS/JavaScript 风格。`js/common.js` 使用浏览器全局 API、`let`/`const`、单引号、无分号和 Tab 缩进。CSS 也使用 Tab 缩进和简单选择器规则。HTML 使用四空格缩进，并大量使用 Bootstrap 工具类。新增元素 ID 优先沿用 `serial-*` 命名模式，例如 `serial-logs`、`serial-baud`。

布尔类控件按语义选形态，不按外观拉平，统一的类在 `css/style.css` 末尾「统一控件」段：`.ctl-switch` 用于改完立即生效并持久化的设置（实时解析、失败继续、打包为 ZIP 之类）；`.ctl-chip` 用于修饰「待发送 / 待生成内容」的表单项（HEX、+\r\n、前导码、输出包类型、去 DC），也用于日志正文的显示格式复选（HEX / TEXT / ANSI 彩色），选中态除了变色还加一个 ✓，不能只靠颜色区分，另有 `--mono`（协议字面量用等宽）、`--sm`、`--micro` 三个尺寸/字体修饰类，拿不到 `<input>` 的地方（JS 拼出来的工具条按钮，如 BLU 串口发送面板的 HEX/CRLF）用同款视觉的 `.ctl-chip-btn`，状态同样只认 `aria-pressed`；`.ctl-toggle` 用于工具栏上的视图/工具按下态（自动滚动、暂停滚动、均值带、±1σ、Y 轴锁定、全屏、上电），状态源**只认 `aria-pressed`**，不要再用 `.active` / `.is-on` / 按钮文案存状态——`#serial-auto-scroll` 以前把状态存在 innerText 里，`common.js` 和 `command-palette.js` 三处各读一遍，改文案就会让自动滚动静默反向；`.ctl-seg` 用于 N 选一（单路/双路、主发 A/B），选中态是实心填充，跟 `.ctl-toggle` 的描边按下态必须看得出区别。展开/收起（`aria-expanded`，如协议解析折叠、停靠栏开合）不属于以上任何一类，不要套这些类。`.ctl-switch` 把 Bootstrap `form-switch` 的 float + 负 margin 排版换成了 flex，所以同时清掉了 `padding-left` / `float` / `margin`，少清一项 label 就会压到开关上。

不要设置鼠标指针样式（CSS `cursor`、JS `style.cursor`），`css/style.css` 末尾已把 Bootstrap 给按钮加的手型还原为默认；也不要给悬停状态加位移或缩放（`transform`）。指针在相邻元素间来回切换样式、元素悬停时移动导致鼠标在进出之间反复触发，移动鼠标会显得发抖。各视图顶栏统一用 `.view-bar`（功耗分析的 `.blu-connect-bar` 同样式），与串口调试的连接条同高、贴边。

小改动不要引入框架、打包器或转译工具。若调整 CDN 依赖，应直接修改 `index.html` 并确认无需本地包安装也能运行。

## 测试指南

当前没有自动化测试。涉及 UI 或串口逻辑的修改都应进行手动浏览器验证。日志相关修改需检查 HEX、TEXT、ANSI 三种显示模式。发送路径相关修改需验证 HEX/TEXT 输入、循环发送、CRLF 追加和快捷发送按钮。配置相关修改需刷新页面，确认 localStorage 中保存的设置仍能正确恢复。

## 版本号

网站版本写在 `js/version.js` 的 `window.APP_VERSION`（SemVer，`MAJOR.MINOR.PATCH`），左下角导航栏会显示为 `vX.Y.Z`。**这是唯一来源**，不要在 HTML 里再写死一份。

每次提交用户可见改动前，必须先按改动类型 bump 版本再提交：

| 改动类型 | bump | 示例 |
| --- | --- | --- |
| 破坏性变更 / 不兼容 | MAJOR | 布局大改导致旧配置失效 |
| 新功能 `feat:` | MINOR | 新增反馈入口、协议预设 |
| 缺陷修复 `fix:` | PATCH | 串口重连失败 |
| 样式/文案/小优化 `style:` `refactor:` `docs:` | PATCH | 间距调整、文案润色 |
| 仅内部/无用户感知（注释、忽略文件等） | 不 bump | |

同一提交含多种改动时取最高级别（feat+fix → MINOR）。版本与 commit 同批提交，commit message 仍用 Conventional Commit，无需把版本写进 message。

## 提交与 Pull Request 规范

近期提交使用简洁的 Conventional Commit 风格前缀，包括 `feat:`、`fix:`、`style:`。继续沿用该格式，例如 `fix: handle serial reconnect failure` 或 `feat: add quick-send import validation`。

PR 应说明用户可见变化、版本号变化、列出已测试浏览器；涉及界面变化时附截图或录屏。若修复串口设备兼容性问题，请关联对应 issue 或说明设备/浏览器环境。

## 安全与隐私

不要提交个人串口日志、设备标识、账号凭据、私有端点或其他敏感信息。

串口收到的数据和设备自报的字符串（如 USB 序列号）都是**不可信输入**，一律用 `textContent` 渲染。只有工具自己拼出来的 HTML 才允许走 `innerHTML`，且不要用"字符串里有没有 `<`"这类启发式来判断来源——要在数据结构上把两者分开。
