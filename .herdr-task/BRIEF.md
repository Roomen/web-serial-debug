# Track B: 串口页双路监控（TX/RX sniffer）

## 工作区

- 独立 git worktree：当前目录即 worktree
- 分支：`feat/serial-dual-monitor`（已基于 main `077039b`）
- **不要** checkout 其它分支，**不要**碰主仓库工作区
- **不要** push、**不要** 建 PR
- 本地 commit 即可

## 目标

串口调试视图支持 **同时挂两个串口接收**，用于监控通信模组 **TX / RX 两路**交互报文。

默认保持 **单路模式**，行为与现在等价；用户切换到 **双路** 后出现 A/B 两会话。

## 已定架构（不要推翻）

### 模型

```
SerialSession { id: 'A'|'B', label, port, open, options, packBuf, reader... }
SerialHub { mode: 'single'|'dual', sessions, activeSendId }
```

- v1 **硬顶 2 口**
- **BLU 分析仪口不进 Hub**（`blu-power.js` 独立）
- 每会话独立：open/close、read 循环、分包缓冲、`timeOut` 合并
- 发送只走 `activeSendId`（主发口）
- 同 `SerialPort` 不能挂两会话；选口冲突要提示

### UI

- 连接栏：`单路 | 双路` 切换
- 单路：现有 UI 基本不变（底层 Session A）
- 双路：
  - A/B 各自：选择串口、打开/关闭、标签（默认 TX / RX，可改）
  - 参数默认同步；分口波特可后做，v1 允许共用同一参数控件应用到两路 open
  - 主发口选择：A 或 B
  - 日志：**分栏**默认（左 A 右 B），列头着色 + 标签
  - 可选：合流时间线可做，非必须；有时间做再加

### serialApi 兼容（重要）

现有：

```js
serialApi.writeData(data)
serialApi.isOpen()
serialApi.onReceive(cb)  // 多订阅者
```

必须保持旧语义：

- `writeData` → activeSend
- `isOpen` → activeSend 可写
- `onReceive` → 默认只转发 **activeSend 的 RX**（或单路 A 的 RX；双路时文档化：默认 activeSend）

可扩展（按需）：

```js
serialApi.getMode()
serialApi.writeDataTo(id, data)
serialApi.onReceiveFrom(id, cb) // 或 onReceive(cb, {session})
serialApi.listSessions()
```

固件升级 / 随机读写 / 其它模块 **零改也能用**。

### 重连

现有 `connect/disconnect` 用全局 `serialPort = port` 会在双口串台。  
必须按 `e.port` **匹配 session** 再处理。  
`serialWantOpen` 改为 per-session（或 A/B 两个 key）。

### 明确不做

- 不做 3+ 口
- 不做功耗页双路日志
- 不把 BLU 并进 Hub
- 不做完整协议解析 per-panel 大重构（解析可仍跟主发口 / 焦点口；v1 跟 A 或 activeSend 的 RX 即可）

## 文件边界（避免与并行 track 冲突）

**允许改：**

- `js/common.js`（核心重构）
- `index.html`：仅 `#view-serial` / `#serial-connect-bar` / 日志区结构
- `css/style.css`：串口双路相关样式（前缀 `.serial-dual-` 或 `#view-serial` 内）
- `js/version.js`：feat bump **MINOR**
- 必要时 `js/command-palette.js` 加切换双路命令

**禁止改：**

- `#view-blu` 区块、`js/blu-power.js`、`js/blu-*.js`
- 不要为功耗页加指令 sheet（另一 track）

## 实现策略建议

1. 先抽 `createSession` / Hub，单路路径走 A，保证打开/读/写/日志/重连与现网等价
2. 再加 dual UI + 第二 reader + 分栏日志
3. 回归：单路收发、HEX/TEXT、协议下发、快捷发送、循环发送、刷新 wantOpen 重连

若 common.js 过大难一次抽干净：**允许** 用「主会话 + 可选第二 monitor 会话」渐进，但 API 对外仍清晰，且 dual 下两路可读。

## 版本与提交

1. bump `js/version.js` MINOR
2. commit：`feat: dual serial RX monitor for TX/RX sniffer`
3. 不要 push

## 汇报

写到 `.herdr-task/REPORT.md`：

- 架构落地方式（文件:函数）
- 单路兼容如何保证
- 双路如何操作
- 已知限制 / 未做合流等
- 手动验证清单

写完终端只回 REPORT 路径。

## 编码风格

原生 JS；`let`/`const`、单引号、无分号、Tab 缩进。见 `AGENTS.md`。

## 核实清单（先读再写）

给出 `文件:行号`：

1. `serialPort` / `openSerial` / `closeSerial` / `readData` / `writeData` 单例边界
2. `window.serialApi` 当前形状
3. connect/disconnect 监听是否写死全局 port
4. 日志 DOM `#serial-logs` 与 addLog 路径
5. 连接栏 HTML 结构
