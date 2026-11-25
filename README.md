# ZCode Claude Style

![ZCode Claude Style 封面，GLM 娘与深浅两套配色](docs/cover.webp)

给 Windows 上的 ZCode 桌面端加上 GLM 娘、首页字符波纹和用量面板。输入框边上随时可看上下文余量、缓存命中率和两档配额。

**[下载 Windows x64 便携包](https://github.com/vdnight89/ZCode-Claude-Style/releases/latest)** · [完整使用说明](zcode-claude-style/release/README.txt)

## 功能

| 功能 | 在哪里用 |
| --- | --- |
| **用量条** | 会话输入框上下方显示上下文余量、缓存、生成速度、累计吞吐和调用次数。底栏单独列出 5 小时和每周额度。 |
| **Token 监控** | 点击「用量详情」，查看上下文拆分、对话轮次、工具与子代理排行、模型配额，也可以复制报告。 |
| **对话压缩** | 点击 `/compact` 将命令填入空白输入框，由你决定何时发送。已有草稿会保留。 |
| **主题与吉物** | 浅色采用暖色输入区，深色沿用 ZCode 原生输入区配色。点击 GLM 娘可以互动，首页背景带字符波纹。 |

用量面板使用 ZCode 提供的数据和已载入的会话记录。`~` 表示估算，`—` 表示当前缺少可用数据。

## 三步启动

需要 Windows x64 和已安装的 ZCode 桌面端。便携包自带 Node.js。已在 Windows 11 与 ZCode `4.0.0.10870` 上验证。

1. 到 Releases 的 **Assets** 下载名称以 `-win-x64.zip` 结尾的便携包，完整解压到有写入权限的目录。
2. 如果 ZCode 正在运行，从 Windows 系统托盘右键 ZCode 图标并选择「退出」。
3. 打开解压后的目录，双击 `launch.cmd`。进入有用量数据的会话即可看到用量条。

| 想做什么 | 操作 |
| --- | --- |
| 快速启动 | 双击 `create-shortcut.cmd` 生成快捷方式。 |
| 调整显示 | 用记事本编辑 `config.json`，可独立开关吉物、首页波纹、主题和 Token 监控。 |
| 恢复原界面 | 双击 `restore.cmd`。以后想按原生方式启动，从托盘退出后使用原来的 ZCode 图标。 |
| 检查连接 | ZCode 运行时双击 `check.cmd`。若提示无调试端口，先从托盘退出 ZCode，再运行 `launch.cmd`。 |

## 从源码运行或打包

运行源码需要 Node.js 22 或更新版本。进入 `zcode-claude-style`，运行 `launch.cmd` 即可启动。下面的命令用于测试和构建。

```powershell
Set-Location .\zcode-claude-style
node --test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1
```

构建完成后，仓库根目录的 `dist` 中会生成便携 ZIP 和 SHA-256 校验文件。更多命令见 [配置与开发](zcode-claude-style/README.md)。

## 来源与许可

这是社区制作的 ZCode 扩展。部分代码源自 `agy-claude-style`，GLM 娘角色设定署名 ZipZipPipe（胖次狐）。 [代码许可](zcode-claude-style/LICENSE) · [第三方声明](zcode-claude-style/release/THIRD-PARTY-NOTICES.txt) · [封面署名](docs/cover.md)
