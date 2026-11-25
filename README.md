# ZCode Claude Style

ZCode 桌面端的 Windows 外观与用量增强工具。包含 GLM 娘、首页字符波纹、深浅主题适配，以及显示上下文、缓存、对话轮次、工具用量和双周期配额的 Token 监控。

## Windows 启动

1. 安装 ZCode 桌面端。从本仓库运行源码时，另需 Node.js 22 或更新版本。便携包已内置 Node.js。
2. 从系统托盘退出正在运行的 ZCode。
3. 双击 `launch.cmd`。源码中的脚本位于 `zcode-claude-style` 目录。

双击 `create-shortcut.cmd` 可生成本地快捷方式，双击 `restore.cmd` 可在当前窗口还原。详细说明见 [Windows 便携包使用说明](zcode-claude-style/release/README.txt) 和 [配置与开发](zcode-claude-style/README.md)。

## 构建与验证

在 `zcode-claude-style` 目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1`，生成 Windows x64 ZIP 和 SHA-256 校验文件，输出目录为仓库根目录下的 `dist`。运行 `node --test` 可验证监控数据处理。

适配已在 Windows 11 与 ZCode 4.0.0.10870 上验证。代码与素材的来源见 [第三方声明](zcode-claude-style/release/THIRD-PARTY-NOTICES.txt) 和 [素材署名](zcode-claude-style/assets/NOTICE.md)。
