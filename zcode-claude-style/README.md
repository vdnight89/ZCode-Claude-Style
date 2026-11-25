# ZCode Claude Style

通过本机 CDP 为 ZCode 桌面端添加可切换吉物、首页字符波纹、暖色主题和上下文 Token 监控。已在 Windows 上用 ZCode 4.0.0.10870 和 Node.js 22 验证。

## 启动与停止

1. 安装 ZCode 桌面端。从源码运行时需安装 Node.js 22 或更新版本。
2. 从 Windows 系统托盘退出 ZCode，再双击 `launch.cmd`。启动器使用随机环回端口启动 ZCode，随后由看护自动注入。
3. 从托盘退出 ZCode 时，启动器创建的看护也会退出。

双击 `create-shortcut.cmd` 可在本目录生成快捷方式。项目移动到新路径后可重新生成。

双击 `restore.cmd` 可在当前窗口恢复原界面。下次从系统菜单正常启动 ZCode 时，继续使用原生界面。

## 配置

编辑 `config.json` 并保存。看护运行时会自动加载有效配置。

| 字段 | 值 | 效果 |
| --- | --- | --- |
| `mascot` | `"glm"` 或 `"off"` | 显示 GLM 娘或关闭吉物。默认显示 GLM 娘 |
| `homeRipple` | `true` 或 `false` | 首页字符波纹 |
| `theme` | `true` 或 `false` | 暖色主题，浅色使用 Claude 输入框风格，深色输入区沿用 ZCode 原生配色 |
| `tokenHud` | `true` 或 `false` | 常驻用量条及 Token 监控面板 |

GLM 娘可用鼠标或键盘激活，素材和生成提示词见 [素材记录](./assets/NOTICE.md)。点击首页问候周围的背景会触发波纹。开启系统减少动态效果时，吉物和波纹使用静态显示。

## Token 监控

已有对话的输入框上下方显示常驻用量条。点击右下方「用量详情」可查看上下文总览、对话轮次、工具与子代理排行、模型配额。修改 config.json 中的 tokenHud 可单独关闭整套监控。

- 常驻条显示上下文已用与剩余、平均缓存命中率、可用的生成速度、累计吞吐、输出及调用次数。底栏分别显示 5 小时和每周额度，窄输入区优先显示额度。
- 监控面板复用 ZCode 原生上下文、缓存和配额数据。原生数据缺项时显示横线或标为估算。最新调用速度和首字延迟依赖模型上报。
- 本次注入期间记录轮次上下文快照，对比同一模型、同一窗口上限的相邻已观察轮次。旧轮次仍可查看原生输出和调用数，模型缺失的输出按可见文本估算。
- 工具排行按已载入的工具结果估算 Token，标明缺失与截断。子代理优先显示原生目录和子会话调试数据。
- /compact 按钮只填入命令，已有草稿会保留。复制报告包含汇总和排行，省略对话正文。


## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `node inject.js --check` | 检查当前调试主窗口，显示端口来源 |
| `node inject.js` | 为当前主窗口注入一次 |
| `node inject.js --watch` | 热更新，并在 ZCode 带参数重开后恢复 |
| `node remove.js` | 停止看护并卸载 |
| `node --test` | 验证用量统计逻辑 |
| `node layout-smoke.js` | 在显示用量条和吉物的会话中验证布局和 `/compact` 的点击区域 |
| `node live-smoke.js --navigate --existing` | 检查当前注入，浏览现有会话后返回首页 |
| `node soak.js` | 记录 60 分钟的渲染器堆和 DOM 计数 |

冒烟测试从空白首页开始。`--capture` 需要窗口在前台，会把首页局部截图写入 `../logs`。`--existing` 检查已经注入的窗口，默认模式会自行注入和卸载。

部分运行时代码源自 `agy-claude-style` v2.1.0。代码许可见 [LICENSE](./LICENSE)，素材与打包组件的许可见 [第三方声明](./release/THIRD-PARTY-NOTICES.txt)。
