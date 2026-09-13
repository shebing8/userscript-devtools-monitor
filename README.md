# Userscript DevTools Monitor

面向 Tampermonkey / Violentmonkey 脚本逆向与状态分析的本地监控包。它直接连接 Chrome DevTools Protocol（CDP），不依赖第三方 npm 包，可同时记录网络、控制台、异常、脚本、执行上下文、WebSocket 和调试器暂停事件，并允许从终端调用 DevTools 能力。

## 环境要求

- Windows 10/11
- PowerShell 5.1 或 PowerShell 7+
- Node.js 22+
- Google Chrome 或 Microsoft Edge

无需执行 `npm install`，下载并解压即可使用。

## 目录

- `launch-debug-browser.ps1`：启动独立调试浏览器实例。
- `cdp-monitor.mjs`：监控与交互式 DevTools 客户端。
- `userscript-probe.user.js`：可选的页面级探针，适合观测 fetch/XHR/WebSocket/路由/存储/DOM 状态。
- `start-monitor.ps1`：PowerShell 启动包装器。
- `quick-start.ps1`：一条命令启动浏览器并连接监控。
- `telemetry/`：运行后自动生成 JSONL、DOM、MHTML、脚本源码等证据文件。

## 快速开始

默认 CDP 端口是 **9222**，接口地址为 `http://127.0.0.1:9222`。

在 PowerShell 中进入本目录：

```powershell
# 最快方式
.\quick-start.ps1 -Url 'https://目标地址/' -CaptureBodies

# 或分别启动
# 1. 启动隔离的 Chrome；也可传 -Browser edge
.\launch-debug-browser.ps1 -Browser chrome -Url 'https://目标地址/'

# 2. 另开终端，连接当前页面
.\start-monitor.ps1 -Match '目标域名' -CaptureBodies
```

将 userscript 作为 CDP preload 安装到当前标签页，并在该标签后续刷新/导航时自动注入：

```powershell
.\start-monitor.ps1 -Match '目标域名' -CaptureBodies -Preload '.\userscript-probe.user.js'
```

若要以本地 Chrome 扩展形式加载脚本，可在启动浏览器时传扩展目录：

```powershell
.\launch-debug-browser.ps1 -Browser chrome -DebugPort 9222 `
  -ExtensionDir 'C:\path\to\unpacked-extension' `
  -Url 'https://目标地址/'
```

如果没有安装 Chrome：

```powershell
.\launch-debug-browser.ps1 -Browser edge -Url 'https://目标地址/'
```

浏览器使用本目录下独立的 `debug-profile`，不会污染日常浏览器配置。在该实例中安装 Tampermonkey 或 Violentmonkey，再导入待分析脚本。也可把 `userscript-probe.user.js` 作为一个新脚本导入，并让它排在目标脚本之前执行。

## 交互命令

监控启动后，可在同一终端输入：

```text
help                         显示帮助
targets                      列出可调试页面
contexts                     列出主世界和 userscript 隔离世界
scripts [过滤词]             列出 CDP 已捕获的脚本
eval <JavaScript>            在主世界执行表达式
eval@<contextId> <JS>        在指定执行上下文执行（可直达油猴隔离世界）
pause / resume               暂停或恢复 JavaScript
reload                       重新加载页面
body <requestId>             读取指定响应体
source <scriptId> [文件名]   导出脚本源码
dom [文件名]                 导出 DOMSnapshot JSON
snapshot [文件名]            导出 MHTML 页面快照
inject <脚本路径>            仅向当前页面主世界注入脚本
preload <脚本路径>           当前页注入，并在后续导航自动注入
preloads                     列出当前监控安装的 preload
clear                        清屏（不清除证据文件）
quit                         退出
```

示例：

```text
contexts
eval location.href
eval Object.keys(window).filter(k => /monkey|webpack|vite/i.test(k))
eval@17 typeof GM_getValue
scripts userscript
source 42 target.user.js
dom after-click.json
```

## 输出与检索

事件按一行一个 JSON 写入 `telemetry/session-*.jsonl`。可直接用 PowerShell 检索：

```powershell
Select-String -Path .\telemetry\session-*.jsonl -Pattern 'exception|Debugger.paused|webSocket|XHR'
Get-Content .\telemetry\session-*.jsonl -Tail 50
```

每条记录都有：

- `ts`：ISO 时间；
- `type`：CDP 事件或本工具事件；
- `data`：结构化载荷；
- `target`：页面标题、URL、target id。

默认会对 `Authorization`、`Cookie`、`Set-Cookie`、常见 token/key/password 字段做脱敏。传 `-RawSecrets` 可关闭脱敏，仅用于隔离测试环境。

## 探针用法

`userscript-probe.user.js` 会将页面级事件以 `[USMON]` 前缀写入 console，因此 `cdp-monitor.mjs` 会自动收集。页面控制台还可调用：

```js
__USMON__.status()
__USMON__.mark('before-submit', { orderId: 123 })
__USMON__.snapshot()
__USMON__.watch(window.someObject, 'someObject')
__USMON__.restore()
```

探针配置位于文件顶部的 `CONFIG`。建议先设置 `urlAllow`，只在目标站点运行。若目标脚本必须最早执行，先只用 CDP 监控；待确认关键分支后再启用探针做差分测试。

## 与原生 DevTools 共用

CDP 监控和 F12 DevTools 可同时使用。需要断点时：

1. F12 打开 DevTools；
2. 在 Sources 中给目标 userscript 设断点，或终端输入 `pause`；
3. 终端会记录 `Debugger.paused`，包括 call frame、URL、行列号和 scope；
4. 用 `contexts` 找到 userscript world，再用 `eval@<id>` 检查状态；
5. 输入 `resume` 恢复。

## 常见问题

- **连接不到 9222**：必须用本包脚本启动一个独立实例；已运行的普通 Chrome 不会自动开放 CDP。
- **找不到目标页面**：先运行 `node .\cdp-monitor.mjs --list`，再调整 `-Match`。
- **抓不到 document-start 早期事件**：先启动 monitor，再输入 `reload`；如需页面 API 调用级事件，确保 probe 的脚本顺序早于目标脚本。
- **页面太吵**：用 `-Match` 锁定域名；不加 `-CaptureBodies`；在 probe 里关闭 `observeDom` 或调大 `domFlushMs`。
- **DevTools 打开后页面变慢**：`scripts` 和网络元数据仍可用；仅在需要时使用 `-CaptureBodies` 和 DOM probe。

## License

[MIT](LICENSE)
