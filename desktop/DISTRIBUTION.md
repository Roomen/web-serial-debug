# 客户端发布与更新

客户端版本只取 `js/version.js`。正式版从 `main` 发布、预览版从 `dev` 发布；其它分支的本地构建默认是 `dev`。本地可用 `RELEASE_CHANNEL=main|dev` 覆盖。通道在构建时写入网页资源，更新时不切换通道。

首次接入应用内更新需要手动安装包含 updater 且配置了公钥的发布版；此前客户端只有网页版本刷新检测，不能自行升级到这套机制。Windows 早期只有手动下载 ZIP，这些用户需要手动换一次带更新功能的便携包，之后即可应用内更新。

本地 `npm run build` 不要求更新签名。macOS 设置 `TAURI_UPDATER_PUBLIC_KEY` 后客户端启用更新检查；同时设置 `TAURI_SIGNING_PRIVATE_KEY`（以及可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）才生成更新包和 `.sig`。没有公钥时构建不嵌入假的公钥、也不提供可安装的更新。公钥必须长期保持一致；轮换需另行设计迁移，不能直接替换已有客户端信任的公钥。

## GitHub 设置

先用 Tauri CLI 的 `signer generate` 创建独立更新签名密钥，并离线备份私钥。在 GitHub 仓库配置：

- Variable：`TAURI_UPDATER_PUBLIC_KEY`，内容为生成的公钥文件文本。
- Secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- macOS Secrets：`APPLE_CERTIFICATE`（P12 的 Base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`（公证专用密码）、`APPLE_TEAM_ID`。

私钥和 Apple 凭据不要提交仓库。正式版（`main`）要求更新签名配置齐全，缺少直接失败；两个通道缺 Apple 配置时都出整包 ad-hoc 签名的 macOS 包（`release-config.mjs` 的 `macSigningConfig`，首次打开在「隐私与安全性」点「仍要打开」；不要退回只有链接器签名的包，没有封存资源会被判「已损坏」，只能 `xattr -cr`），缺更新签名时只发布安装包、不生成更新清单，客户端不会收到这一版的应用内更新。

macOS 26+ 的液态玻璃用 AppKit 的 `NSGlassEffectView`（macOS 26 才有的类，客户端运行时判断，低版本与 Windows 保持不透明窗口，最低系统仍是 11.0），因此发行前提不变：仍只出 `.dmg`、走公证或 ad-hoc 签名，不上架 App Store（审核会拒新系统专属外观与这类私有 API，公证不检查这些）；构建机不需要 macOS 26，类名在运行时才解析。

Windows 便携 ZIP 同样使用这套公钥签名（`signer sign --app-version <版本>`，签名里带版本号，客户端开启 `requireSignedVersion`），但载荷由便携 helper 替换 EXE，不经过 Tauri 安装器。没有 `TAURI_UPDATER_PUBLIC_KEY` 时本地仍能构建并手动解压使用便携包，只是不生成 `.sig`、不进入清单。Windows Authenticode 代码签名尚需另行配置，现阶段运行程序可能出现系统信誉提示；应用内更新的完整性由更新签名保证，与 Authenticode 是两套独立机制。

## 发布流程

`dev` 分支上 `js/version.js` 有变化的推送（含 PR 合入）自动运行 `Desktop release`，发布预览版 `desktop-dev-v<version>`（GitHub 上标为 Pre-release）；版本号已发布过就跳过构建，所以不 bump 的推送不会出包。正式版先通过 PR 将版本提交合入 `main`，随即创建并推送 `desktop-main-v<version>` tag 触发构建，不以 main CI 完成为前置条件；tag 必须与 `js/version.js` 一致且指向 main HEAD。工作流也保留 `main` 上的手动入口，可填写更新说明，留空时预览版用触发提交的标题。工作流使用固定的 `ubuntu-24.04`、`macos-15` 与 `windows-2025` runner；macOS 14 已进入退役期，迁移至仍受支持的 macOS 15 ARM64。分别构建 macOS ARM64（Apple 芯片）与 Windows x64，不出 Intel Mac 版本；任何一项失败都不发布、不推进更新通道。

安装包及签名上传到草稿 `desktop-<channel>-v<version>`，完成后发布。该版本标签和资产按不可变发布管理，禁止替换；应递增版本重新发布。下载 URL 永远指向这个版本的资产。

通道清单发布在 `desktop-main/latest.json` 或 `desktop-dev/latest.json`。清单只包含 macOS ARM64 的更新包及匹配签名（Windows ZIP 不交给安装器更新器），且版本严格大于通道旧清单。验证通过且版本 release 发布后，最后才更新通道清单，客户端不会看到尚未发布的下载地址。已有通道先上传暂存清单并校验字节，再切换资产名；旧清单保留为备份，切换失败时尝试恢复。GitHub 不提供原子替换资产接口，名称切换期间可能短暂返回 404，应重试检查更新。工作流按分支串行执行，避免同通道发布竞态。首次发布如果通道清单不存在，创建通道 release；已有通道的读取失败会阻止发布。

预览版只保留最新 1 个 `desktop-dev-v<MAJOR>.<MINOR>.<PATCH>` 版本 release（含 tag），即只保留最新版预览包：整包版本发布成功、通道指针推进之后，工作流按 SemVer 数值排序删除更旧的预览版；通道指针 `desktop-dev`、`desktop-main*` 与本次刚发布的版本永不删除，版本已存在被跳过构建（`publish=false`）时不清理。清理失败（含个别删除失败）只 `::warning::` 告警，不影响已发布结果；release 列表取不到时跳过，不误删。

如发布在推进通道前失败，已有通道继续指向上一版。检查草稿/已发布版本与产物后人工处理失败版本，再重跑；流程不会静默覆盖同版本资产。

macOS 安装包只发布 `.dmg`，不再提供 `.app.zip`；应用内更新安装的 `.app.tar.gz` 只在配了更新签名时随版本发布。Windows 只发布 `Serial-Debug_<version>_windows_x64.zip`，不生成 NSIS / MSI 安装程序。`npm run build` 在 Windows 上自动跳过 Tauri bundler，先编译更新 helper（`desktop/portable-updater`，产物与主程序同在一个 target 目录），再把 `Serial Debug.exe`、`serial-debug-updater.exe` 与 `README.txt` 压成 ZIP，归档到 `desktop/release/<channel>/`；配了更新签名时另出 `<zip>.sig`。显式 `--no-bundle` 时只编译、不归档。ZIP 解压后运行 `Serial Debug.exe`，无需安装或管理员权限，不创建快捷方式与卸载项；`serial-debug-updater.exe` 必须与主程序放在同一文件夹。

运行环境为 Windows 10/11 和 Microsoft Edge WebView2 Evergreen Runtime（ZIP 不包含该运行时，缺少时需从 Microsoft 官网安装）。配置、授权和日志仍沿用当前用户应用数据目录，便于旧安装版迁移，不随 ZIP 移动。旧安装版用户需手动下载 ZIP 并退出旧程序；可卸载旧安装器版本后使用 ZIP。新版本不再向旧 Windows 安装版提供安装器更新，旧版检查更新可能报错，需手动前往下载页。

## Windows 便携版的应用内更新

Windows 与 macOS 共用同一套更新入口、通道清单、进度、全窗口空闲屏障、串口句柄释放与会话交接，区别只在最后一步怎么落地：

1. `js/app-update.js` / `js/native-shell.js` 调 `app_update_check`（tauri-plugin-updater，公钥与端点在构建时写入）。
2. 用户确认后 `app_update_install` 下载清单里的便携 ZIP；`Update::download` 内部先做一次签名校验，校验不过不会进入准备阶段。
3. 全部窗口确认空闲、会话写入交接文件、MCP 在飞请求作废、原生串口句柄收回后，Rust 端把已验签的 ZIP、`plan.json` 与 ZIP 里的 helper 写进应用数据目录下的 `update/<operation>/`（私有暂存），写 `update-in-progress.json` 标记，启动 helper 后 `app.exit(0)`。
4. helper 只收一个绝对路径参数（计划文件），自己再校验计划格式与路径、用编译期内嵌的公钥复核 ZIP 签名并要求签名的版本与计划一致，再按白名单从 ZIP 里取主程序与说明文件。
5. helper 用 ToolHelp 枚举「同一安装目录」的全部实例（按完整映像路径比对，不是只看名字），等它们退出（默认 60 s，最多 10 min）；查询失败按「还没退出」处理而不是当作没有实例。
6. 替换是「写新文件并回读核对 → 旧文件改名备份 → 新文件就位 → 再核对内容 → 删备份」。任一步失败都回滚，回滚失败会保留备份并把路径写进结果。主程序成功后还会一并替换 `README.txt` 与安装目录里的 `serial-debug-updater.exe`（运行中的是暂存目录那份，替换安全），这两项失败不影响已就位的新程序。
7. 替换结束写 `update-result.json`、删本次标记、清自己的暂存目录，启动程序（成功是新版，失败是回滚后的旧版）。新版启动时 `js/app-update.js` 读出失败原因并提示，用户可以重试。
8. 没有拿到锁的 helper（同时有两次更新、或上次 helper 还没结束）**什么都不做**：不写结果、不动别人的标记、不启动程序——否则它启动的实例会占住正在等实例退出的那次替换，把一次本可成功的更新逼成超时回滚。此时由拿到锁的那个 helper 负责重启。

会话恢复的范围：交接文件只包含**发起更新那个进程的窗口**。同机另一个实例（共用同一个应用数据目录）如果在 helper 等待期间也退出了，它的窗口会话不会进交接文件，更新后不会自动恢复；它下次打开时按常规启动逻辑处理（刷新前的重连意图仍走本实例的 sessionStorage，进程已退出则没有）。

并发与竞争：`update/lock` 是互斥锁（30 s 等待，崩溃残留超过 15 min 才可回收），同一时刻只有一个 helper 在替换；更新进行中另起的实例在启动阶段读到标记就提示并退出，不会去清正在使用的暂存目录或锁；暂存清理只删「名字是本工具的操作 id、且目录本身」的项，锁文件、`update` 根目录与其它文件都不动。更新失败保存的是「文件替换失败」这一层：新版程序自身崩溃不会被自动回滚，只是不再提示成功。

回滚与残留：`<主程序名>.old-<operation>` 是备份，正常结束即删除；主程序、`README.txt`、`serial-debug-updater.exe` 的 `.new-*` 半成品只在主程序仍存在时于下次启动前清理；主程序不存在时任何副本都保留，避免删掉唯一可运行的旧程序。`.old-*` 不属于本轮、无法确认那次更新成功过，所以一律不主动删。

回滚承诺的范围只有「文件替换」：helper 在**新程序已就位之后、结果文件写出之前**被强杀、遭遇 OOM 或断电时，磁盘上留的是新版且没有 `update-result.json`，下次启动不会显示任何更新结果（标记会因 helper 进程已死而被清掉，`<exe>.old-<operation>` 备份保留可手工恢复）。新版程序自身崩溃、运行期逻辑错误都不会被检测或自动回滚。内存峰值约为「载荷 + 主程序 + 两份回读副本」，正常包远低于上限。

需在 Windows 实机验证：ZIP 解压启动、WebView2 缺失提示、串口功能、应用内更新（成功 / 签名错误 / 程序占用 / 回滚 / 多窗口同时运行 / 带空格与中文的安装路径）后的配置与会话保留。

## 原生接收资源边界

串口读线程按最多 64 KiB 合批，目标等待 10 ms（底层一次空闲读取另受 20 ms 超时约束）。每个已打开句柄有独立的 256 KiB IPC 在飞窗口；页面将数据交给适配层的有界流后，以 `serial_ack_receive` 确认累计字节。确认绑定发起窗口与句柄代次，重复、乱序确认不会多返还额度。窗口满时明确报告接收溢出并停止连接，不继续排队；用户需重新打开设备。终端另有 1 MiB 待解析预算，超过时报告丢弃字节数。

实例认领优先使用 Web Locks，并在 bfcache 返回时重新认领。旧版原生 WebView 不支持 Web Locks 时，使用壳注入的进程与窗口键区分复制状态和同窗口刷新；应用升级交接由壳显式标记，保留重连意图。没有跨文档互斥能力的旧浏览器保守放弃继承的自动重连，仍可手动选口连接。

## 本地验证

```sh
node --test desktop/scripts/*.test.mjs
cd desktop
npm ci
npm run build
```

更新端到端验证需要两份不同版本、相同 updater 公钥的已签名安装包，以及真实可访问的 GitHub 清单。先在预览通道验证旧版升级、网络失败、签名错误与配置保留，再发布正式通道。Windows 实机验证在内网验证机进行；不可访问时记录为待验证，不声称已经通过。

Rust 侧的自动化验证（本机即可跑，不需要 Windows）：

```sh
cd desktop/portable-update-common && cargo test
cd desktop/portable-updater && cargo test
cd desktop/src-tauri && cargo test
cargo check --target x86_64-pc-windows-msvc -p portable-updater   # 需已装该 target
```

`portable-update-common/tests/tauri_signer_interop.rs` 用本机 Tauri CLI 生成一次性密钥并按 `--app-version` 签名，验证 helper 的验签路径与流水线产出的签名同构（不会读取任何发布私钥）。

下载与签名验证完成后才开始安装准备。所有窗口必须确认空闲并释放串口；在飞的原生操作、设备固件升级、测试和功耗仪连接都会阻止安装。无响应窗口超过 8 秒同样拒绝安装。循环发送暂时停止，安装失败可重试，串口若已关闭需手动重连。

准备完成后将各窗口的会话键和现有日志缓存写入应用私有数据目录的一次性文件（不写到共享 localStorage）。重启时按原窗口恢复，再删除交接文件；日志仍受现有缓存行数与存储预算限制。失败时删除交接文件并解除冻结，不自动恢复已运行的设备任务。

客户端前端依赖随包存放在 `desktop/vendor/`，资源版本与网页 CDN 保持一致；打包副本使用本地 CSS、脚本和图标字体，启动无需访问 CDN。维护方法见 `vendor/README.md`。


## 通信调试的电脑蓝牙

macOS/Windows 客户端在原选口入口提供普通串口、SPP 与 BLE（`computer-ble` 电脑 BLE 实现），外置 USB BLE 桥不进入该下拉、只在 BLE 桥页处理；展示名改为「通信调试」，应用名与内部 serial 存储保持不变。SPP 继续使用系统 IOBluetooth/RFCOMM；电脑 BLE 使用锁定于 Cargo.lock 的 bluest 0.6.9（macOS CoreBluetooth、Windows WinRT），无需 Web Bluetooth 或额外桥接硬件。外置 USB/ESP32 BLE 桥与高级 GATT 页继续保留，桥口接入通信调试仍走 BLE 桥页的交接按钮。

macOS `Info.plist` 的 `NSBluetoothAlwaysUsageDescription` 覆盖 SPP 与 BLE，沿用 `bundle.macOS.infoPlist` 合并进正式包；最低版本仍为 11.0。当前分发未启用 App Sandbox，无需额外沙盒蓝牙 entitlement。Windows 保持便携 ZIP 与系统 WinRT 蓝牙栈，不引入 UWP 包；需要系统蓝牙适配器、驱动和相应隐私权限。需要加密/配对的设备应按系统提示或系统蓝牙设置完成配对，本工具不自动确认 PIN。

每进程限制一条 SPP 与一条电脑 BLE；USB 双串口仍可用。设备下拉直接进入对应无线选择器。BLE 自动持续扫描并增量更新，提供名称 / 广播 UUID / 本次别名子串、最低 RSSI 与信号 / 名称 / 最近排序，可暂停继续；停止扫描须先收到原生登记确认，并等待任务收尾（等待蓝牙就绪也可暂停），保留设备供 GATT 发现。未知 RSSI 不通过信号阈值。取消发现自动回收，普通 UI 不提供独立释放键，未完成选择的回收失败才显示重试；已连接会话仍用本路断开。别名和 UUID/属性映射按设备仅记在本页面内存，BLE 全量回收后清除；临时 id、名称都不作持久匹配键，旧的全局 computerBleProfile 不自动套给设备。BLE 映射别名、扫描列表与设备下拉改名共享同一来源；SPP 按本代次原生身份共享别名，仍由系统明确选择配对设备。发现后分别确认完整 TX/RX UUID 与所属服务、写模式，RX 订阅成功才就绪。UUID/属性不能证明应用语义正确。20 字节写分片保守兼容默认 ATT MTU，不承诺特定固件升级吞吐。刷新后需重新选无线设备；重连发现重复 UUID 实例时需重选。

发布前人工验收：两个系统分别检查蓝牙权限首次授权/拒绝、系统蓝牙关闭、SPP 系统配对与关闭、跨服务 BLE TX/RX、指示特征、无响应写入、长帧写时并发通知、拔电断线/设备重启、取消发现与订阅、刷新/销毁、多窗口争用、更新准备期间的释放。合成回归与 macOS Rust 编译不替代 Windows 编译、真实设备或安装包权限验证。
