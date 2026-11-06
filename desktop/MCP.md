# 本地 MCP 服务（桌面客户端）

桌面客户端可以把**当前窗口里已经连好的串口与功耗仪**按需暴露给本机 agent（Claude Code、Codex 等支持 MCP Streamable HTTP 的客户端）。
服务默认关闭，只监听回环地址，需要 Bearer 令牌；网页版与移动端没有这个服务，也没有任何入口或监听。

```
配置（左栏）→ 本地 MCP 服务…
```

## 安全模型

- **只绑 `127.0.0.1`**，端口固定（默认 `38991`，可在服务停止时修改）。绑定失败会如实报错，**不会**自动换端口。
- **Bearer 令牌**：32 字节随机数（64 位十六进制），存在应用数据目录的 `mcp-service.json`，文件从创建起就是 `0600`、原子替换；不在 `localStorage`、不写日志、不进 URL。
  只有用户主动显示或复制接入信息时才会取回；复制完整配置不需要先显示令牌，也不会把令牌显示在面板上。关面板后丢弃迟到的读取结果。
- **Host / Origin 校验**：只接受 `127.0.0.1:<端口>` 与 `localhost:<端口>`；带 `Origin` 头的请求（浏览器页面）一律 403。
- **登录门控**：启用与每一次工具调用都要求该窗口已登录（与页面登录遮罩同一判据）。MCP 不提供登录，也不接触账号信息；窗口未登录时返回 `window_locked`。
- **没有** shell / 文件 / 脚本 / eval 类工具；工具只读写串口与功耗仪，返回内容有上限，不返回序列号、完整设备路径或页面设置。
- 升级准备期间（应用更新）拒绝所有设备操作；服务停止、窗口刷新、令牌更换都会让在飞请求立刻作废。

## 启用与配置

1. 打开任意桌面窗口并登录。
2. 左栏独立「MCP」入口 →「启用服务」。端口默认显示 38991，可在服务停止时修改。入口状态点：绿色为运行中，黄色为等待启动，红色为异常，灰色为停用。
3. 点「一键复制给 Agent」，直接粘贴给本机 Agent，即包含接入说明、有效令牌、完整配置与工具使用方式。无需另点「显示令牌」或手动替换占位符。
4. 也可点「复制配置」获取完整 MCP 客户端 JSON，或点「复制命令」获取 Claude Code 命令；两者均自动带上有效令牌。复制入口仅在服务运行时可用，不会自动启用服务。

```bash
claude mcp add --transport http serial-debug http://127.0.0.1:38991/mcp \
  --header "Authorization: Bearer <令牌>"
```

```json
{
  "mcpServers": {
    "serial-debug": {
      "type": "http",
      "url": "http://127.0.0.1:38991/mcp",
      "headers": { "Authorization": "Bearer <令牌>" }
    }
  }
}
```

- 「启用」是持久偏好：下次启动应用后，等应用初始化、且至少有一个已登录的桌面窗口注册桥之后才会开始监听；面板会显示「已启用，等登录后自动启动」。
- 「停用服务」会立刻停止监听并作废在飞请求。已启用但未运行时可以点「启动」重试；绑定失败会在面板上显示具体原因。
- 「重新生成…」需要再点一次「确认重新生成」；旧令牌立即失效（401），已复制的客户端配置需要更新。
- 每个工具都必须显式指定窗口（`windows_list` 列出的 `window` 标签）。多开时不同窗口是不同设备上下文，不要假设「当前窗口」。

## 工具

| 工具 | 参数 | 结果要点 | 主要错误 |
| --- | --- | --- | --- |
| `windows_list` | – | 已加载桥的窗口：`window`、`mode`(single/dual)、`lanes`、`authed`、`appVersion`。不返回窗口标题 | – |
| `serial_state` | `window` | 每路：设备（口名/产品名/别名/VID:PID）、是否打开、协议、收发字节、是否被事务钉扎、后台任务 | `unknown_window` `window_locked` |
| `serial_open` | `window`, `lane` | 打开该路**已选**的设备 | `lane_not_visible` `no_device_selected` `lane_busy` `transaction_pinned` `app_busy` `update_preparing` `open_failed` |
| `serial_close` | `window`, `lane` | 关闭该路；已关闭时 `changed=false` | `lane_not_visible` `lane_busy` `transaction_pinned` `update_preparing` `close_failed` |
| `serial_write` | `window`, `lane`, `data`, `encoding`(hex/text), `appendCrlf` | 写入字节数、该路累计发送字节 | `lane_not_visible` `serial_not_open` `transaction_pinned` `update_preparing` `bad_hex` `payload_too_large` `write_failed` |
| `serial_read` | `window`, `lane`, `cursor?`, `maxBytes?`, `timeoutMs?` | `data`(hex)、`nextCursor`、`generation`、`dropped`、`timedOut` | `lane_not_visible` `invalid_cursor` `bad_params` |
| `serial_ports_list` | `window` | 当前在位的串口：`canEnumerate`、`ports[]`（`deviceId`、口名/产品名/别名、VID:PID、`sn`、`slot`、`persistent`/`excluded`、被哪几路占用 `selectedBy`）。只列口，不授权、不打开 | `unknown_window` `window_locked` |
| `serial_select` | `window`, `lane`, `deviceId` 或 `sn`（二选一） | 为该路**选口**（不打开，选完调 `serial_open`）；返回该路与设备摘要 | `bad_params` `stale_device_id` `device_not_found` `ambiguous_device` `lane_not_visible` `lane_busy` `lane_blocked` `lane_moving` `lane_changed` `transaction_pinned` `unsupported_port` `close_failed` `select_failed` `aborted` |
| `serial_configure` | `window`, `lane`, `options?` | 省略 `options` = 读该路生效参数与摘要；给 `options`（`baudRate`/`dataBits`/`stopBits`/`parity`/`bufferSize`/`flowControl` 任意子集、至少一项）= 写并落盘，该路已打开时按新参数重连 | `bad_params` `invalid_options` `lane_not_visible` `lane_busy` `lane_moving` `lane_changed` `transaction_pinned` `reopen_failed` `aborted` |
| `blu_state` | `window` | 连接/采样、源电压、记录模式、样点数、DUT 供电状态与来源 | `blu_unavailable` |
| `blu_set_power` | `window`, `on` | 幂等设置 DUT 供电；只对「上次命令」的状态跳过 | `blu_not_connected` `blu_busy` `voltage_unknown` `voltage_write_failed` `power_write_failed` |
| `blu_set_voltage` | `window`, `millivolts` | 请求值 / 实际生效值 / 是否被夹取；越界拒绝（500..5000） | `blu_not_connected` `blu_busy` `out_of_range` `voltage_write_failed` |
| `blu_capture_start` | `window` | 开始采样（需要已知源电压） | `blu_not_connected` `voltage_unknown` `capture_start_failed` |
| `blu_capture_stop` | `window` | 停止采样；STOP 写失败时说明设备可能仍在采样 | `blu_not_connected` `stop_write_failed` |
| `blu_capture_summary` | `window` | 保留/总样点数、时间跨度、电流 avg/min/max(µA)、电荷(µC)、积分能量(µWh) | `blu_not_connected`（空数据时 `ready:false` + `reason`） |

### 结果语义（不要过度解读）

- `serial_write` 成功只表示**本机写入完成**，设备是否处理、是否应答由协议决定，工具不替你判断。
- DUT 供电状态没有硬件回读：`powered.source` 为 `commanded`（刚下发成功）、`probed`（连接时按电流实测）或 `unknown`。写入失败时状态会变成 `unknown`，不会谎称「已上电/已下电」。
- `blu_set_voltage` 只有设备写入成功才把请求值当作已生效；失败时 `appliedMv` 仍是上一次有效值。
- `blu_capture_summary` 的单位与口径：波形模式用存储的块级累加（`energySource: stored_chunk_sums`），样点被淘汰时 `span: retained`；长期模式只积分电流，`energyUWh` 为 `null`（不拿当前电压去凑历史能量）。抓取期间改过电压会置 `voltageChangedDuringCapture`。
- `serial_read` 的游标包含文档、路与连接代次：换设备、重连、切模式、刷新页面之后旧游标一律 `invalid_cursor`，不会把另一台设备的数据当成这一路的。环满时丢最早的数据并报 `dropped`。
- `serial_ports_list` 的 `deviceId` 是不透明标识：只标识「该窗口当前文档里在位的这个口」，带文档代次命名空间、不含参数。同一文档里口被拔掉后旧 id 不再命中、报 `device_not_found`；文档代次不匹配（窗口刷新 / 重载之后，含重插前留下的旧 id）才报 `stale_device_id`（不会悄悄落到另一台设备上）；跨重连引用同一台设备用 `sn`，或重新列口。提交后选口前会重新枚举，`deviceId` / `sn` 都命中零台报 `device_not_found`、多台报 `ambiguous_device`（附候选），绝不自动猜。
- `serial_select` 只选口不打开；取消时报 `aborted`，已执行到一半时带 `executed: "partial"`。
- `serial_configure` 写参数先落盘、后（该路已打开时）按新参数重连：参数已保存但重连没成功报 `reopen_failed` 且 `executed: "partial"`，此时新参数已生效于下次打开，不要当成「什么都没发生」再写一遍；逐项不合法报 `invalid_options` 并给出 `invalid` 字段清单，未知键与空 `options` 报 `bad_params`。

### 超时与「是否执行过」

工具调用有截止时间（默认 20 s；`serial_read` 为 `timeoutMs + 3 s`）。页面在真正动设备之前会向宿主提交（commit），因此超时能区分：

| code | 含义 |
| --- | --- |
| `expired_before_commit` | 已超时，**操作未执行**（可以安全重试） |
| `unknown_after_commit` | 已超时，但操作已经开始，**结果未知**（不要盲目重试） |
| `aborted` | 被取消（停用服务、窗口刷新、令牌更换等），未执行或后续步骤未执行 |
| `lane_busy` | 这一路的 MCP 操作已经排满（最多 4 条，含正在执行的那条）。前一条卡住时新的请求直接拒绝，不会堆积 |
| `lane_changed` | 排队等待期间这一路的端口 / 模式 / 连接代次被外部改变，本次操作取消未执行 |

串口打开也会在等待旧口释放、退避重试和 `open` 本身的过程中复查取消：请求在这期间被取消时，已经打开的口会被释放，不会出现「请求已超时但串口还开着」。

## 生命周期

- 启用偏好、端口、令牌保存在应用数据目录的 `mcp-service.json`（`0600`）；仓库与页面存储里没有令牌。
- 服务停止 / 停用 / 令牌更换 / 窗口刷新 / 窗口销毁 / 应用升级准备：在飞请求立刻收到终态，页面在下一次 `await` 边界停止，不会在超时之后又悄悄执行。
- 退出应用即停止监听。

### 租约契约（`desktop/src-tauri/src/lease.rs`）

进程内共享的 owner / lease / generation / release 契约，串口、MCP 与后续 RTT / BLE 后端复用同一套基元：

- **owner** = 窗口标签 + 文档代次（MCP 侧即 `bridgeEpoch`）。**generation** = 连接 / 服务代次：页面加载（`serial_release_owned`）、窗口销毁、升级收尾都会推进 owner 代次，服务停止 / 换令牌推进 pending 代次；跨代次的在飞调用不能登记新资源，迟到的回执也被丢弃。
- **设备租约**：同一物理串口同时只归一个 owner，「正在打开」也算占用，在 `serial_open` 触碰硬件前裁决（不依赖操作系统独占）：本窗口另一路占用报「该串口已被本窗口另一路占用」，另一窗口占用报「该串口正被另一窗口占用」。MCP 的 `serial_select` → `serial_open` 同样经这层裁决，不能跨窗口抢口；列口的 `open` 标记包含打开途中与别窗占用。任何在效的占用守卫都会拦住新占用，直到旧打开的 reader 与 writer 都真正释放，同 owner 的旧占用同样不能被顶替；旧代次的打开仍会在它的登记屏障失败。
- **两层 release 不混**：MCP 请求租约释放（停服 / 换令牌 / 刷新 / 销毁 / 升级冻结）只给在飞请求判终态，**不关闭**窗口已打开的串口；窗口 owner 的物理释放只收回本窗口的串口句柄与设备占用，不动别窗的连接。

## 排错

| 现象 | 原因 |
| --- | --- |
| 面板显示「端口 38991 绑定失败(可能已被占用)」 | 端口被其它进程占用；停用后改端口或先释放占用。不会自动换端口 |
| 客户端 401 | 令牌不对（重新生成后没更新配置） |
| 客户端 403 | 请求带了 `Origin` 头（浏览器页面调用），或 Host 不是 `127.0.0.1` / `localhost` |
| 405 | 用了 GET/DELETE；本服务只支持 POST（无会话的 JSON 响应） |
| `window_locked` | 该窗口没登录（登录遮罩还在） |
| `transaction_pinned` | 该路正在跑协议事务（固件升级、批量配置、STS 模拟等），先结束事务 |

## 离线测试与限制

- Rust 侧：`cd desktop/src-tauri && cargo test`（`mcp::*` 覆盖鉴权、Host/Origin、405、请求体上限、工具列表、提交/取消/超时分类、注册代次与生命周期、选口/参数工具的二选一与 schema 边界；其中一个用例用 `rmcp` 官方客户端对真实 router 做协议互通，全部使用假窗口桥，不需要 GUI、串口或硬件）。
- 页面侧：`node tests/mcp-ring.cjs`、`node tests/mcp-bridge.cjs`、`node tests/mcp-service.cjs`；功耗仪上下电 / 电压 / 采样启停另由 `node tests/blu-control.cjs` 直接跑生产函数（假 DOM + 假设备，不连设备）。
- 本任务的验证全部离线：只用假窗口桥、假串口与合成数据，**没有**连接、枚举或操作任何真实设备，也不要求这样做。
  真机行为（真实选口、收发时序、上下电、采样）不在本次验证范围内，未经实机确认；需要时由有设备的人按仓库既有规则单独验证。
- 争用边界：MCP 操作按「窗口 × 路」串行，窗口 / 文档代次失效会作废在飞请求；同一物理设备被多个窗口引用时由 `lease.rs` 的设备租约在进程内裁决（见上节），另一个**应用**占用同一设备仍按操作系统占用如实报错。
- 构建要求：`rmcp` 需要 Rust ≥ 1.88（本仓库工具链 1.97）。Windows 与 macOS 都只用纯 Rust 依赖（HTTP 部分为 `axum`/`tokio`，测试里的 `reqwest` 不进入应用二进制）。
