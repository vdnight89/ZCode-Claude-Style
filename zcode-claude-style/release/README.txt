ZCode Claude Style 0.2.2
Windows x64 便携分享包

适用环境

Windows 10 或 11 x64，电脑需已安装 ZCode 桌面端。本包在 Windows 11 和 ZCode 4.0.0.10870 上验证，内置 Node.js 22.23.5。

从旧版升级时，先从系统托盘退出 ZCode，再解压新版到新目录。需要保留自定义设置时，将原来的 config.json 复制到新版目录。

第一次启动

1. 在资源管理器右键 ZIP，选择「全部解压缩」，保存到自己有写入权限的目录。
2. 如果 ZCode 正在运行，从任务栏右下角系统托盘右键 ZCode 图标，选择「退出」。
3. 打开解压后的文件夹，双击 launch.cmd。ZCode 打开后，已有对话的输入框上、下方会出现用量条；首页可以看到 GLM 娘和字符波纹。
4. 想要快捷方式时，双击 create-shortcut.cmd。它会在当前文件夹创建 ZCode (Claude Style).lnk。移动整个文件夹后可重新生成。

使用

- 在已有对话中点击输入框下方的「用量详情」，打开上下文总览、逐轮明细、工具与子代理排行、模型配额。
- 底栏分开显示 5 小时和每周额度。较窄的输入区优先显示两档额度。
- 点击输入框右下方的「吉物 开 / 关」切换显隐，设置会保存。消息队列出现时吉物暂时隐藏，队列收起后按开关设置恢复。
- 点击 /compact 预填命令，然后由你决定是否发送。输入框有草稿时会保留草稿。
- ~ 表示估算，— 表示 ZCode 没有返回该项。旧会话中部分指标可能缺失。

配置

用记事本打开 config.json，修改并保存。带主题的 ZCode 运行时会自动加载有效配置。

  mascot     "glm" 显示 GLM 娘，"off" 关闭吉物
  homeRipple true 或 false，控制首页波纹
  theme      true 或 false，控制主题配色。深色输入区沿用 ZCode 原生色
  tokenHud   true 或 false，控制用量条与监控面板

还原与卸载

双击 restore.cmd 可在当前窗口还原 ZCode 原界面。后续想用普通模式，从托盘退出一次 ZCode，再用原来的 ZCode 图标启动。
删掉解压文件夹即可移除这套便携包。

常见问题

- 显示没有调试端口时，确认已从托盘退出原来的 ZCode，再运行 launch.cmd。只关窗口可能会保留后台进程。
- 显示找不到 ZCode.exe 时，请确认已安装。安装在自定义目录时，可在 Windows 用户环境变量中添加 ZCODE_CLAUDE_STYLE_EXE，值为 ZCode.exe 的完整路径，再重新打开启动脚本。
- 想确认连接情况，可在当前文件夹的终端运行 check.cmd。它会验证配置并显示能否连接当前 ZCode。
- 使用普通 ZCode 图标启动时采用原生界面。此包的启动脚本为 ZCode 开一个随机的本机回环调试端口，完全退出 ZCode 后该端口随进程关闭。

来源与许可

这是非官方外观增强包。代码、Node.js 与吉物对应的出处可见 THIRD-PARTY-NOTICES.txt 和 assets\NOTICE.md。
