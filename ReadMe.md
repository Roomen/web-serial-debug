# Web Serial Debug

浏览器串口调试工具（基于 [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)）。

## 浏览器支持

Web Serial API 目前仅桌面端 Chromium 内核浏览器支持：

| 浏览器 | 最低版本 | 备注 |
|--------|---------|------|
| Chrome (桌面) | 89+ | ✅ 推荐 |
| Edge (桌面) | 89+ | ✅ 推荐 |
| Opera (桌面) | 75+ | ✅ |
| Brave / Vivaldi / 其他 Chromium 桌面版 | 89+ | ✅ 理论上兼容 |

**不支持：**
- ❌ **Android Chrome**（Google 暂未在移动端实现）
- ❌ **iOS 所有浏览器**（iOS 上 Chrome/Edge 等均强制使用 WebKit）
- ❌ Firefox（Mozilla 明确表示不会实现）
- ❌ Safari（WebKit 未实现）

> 使用前请确认在桌面端 Chrome/Edge 中打开本工具。

## 使用方法

1. 用本地静态服务或直接打开 `index.html`（部分能力在 `file://` 下受限，建议 `python3 -m http.server`）
2. 选择串口并设置波特率等参数，打开串口
3. 中间为收发日志；底部可发送 HEX / TEXT，支持循环发送
4. 右侧按需使用：设置、快捷发送、第三方协议、固件升级、固件打包

快捷键：`Ctrl/Cmd + K` 打开命令面板。

## 主要功能

- **串口连接**：参数可配、本地记忆；插拔自动重连
- **日志**：HEX / TEXT / HEX+TEXT / 彩色 ANSI；自动滚动；清空 / 复制 / 导出
- **发送**：HEX 或 TEXT、追加 CRLF、循环发送
- **快捷发送**：分组管理、导入导出
- **配置**：导入导出，便于迁移
- **主题**：亮色 / 暗色
- **协议解析（SEK）**
  - 实时解析收发帧、底部结构化解析面板
  - HEX 字节悬停字段提示
  - AES-ECB 加解密（ASCII / HEX 密钥）
  - 下行预设指令：参数设置 / 信息查询 / 指令操作
  - **随机读写测试**：真随机读/写/查询交错，seed 可复现；写后可恢复原值；结束输出失败 / 不支持 / 跳过报告（不含开猫、复位及表号/IP/时间等敏感项）
- **固件升级**：PCP 协议升级流程
- **固件打包**：差分 / 压缩等相关工具
- **STS 模拟**：经 hostProto 模组模拟表端或 CIU；双路可分别配置角色，支持 CIU + 表端或同时模拟两路表端

## STS 模拟

在工具停靠栏打开「STS 模拟」。单路模式使用通道 A；双路模式下分别连接 A/B 的 hostProto 模组（115200 8N1），再在面板中切换通道、配置角色并分别启动。两个通道的配置、运行状态、操作和日志相互独立，切换主发口不会改变模拟器的收发串口。不要让其他工具同时操作同一个串口，运行期间保持页面在前台。

刷新保留各通道的启动意图，待对应串口重连后自动重新启动；模组暂时无应答时以 5、10、20、30 秒退避重试。手动停止或取消等待／重试后不再自动启动，配置或认证错误需手动处理。重新启动使用配置初值，不恢复运行值、充值记录、阀门保持期或在飞事务。PAK 不保存，需要认证时重新输入并手动启动。

告警区默认展示已选告警的码和名称，展开「选择告警」可修改预置项或填写其他码；运行告警修改立即生效。日志最新在前，每个通道最多保留 500 条。

面板与协议回归（仅合成数据，无需串口）：

```bash
node tests/sts-sim-panel.cjs
node tests/hostproto-protocol.cjs
node tests/sts-sim.cjs
```

## 本地运行

```bash
# 无需安装依赖
open index.html
# 或
python3 -m http.server 8000
```

版本号见 `js/version.js` 的 `window.APP_VERSION`。

## 开源

欢迎通过 [Issues](https://github.com/Roomen/web-serial-debug/issues) 反馈问题与建议，也欢迎 PR。

本仓库：https://github.com/Roomen/web-serial-debug  

上游参考：https://github.com/itldg/web-serial-debug
