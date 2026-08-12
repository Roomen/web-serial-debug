# 串口双路监控实现汇报

## 端口重命名（追加需求）

### 实现

- `getPortIdentityKey(port)`（`js/common.js`）：读取 `port.getInfo()` 的 VID/PID/SN；无 SN 时通过 `navigator.usb.getDevices()` 按相同 VID/PID 匹配已授权 USB 设备取 serialNumber（不写死任何 VID/PID）。Key 格式 `usb:VID:PID:sn:SN` 或 `usb:VID:PID`，两者皆无返回 null。结果缓存于 `_portIdentityCache`（Map，port 对象 → key）。
- 持久存储：localStorage `serialPortAliases` = `{ [identityKey]: displayName }`，名称 trim + 上限 32 字符，空名删除别名。
- 无 identity 回退：`_sessionAliasByPort` 内存 Map，`setPortAlias` 写内存并 toast「设备无持久标识，别名仅本次会话有效」；`getPortDisplayName` 读取顺序：持久别名 → 内存别名 → 默认 VID:PID。
- UI 入口：单路/双路状态区设备名旁铅笔按钮（`.port-rename-btn`），点击 `prompt` 改名/留空清名；选口或连接后状态区显示「设备名 + 铅笔」，未连接但已选口同样显示（圆点颜色表达连接态）。
- 显示位置：状态区、选择串口按钮文案（双路为「会话标签 · 设备名」）、连接/断开日志均走 `getPortDisplayName`。
- 会话标签（TX/RX）与设备别名完全独立：标签存 sessionStorage（`serialSessionLabelA/B`），别名绑设备存 localStorage，互不干扰。

### 验收要点

1. 给某口命名 → 刷新 → 重新选同设备 → 状态显示自定义名
2. 双路 A/B 各自命名互不覆盖（不同 identity key）
3. 清空名称恢复默认
4. 无 identity（非 USB 设备）时 toast 提示且不写坏 localStorage

---

## 架构落地方式

### 数据模型

```
SerialHub {
  mode: 'single' | 'dual',
  sessions: implied (A uses globals, B uses sessionB object),
  activeSendId: 'A' | 'B'
}

sessionB {
  port, open, manualClose, opening, reader, wakeLock,
  packBuf, packStartTime, packTimer, sekWaitStart, label
}
```

- Session A **复用现有全局变量**（`serialPort`, `serialOpen`, `serialClose`, `serialOpening`, `reader`, `serialData`, `serialDataStartTime`, `serialTimer`, `serialSekWaitStart`, `wakeLockSentinel`），确保单路模式零行为变更。
- Session B 独立为 `sessionB` 对象，仅在双路模式下激活。
- `SerialHub` 提供 getter/setter 方法按 `sid`（'A'|'B'）分发到底层变量，所有核心函数通过 Hub 访问会话状态。

### 文件变更清单

| 文件 | 行数变动 | 说明 |
|---|---|---|
| `js/common.js` | +867/-184 | 核心重构：SerialHub + sessionB + 双路 UI |
| `index.html` | +82 | 模式切换、双路会话控件、分栏日志 DOM |
| `css/style.css` | +229 | 双路连接栏、分栏面板、标签样式 |
| `js/version.js` | 1 行 | 1.27.1 → 1.28.0 (MINOR bump) |
| `js/command-palette.js` | +14 | 切换单路/双路命令 |

### 关键函数签名变更

| 函数 | 变更 |
|---|---|
| `openSerial(sid)` | 新增 `sid` 参数，默认 `'A'` |
| `closeSerial(sid)` | 新增 `sid` 参数 |
| `readData(sid)` | 新增 `sid` 参数，读循环通过 Hub 获取 port/reader |
| `writeData(data, sid)` | 新增 `sid` 参数，默认走 `activeSendSid()` |
| `dataReceived(data, sid)` | 新增 `sid` 参数，分包缓冲 per-session |
| `flushSerialPack(buf, startTime, sid)` | 新增 `sid` 参数 |
| `addLog(data, isReceive, atTime, sid)` | 新增 `sid` 参数，路由到正确日志容器 |
| `addLogErr(msg)` | 双路时同时写入 A/B 两个日志容器 |
| `serialStatuChange(statu, sid)` | 新增 `sid` 参数 |
| `updateOpenButton(sid)` | 新增函数，按模式和 sid 更新按钮文案 |
| `handleToggleClick(sid)` | 新增函数，处理打开/关闭（含端口冲突检测） |
| `selectPortFor(sid)` | 新增函数，会话感知的端口选择 |
| `setSerialWantOpen(want, sid)` | 新增 `sid` 参数，双键存储 |
| `getSerialWantOpen(sid)` | 新增 `sid` 参数 |

## 单路兼容如何保证

- Session A 的状态仍使用原有的全局变量名（`serialPort`, `serialOpen` 等），只是通过 `SerialHub.getPort('A')` / `SerialHub.setOpen('A', v)` 间接访问。
- `openSerial()` 等函数 `sid` 参数默认 `'A'`，不传参行为与旧代码一致。
- `serialApi.writeData()` / `serialApi.isOpen()` / `serialApi.onReceive()` 默认走 `activeSendSid()`，单路模式返回 `'A'`，语义不变。
- 页面加载时若 `sessionStorage` 无 `serialHubMode`，默认停留在单路模式，UI 与旧版完全相同。
- connect/disconnect 事件按 `e.port` 对象匹配会话，单路时只匹配 A。
- `serialWantOpen` 单路时只使用原有 key `serialWantOpen`，刷新自动重连逻辑不变。
- 固件升级 / 协议解析 / 快捷发送等模块通过 `window.serialApi` 零改动。

## 双路操作方式

1. **切换到双路**：点击连接栏 `[单路|双路]` 切换按钮中的「双路」（或 Cmd/Ctrl+K → "切换串口模式"）。
2. **选择串口**：分别为会话 A（默认标签 TX）和会话 B（默认标签 RX）点击「选择A」「选择B」授权串口设备。
3. **打开会话**：分别点击「打开A」「打开B」。同一 `SerialPort` 对象不能同时挂两路，冲突时会提示。
4. **查看日志**：左右分栏显示 A/B 会话的收发日志，列头带颜色标记（A=绿色, B=蓝色）。可独立滚动。
5. **发送数据**：发送区共用，通过「主发」下拉选择向 A 还是 B 发送。
6. **修改标签**：点击 A/B 标签输入框修改（默认 TX/RX），日志面板标题同步更新。
7. **参数修改**：双路参数共用，点击参数摘要按钮触发单路参数浮层（浮层位置略偏但功能正常）。
8. **切换回单路**：点击「单路」按钮，自动关闭会话 B。
9. **刷新恢复**：双路模式下刷新页面，若两路都有 `wantOpen` 标记且 `getPorts()` 返回 ≥2 个设备，自动恢复两路连接。

## 已知限制

- **参数浮层**：双路参数按钮触发的是单路参数浮层，position 可能不贴合按钮（共享 dropdown，功能正常）。
- **无合流时间线**：v1 未实现双路日志合流视图。
- **Session B 首次刷新不自动重连设备匹配**：若先前只打开了 A，刷新后切换双路需要手动重新选 B（port 对象无法序列化，`getPorts()` 顺序不可靠）。
- **波特率分口**：v1 两路共用同一套参数控件，无法单独设波特率。
- **字节统计**：双路面板列头预留了 `dual-log-panel-stats` 元素，v1 未填充。
- **3+ 口不支持**：硬顶 2 口。
- **BLU 功耗页不进 Hub**：`blu-power.js` 保持独立。
- **selectedLogRow 全局单一**：双路时点击 A 面板日志行会取消 B 面板的高亮（共享一个解析面板）。

## 手动验证清单

### 单路回归（核心）
- [ ] 选择串口 → 打开 → 收发数据正常（HEX/TEXT/ANSI）
- [ ] 快捷发送：单击发送、双击改名、分组增删改
- [ ] HEX 发送 / TEXT 发送 / 末尾加 CRLF
- [ ] 循环发送 + 间隔修改
- [ ] 日志类型切换（HEX和Text / HEX / TEXT / ANSI）
- [ ] 清空 / 复制 / 导出日志
- [ ] 修改串口参数（波特率等），已打开时自动重连
- [ ] 分包超时 / 最大行数裁剪
- [ ] 协议解析（SEK 实时解析 / 悬停提示）
- [ ] 协议下发（生成 HEX / 下发）
- [ ] 固件升级
- [ ] 导入 / 导出配置 / 重置参数
- [ ] 关闭串口 → 再次打开
- [ ] 设备拔出 → 自动提示断线 → 插入自动重连
- [ ] 刷新页面 → 自动重连（wantOpen）
- [ ] 命令面板 (Cmd+K) 各命令正常
- [ ] 右栏折叠/拖拽宽度 / 解析面板拖高度
- [ ] 发送面板折叠展开
- [ ] 点击日志行 → 协议 HEX 输入解析

### 双路功能
- [ ] 点击「双路」切换 → A/B 会话行出现
- [ ] A/B 标签默认 TX/RX，可编辑，日志面板标题同步
- [ ] 分别选择两个不同串口设备
- [ ] 分别打开 A 和 B
- [ ] 选择同一设备打开第二路 → 端口冲突提示
- [ ] A/B 各自收发，日志分栏显示（左 A 右 B）
- [ ] 发送数据走主发口（切换主发下拉验证）
- [ ] 系统日志（addLogErr）同时出现在两栏
- [ ] 点击双路日志行 → 解析面板更新
- [ ] 悬停 HEX 字节提示正常
- [ ] 清空按钮清空当前主发口日志（双路时也清 B）
- [ ] 复制 / 导出日志
- [ ] 切换回单路 → B 自动关闭，UI 恢复原样
- [ ] 双路时修改参数 → 两路同时重连
- [ ] 设备拔出 → 匹配对应会话提示断线
- [ ] 命令面板「切换串口模式」可用
- [ ] 刷新页面后双路模式恢复
- [ ] 暗色模式正常
