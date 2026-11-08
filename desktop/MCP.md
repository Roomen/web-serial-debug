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

### USB BLE 桥（桌面 Windows / macOS）

BLE 桥复用本服务端点及确切窗口路由，串口固定 2 Mbps NDJSON，独立占用原生串口资源，不切换串口调试页的后端。

| 工具 | 参数（均需 window） | 完成语义 |
| --- | --- | --- |
| `ble_state` / `ble_ports` / `ble_devices` / `ble_gatt` / `ble_events` | 无其它参数 | 状态、桥候选、扫描列表、自动发现结果、有界事件日志 |
| `ble_open` / `ble_connect` | `deviceId` | 前者取自 ports；后者取自 devices，连接等 `conn` 事件 |
| `ble_close` / `ble_scan_start` / `ble_scan_stop` | 无其它参数 | 释放桥 / 扫描控制；扫描状态由事件更新 |
| `ble_disconnect` / `ble_pair` | `generation` | 等 disconnected / encrypted 异步事件 |
| `ble_read` | `generation`, `characteristicId` | 等 read value 事件 |
| `ble_write` | 上述两项 + `hex`, `response` | 1..512 字节；有响应等 write 事件，无响应只报 accepted |
| `ble_subscribe` | `generation`, `characteristicId`, `on` | 校验 notify/indicate 与唯一 CCCD，命令受理不等于已收到通知 |
| `ble_passkey` | `generation`, `passkey` | 只回答正在进行的挑战（比较用 0/1，输入 0..999999）；不记录密钥 |

所有写工具与 UI 走同一有界队列，MCP commit 在队列内 I/O 前执行。配对答复独立提交，避免被等待安全事件的配对请求阻塞。停 MCP 只作废请求，不关闭 UI 空闲连接；只有已经进入 I/O、取消后结果未知的请求才触发桥恢复释放。刷新/窗口销毁沿用原生 owner 生命周期，升级冻结后释放桥并等待完成，释放失败不确认升级。

资源上限：NDJSON 1 MiB（溢出丢至下一换行），16 pending、8 队列项、512 个扫描设备、256 个服务、1024 个特征、每特征 32 个描述符；日志 256 项且最多约 64 KiB，带 sequence / dropped。超时、写失败与关闭清理 pending。返回扫描 id 不含外设地址；状态/日志不含配对码。GATT id 绑定文档与连接代次，调用必须显式携带 generation。

**固件限制与恢复**：现有固件事件没有连接代次/事务 id。关闭重开 USB 串口、ping 成功都不能证明 BLE 会话已复位。工具只在当前接收通道观察到固件启动 `ready` 后允许一次连接；断线后下一次连接要求保持桥口打开并复位固件，再扫描、重新发现。`ready` 清空设备列表、扫描状态和所有 GATT 句柄。超时/取消的未知结果立即废弃当前状态，不自动重试。该策略依赖 `ready` 确实代表固件重启且固件按序清理旧事件；旧固件不提供端到端的事件代次证明，不能声称任意迟到事件下都有严格隔离。若桥复位导致 USB 重枚举且新通道收不到 ready，扫描可用，但连接会保持被禁止；可靠跨重连恢复需要固件增加会话 nonce/连接代次。

释放时尽力写 `scan.stop` 和 `disconnect`，随后关闭原生句柄。页面关闭/升级路径不能把这两次本地写入当作固件已停止扫描/断连的确认，下一次打开仍为未同步。

Profile 在页面保存规范化 UUID、属性、服务特征结构与描述符结构，不保存地址、ATT 句柄或实例序号。重新发现后必须唯一匹配，完全重复的服务/特征实例返回 `ambiguous_profile`、要求重新选择。TX 是主机写外设，RX 是主机接收通知。工具页将 Profile 接入通信调试主发路：`createProfilePort(profile)` 以现有 `createStreamPort` 包装，TX 按 chunkSize 串行分片（单次流写入最多 64 KiB），RX 通知进入有界可读流；同一桥只允许一个 Profile 端口，关闭端口取消订阅但保留桥连接。断连/复位使流失效，重新打开必须重新解析选择器。此端口不注册或切换全局 SerialAdapter 后端。电脑原生 BLE 同样经通信会话接入，见下节。

原生 `error` 与 `lost` 分开处理：可恢复读错误只清空 NDJSON 残帧并丢弃至下一换行，再继续解析；桥口、扫描会话及已发现设备保留。可能损坏的在飞应答不伪造成功，等待匹配应答或既定超时。只有 `lost` 立即走资源释放。原始驱动错误字符串不写进 BLE 日志。

### BLE 广播筛选

`ble_devices` 接受可选 `name` 与 `serviceUuid`：名称为忽略大小写的包含匹配，UUID 为 128-bit 精确匹配（标准连字符或 32 位十六进制），两项 AND，空白值不筛选；非法 UUID 返回 `invalid_filter`。返回的 `uuids` 是当前扫描实际收到的广播 / scan response 服务 UUID，规范化为小写完整 UUID，每设备最多 64 项。短 SIG 广播 UUID 扩展成完整 UUID；GATT 发现结果不参与。主机侧筛选不会向固件发送新增过滤字段。增量广播保留已知名称与 UUID，新扫描清空旧元数据；同名设备仍使用不同 opaque id。面板提供相同筛选与清除按钮。

### 原生 Classic SPP（Windows / macOS 客户端）

`classic` 平台服务，UI 在通信调试的选择连接来源入口使用，使用电脑自带蓝牙，和 USB BLE 桥、串口模式同时存在；不切换全局 SerialAdapter。网页、Linux 与移动端不提供服务入口。搜索只在系统窗口内显示可发现设备，应用保存用户选中的设备，不返回系统扫描到的全部列表。设备状态是最近系统选择时的配对快照。

| typed 工具 | 参数 / 行为 |
| --- | --- |
| `classic_state` | `window`，连接状态、generation、收到字节数 |
| `classic_devices` | `window`，当前文档系统选择结果，opaque deviceId / name / paired；不返回地址 |
| `classic_discover` | `window`，打开系统搜索/选择 UI，必须用户交互；不自动配对 |
| `classic_pair` | `window`，打开系统搜索/配对 UI；用户选择设备并输入 PIN 或核对比较码；没有自动接受认证回调 |
| `classic_connect` | `window, deviceId`，连接已配对设备的 SPP RFCOMM 服务；不要求先映射为 COM/cu |
| `classic_close` | `window`，关闭该窗口通道并使在途动作代次失效；超时不是已关闭，需重试 |
| `classic_read` | `window, cursor?`，最多 4096 字节 HEX、cursor、dropped、hasMore；游标含随机文档 namespace 和连接代次，1 MiB 环形上限 |
| `classic_write` | `window, generation, hex`，1..65536 字节，结果只表示本机传输接受，不代表对端业务应答 |

`discover/pair` 允许最多 120 秒交互；MCP 超时、取消或停服后仍可能有系统 UI，用户必须在系统窗口取消。配对副作用可能已发生，`unknown_after_commit` 不可自动重试。取消使应用 owner 代次失效，系统窗口返回的迟到结果不能登记到新会话。PIN/比较码仅由系统界面处理，不进入应用日志、MCP参数或存储。

所有打开、读线程、写入、物理关闭保有 owner 生命周期与设备独占凭据；刷新/销毁/升级回收超时后再次回收仍会等待真实物理结束，不能因句柄已从表中移走就报告空闲。MCP停服不会关闭无在途MCP请求的UI连接。当前每进程只允许一条 Classic 连接（含旧 MCP 与 UI 会话端口）；无法把用户另外建立的系统 COM/cu 映射与无线身份可靠关联，因此不宣称与独立串口路径之间也建立了统一物理身份仲裁。

macOS SDK 的 SDP 查询没有取消入口；同步 RFCOMM open/write 也没有本实现可设的超时或强制取消。系统调用未返回时，线程、delegate、设备凭据继续保留；回收等待 3 秒后报告忙/失败并拒绝升级，不能宣布已释放。SDP 回调完成后会先检查代次再继续打开，分片写入之间亦检查；已经进入的同步调用只能等待系统返回。通道 close 返回成功或收到真实 `rfcommChannelClosed` 后才结束物理释放；`isOpen == false`（也可能正在开关）或接收溢出不作为关闭证明。Windows连接等待最多15秒、写入最多10秒，轮询间检查代次；系统配对UI需用户关闭。

未进行真实外设扫描/配对/收发验收；本机 macOS 编译和离线合成测试不代表硬件兼容性已验收。Windows完整交叉构建需要可用 Windows SDK，本机缺相关 C 头文件；实际 Windows 后端已单独做目标平台类型检查。

应用更新在下载前及各窗口准备阶段均检查 BLE / Classic 服务：持续扫描、连接/配对/系统窗口、GATT 发现与操作、排队及在飞写入（含 Profile 整次分片写入）、初始回收、释放中或释放失败都会阻止更新。空闲连接和单纯等待通知不阻止更新，准备阶段冻结新操作后释放连接，释放成功才确认就绪。

### 统一通信会话与电脑 BLE

主视图显示为「通信调试」，工具名 `serial_*` 与 lane S/A/B 不变。在 UI 选择 SPP、电脑 BLE 或桥 Profile 后，`serial_read` / `serial_write`、日志、协议与固件升级都走所选会话。`serial_configure` 对无线端口读出 `transport`、`options:null`，修改返回 `unsupported_transport`。普通串口的参数与双路行为保留。

电脑 BLE 扫描与 GATT 选择需要 UI 交互，不新增自动扫描/配对 MCP 工具。按广播名查找，可选完整 128-bit 广播服务 UUID，两个条件 AND；连接后选择 TX（电脑 → 设备，write 或 writeWithoutResponse）与 RX（设备 → 电脑，notify 或 indicate），允许不同服务。确认映射并订阅 RX 成功后才接入会话。保存 UUID/属性，重连重新发现且必须唯一匹配；重复实例在当次连接需明确选择，不能靠存储实例编号猜测。无线凭据不跨页面刷新复用。

旧 `classic_*` 接口仍保留供兼容：`classic_state.laneOwned` 为 true 时表示 UI 的通信路持有 SPP，旧独立 connect/write/read 不接管这个 reader，请使用 `serial_*`。旧接口与 UI 连接共享进程级单 SPP 限制。桥高级 GATT 操作与旧 Classic 操作在通信事务钉扎期间拒绝；更新/窗口销毁的资源回收使用内部释放路径。

电脑 BLE 原生 OS 调用不可假定可立即中断；关闭超过 3 秒返回失败并继续占用，等待底层完成后可重试释放。收不到退订/关闭确认时不会宣称空闲或放行更新。WinRT/CoreBluetooth 的权限、保护特征配对与硬件断线恢复须在对应系统实测。
