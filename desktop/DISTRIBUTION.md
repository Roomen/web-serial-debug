# 客户端发布与更新

客户端版本只取 `js/version.js`。正式版从 `main` 发布、预览版从 `dev` 发布；其它分支的本地构建默认是 `dev`。本地可用 `RELEASE_CHANNEL=main|dev` 覆盖。通道在构建时写入网页资源，更新时不切换通道。

首次接入应用内更新需要手动安装包含 updater 且配置了公钥的发布版；此前客户端只有网页版本刷新检测，不能自行升级到这套机制。

本地 `npm run build` 不要求更新签名。设置 `TAURI_UPDATER_PUBLIC_KEY` 后客户端启用更新检查；同时设置 `TAURI_SIGNING_PRIVATE_KEY`（以及可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）才生成更新包和 `.sig`。没有公钥时构建不嵌入假的公钥、也不提供可安装的更新。公钥必须长期保持一致；轮换需另行设计迁移，不能直接替换已有客户端信任的公钥。

## GitHub 设置

先用 Tauri CLI 的 `signer generate` 创建独立更新签名密钥，并离线备份私钥。在 GitHub 仓库配置：

- Variable：`TAURI_UPDATER_PUBLIC_KEY`，内容为生成的公钥文件文本。
- Secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- macOS Secrets：`APPLE_CERTIFICATE`（P12 的 Base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`（公证专用密码）、`APPLE_TEAM_ID`。

私钥和 Apple 凭据不要提交仓库。正式版（`main`）要求更新签名与 Developer ID 签名公证配置齐全，缺少配置直接失败；预览版（`dev`）缺 Apple 配置时出未签名的 macOS 包（发布说明附 `xattr -cr` 打开方法），缺更新签名时只发布安装包、不生成更新清单，客户端不会收到这一版的应用内更新。Windows 更新包有 Tauri 更新签名；Windows Authenticode 代码签名尚需另行配置，现阶段安装包可能出现系统信誉提示。

## 发布流程

`dev` 分支上 `js/version.js` 有变化的推送（含 PR 合入）自动运行 `Desktop release`，发布预览版 `desktop-dev-v<version>`（GitHub 上标为 Pre-release）；版本号已发布过就跳过构建，所以不 bump 的推送不会出包。正式版只在 `main` 上手动运行该工作流（手动入口要等工作流文件进了 `main` 才出现），可填写更新说明，留空时预览版用触发提交的标题。工作流分别构建 macOS ARM64（Apple 芯片）与 Windows x64，不出 Intel Mac 版本；任何一项失败都不发布、不推进更新通道。

安装包及签名上传到草稿 `desktop-<channel>-v<version>`，完成后发布。该版本标签和资产按不可变发布管理，禁止替换；应递增版本重新发布。下载 URL 永远指向这个版本的资产。

通道清单发布在 `desktop-main/latest.json` 或 `desktop-dev/latest.json`。清单必须包含三种架构的更新包及匹配签名，且版本严格大于通道旧清单。验证通过且版本 release 发布后，最后才更新通道清单，客户端不会看到尚未发布的下载地址。已有通道先上传暂存清单并校验字节，再切换资产名；旧清单保留为备份，切换失败时尝试恢复。GitHub 不提供原子替换资产接口，名称切换期间可能短暂返回 404，应重试检查更新。工作流按分支串行执行，避免同通道发布竞态。首次发布如果通道清单不存在，创建通道 release；已有通道的读取失败会阻止发布。

如发布在推进通道前失败，已有通道继续指向上一版。检查草稿/已发布版本与产物后人工处理失败版本，再重跑；流程不会静默覆盖同版本资产。

macOS 更新安装 `.app.tar.gz`，首次安装仍提供 `.dmg` 与 `.app.zip`。Windows 只发布 NSIS 安装器，清单使用 `windows-x86_64-nsis` 安装类型键，不提供通用 Windows 回退条目。需在 Windows 实机验收 NSIS 安装与升级路径及目录保留。

## 本地验证

```sh
node --test desktop/scripts/updater-manifest.test.mjs
cd desktop
npm ci
npm run build
```

更新端到端验证需要两份不同版本、相同 updater 公钥的已签名安装包，以及真实可访问的 GitHub 清单。先在预览通道验证旧版升级、网络失败、签名错误与配置保留，再发布正式通道。Windows 实机验证在内网验证机进行；不可访问时记录为待验证，不声称已经通过。

下载与签名验证完成后才开始安装准备。所有窗口必须确认空闲并释放串口；在飞的原生操作、设备固件升级、测试和功耗仪连接都会阻止安装。无响应窗口超过 8 秒同样拒绝安装。循环发送暂时停止，安装失败可重试，串口若已关闭需手动重连。

准备完成后将各窗口的会话键和现有日志缓存写入应用私有数据目录的一次性文件（不写到共享 localStorage）。重启时按原窗口恢复，再删除交接文件；日志仍受现有缓存行数与存储预算限制。失败时删除交接文件并解除冻结，不自动恢复已运行的设备任务。
