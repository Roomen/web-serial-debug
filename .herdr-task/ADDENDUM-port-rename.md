# 追加需求：串口设备重命名（持久化）

与「会话标签 TX/RX」**不同**：这是 **物理串口设备** 的昵称，按设备标识符存 localStorage，下次选中/重连同一设备时自动显示。

## 标识符（port identity key）

实现 `getPortIdentityKey(port) → string | null`：

1. `info = port.getInfo()`
2. 优先序列号：`info.serialNumber` 或 `info.usbSerialNumber`（若有）
3. 可选增强：若 `navigator.usb.getDevices` 可用，按 **相同 usbVendorId + usbProductId** 匹配已授权 USB 设备的 `serialNumber`（参考 `blu-power.js` 的 `getPortSn` / WebUSB 思路，但 **不要** 写死 BLU 的 VID/PID，对任意 USB 串口都尝试）
4. Key 格式建议：
   - 有 SN：`usb:VID:PID:sn:SN`（VID/PID 用 4 位小写 hex）
   - 仅 VID/PID：`usb:VID:PID`（弱标识；同型号多设备会撞名，UI 上可提示「无序列号，仅按型号记忆」）
   - 两者皆无：`null` —— 仍允许本次重命名，但只保存在 session 内存，并 toast/日志提示「无法持久化」

## 存储

```js
// localStorage key: serialPortAliases
// value: { [identityKey]: displayName }
{
  "usb:1a86:7523:sn:ABC123": "模组-TX嗅探",
  "usb:1a86:7523": "CH340-备用"
}
```

- 名称 trim，长度上限 24（或 32）
- 空名 = 删除别名，恢复默认显示
- 提供 `getPortDisplayName(port)`：有别名用别名，否则回退 `serialPortLabel` 默认（Vendor/Product 或「串口设备」）

## UI（单路 + 双路都要）

1. 连接栏状态区或端口按钮旁增加 **重命名** 入口（小按钮 `bi-pencil` 或状态文字可点）
2. 交互：点重命名 → `prompt` 或小型 inline input（二选一，inline 更好但不强求）→ 保存
3. 显示位置统一走 `getPortDisplayName`：
   - `#serial-status` / dual 状态文字
   - 选择串口按钮文案（若当前显示设备名）
   - 连接/断开日志：`设备已连接 (模组-TX嗅探)` 而不是只写 VID:PID
   - 双路 A/B 的端口按钮或状态：显示「TX · 模组-TX嗅探」= 会话标签 + 设备名
4. 可选：右键或长按清名——v1 不强制

## 与会话标签关系

| 概念 | 存什么 | 生命周期 |
| --- | --- | --- |
| 会话标签 A/B（TX/RX） | 日志栏角色 | 用户配置，与物理口无关 |
| **设备别名（本需求）** | 某 USB 串口身份 | 换会话/刷新仍在，绑设备 |

两套并存，不要混在一个字段里。

## 实现位置

继续在本分支 `feat/serial-dual-monitor` 完成（同一 commit 或追加 commit 均可）：

- `js/common.js`：identity / alias store / display name / rename UI 事件
- `index.html`：重命名按钮（单路 + 双路 A/B）
- `css/style.css`：按钮样式
- 版本：若尚未 bump MINOR 则一次 bump；若已 bump 本 feat，可只 PATCH 或保持同一 MINOR commit

## 验收

1. 给某口命名 → 刷新页面 → 再选中同设备（getPorts 授权列表）→ 状态显示自定义名
2. 双路 A/B 各自命名互不覆盖（不同 identity）
3. 清空名称后恢复默认
4. 无 identity 时提示且不写坏 localStorage

完成后更新 `.herdr-task/REPORT.md` 追加本节说明，本地 commit。
