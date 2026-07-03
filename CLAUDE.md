# Repository Guidelines

## 项目结构与模块组织

本仓库是一个静态 Web Serial 串口调试工具。入口文件是 `index.html`，负责页面结构并通过 CDN 加载 Bootstrap、CodeMirror 等依赖。主要业务逻辑在 `js/common.js`，包括串口打开/关闭、快捷发送、日志展示、脚本 Worker 通信等。样式集中在 `css/style.css`，图片和界面截图放在 `imgs/`。当前没有 `tests/` 目录，也没有构建系统。

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

## 提交与 Pull Request 规范

近期提交使用简洁的 Conventional Commit 风格前缀，包括 `feat:`、`fix:`、`style:`。继续沿用该格式，例如 `fix: handle serial reconnect failure` 或 `feat: add quick-send import validation`。

PR 应说明用户可见变化、列出已测试浏览器；涉及界面变化时附截图或录屏。若修复串口设备兼容性问题，请关联对应 issue 或说明设备/浏览器环境。

## 安全与隐私

不要提交个人串口日志、设备标识、账号凭据、私有端点或其他敏感信息。修改自定义脚本功能时要格外谨慎，因为它会通过 Worker 消息机制执行用户提供的 JavaScript。
