# Repository Guidelines

## 项目结构与模块组织

本仓库是一个静态 Web Serial 串口调试工具。入口文件是 `index.html`，负责页面结构并通过 CDN 加载 Bootstrap、Bootstrap Icons、xterm.js、JSZip。主要业务逻辑在 `js/common.js`，包括串口打开/关闭、快捷发送、日志展示、协议注册表等。协议解析、固件升级/打包、BLU 功耗分析各自拆在 `js/` 下的独立文件里，按 `index.html` 末尾的 `<script>` 顺序加载。样式集中在 `css/style.css`，图片和界面截图放在 `imgs/`。当前没有 `tests/` 目录，也没有构建系统。

## 构建、测试与本地运行

项目无需安装依赖或编译。

- `open index.html`：在 macOS 上直接打开页面，适合快速检查布局。
- `python3 -m http.server 8000`：启动本地静态服务，适合排查 `file://` 与浏览器安全策略差异。
- 使用 Edge 或 Chrome 做功能验证，因为 Web Serial API 依赖浏览器支持。

验证串口功能时，连接真实或虚拟串口设备，授权浏览器访问后，检查打开/关闭、参数修改、发送模式、日志显示、自动重连、配置导入导出等流程。

## 编码风格与命名约定

保持现有的原生 HTML/CSS/JavaScript 风格。`js/common.js` 使用浏览器全局 API、`let`/`const`、单引号、无分号和 Tab 缩进。CSS 也使用 Tab 缩进和简单选择器规则。HTML 使用四空格缩进，并大量使用 Bootstrap 工具类。新增元素 ID 优先沿用 `serial-*` 命名模式，例如 `serial-logs`、`serial-baud`。

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

### 功能分支内的版本策略

功能分支未合入 main 前，分支内多个 commit 不逐次 bump；以 main 为基准、按分支整体最高改动级别只 bump 一次（通常在准备提 PR 时）。PR 合入后 main 上再按逐 commit 规则执行。

## 分支与工作流

**先开分支再改代码**，不要在 `main` 或无关分支上直接改。流程：`git checkout main && git pull` → `git checkout -b feat/xxx` 或 `fix/xxx` → 修改 → commit → push → PR。合入并删除远端分支后，本地切回 `main` 并 `git pull`，删掉本地功能分支。

## 提交与 Pull Request 规范

近期提交使用简洁的 Conventional Commit 风格前缀，包括 `feat:`、`fix:`、`style:`。继续沿用该格式，例如 `fix: handle serial reconnect failure` 或 `feat: add quick-send import validation`。

PR 正文只写：**Summary**（用户可见变化、版本号变化）；涉及界面变化时附截图或录屏；若修复串口设备兼容性问题，关联 issue 或说明设备/浏览器环境。

**不要写 Test plan**（本仓库 PR 不需要该章节）。

## 安全与隐私

不要提交个人串口日志、设备标识、账号凭据、私有端点或其他敏感信息。

串口收到的数据和设备自报的字符串（如 USB 序列号）都是**不可信输入**，一律用 `textContent` 渲染。只有工具自己拼出来的 HTML 才允许走 `innerHTML`，且不要用"字符串里有没有 `<`"这类启发式来判断来源——要在数据结构上把两者分开。
