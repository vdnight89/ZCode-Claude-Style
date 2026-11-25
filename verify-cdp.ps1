#requires -Version 5.1
<#
.SYNOPSIS
    验证打包版 ZCode 桌面端是否接受 --remote-debugging-port，也就是 CDP 注入通道能否使用。

.DESCRIPTION
    完整模式（默认）依次执行：
      1. 完全退出 ZCode。默认不强杀：读取 ~/.zcode/v2/setting.json 的 closeToTrayOnWindows，
         为 false 时发关闭消息即可退出；为 true 时提示你从托盘菜单退出并等待。
      2. 以 --remote-debugging-port 重新启动 ZCode。
      3. 检查 %APPDATA%\ZCode\session\DevToolsActivePort 是否在启动之后刷新；
         找不到时退而扫描 ZCode 进程监听的本地端口。
      4. 请求 /json/version 和 /json/list。
      5. 对每个页面目标做一次只读 CDP 探测（Runtime.evaluate），确认脚本能在主窗口
         的主世界执行、能拿到 window.zcode 和 data-testid 锚点、内联 <style> 不被 CSP 拦截。
         探测会往页面追加一个空样式元素并在同一次调用里移除，不留任何痕迹。
      6. 结果写到脚本所在目录的 verify-cdp-result.json，过程写到 verify-cdp.log。

    -CheckOnly 只做第 3 到 5 步，不退出也不启动 ZCode。

    完整模式如果是从 ZCode 自己的进程树里启动的（例如它的内置终端），脚本会先通过 WMI
    把自己转到一个独立进程再执行，这样 ZCode 退出时验证不会跟着中断。

    退出码：0 通过；1 未通过；2 被取消或等待超时；3 脚本出错。

.PARAMETER Port
    传给 ZCode 的调试端口。默认 0，表示由系统随机分配空闲端口。

.PARAMETER QuitTimeoutSec
    等待 ZCode 退出的最长时间（秒），默认 180。

.PARAMETER BootTimeoutSec
    启动后等待调试端口就绪的最长时间（秒），默认 120。

.PARAMETER CheckOnly
    只读检查当前运行中的 ZCode，不退出也不启动。

.PARAMETER Force
    跳过等待，直接强制结束 ZCode。正在运行的 Agent 任务会被中断。

.PARAMETER NoPrompt
    不等待按键，适合无人值守。

.PARAMETER Detached
    内部使用：标记当前实例已经脱离原进程树。

.PARAMETER OutDir
    结果和日志的输出目录，默认是脚本所在目录。

.EXAMPLE
    .\verify-cdp.cmd
    .\verify-cdp.cmd -CheckOnly
    .\verify-cdp.cmd -Force -NoPrompt
#>
param(
    [int]$Port = 0,
    [int]$QuitTimeoutSec = 180,
    [int]$BootTimeoutSec = 120,
    [switch]$CheckOnly,
    [switch]$Force,
    [switch]$NoPrompt,
    [switch]$Detached,
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = $script:ScriptDir }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath

$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:LogFile = Join-Path $OutDir 'verify-cdp.log'
$script:ResultFile = Join-Path $OutDir 'verify-cdp-result.json'
$script:Steps = New-Object System.Collections.ArrayList
$script:ProgressLen = 0
$script:ExitCode = 0
$script:StartedAt = Get-Date

# 用 API 而不是环境变量取路径：经 WMI 转出来的独立进程未必带完整环境。
$appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
if ([string]::IsNullOrWhiteSpace($appData)) { $appData = $env:APPDATA }
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($userProfile)) { $userProfile = $env:USERPROFILE }
$script:PortFile = Join-Path (Join-Path $appData 'ZCode') 'session\DevToolsActivePort'
$script:SettingFile = Join-Path (Join-Path $userProfile '.zcode\v2') 'setting.json'

$script:Interactive = $false
try {
    $script:Interactive = ([Environment]::UserInteractive -and ($Host.Name -eq 'ConsoleHost') -and (-not [Console]::IsInputRedirected) -and (-not [Console]::IsOutputRedirected))
} catch { $script:Interactive = $false }
if ($NoPrompt) { $script:Interactive = $false }
# 输出被重定向（例如被别的程序捕获）时按 UTF-8 写，避免中文乱码。
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = $script:Utf8 } catch {} }

$script:ProbeExpression = @'
(function () {
  var q = function (s) { try { return !!document.querySelector(s); } catch (e) { return false; } };
  var styleAccepted = null, styleRules = null;
  try {
    var s = document.createElement('style');
    s.textContent = '.__zcode_cdp_probe__{outline:0 solid transparent}';
    (document.head || document.documentElement).appendChild(s);
    styleAccepted = !!s.sheet;
    styleRules = s.sheet ? s.sheet.cssRules.length : 0;
    s.parentNode.removeChild(s);
  } catch (e) { styleAccepted = 'error: ' + (e && e.message); }
  var hasFiber = false;
  var nodes = [document.body].concat([].slice.call(document.body ? document.body.children : []));
  for (var i = 0; i < nodes.length && !hasFiber; i++) {
    var keys = nodes[i] ? Object.keys(nodes[i]) : [];
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].indexOf('__reactFiber$') === 0 || keys[j].indexOf('__reactContainer$') === 0) { hasFiber = true; break; }
    }
  }
  return JSON.stringify({
    title: document.title,
    href: String(location.href).slice(0, 200),
    readyState: document.readyState,
    bridge: typeof window.zcode,
    reactFiber: hasFiber,
    testidCount: document.querySelectorAll('[data-testid]').length,
    anchors: {
      composerThoughtSlider: q('[data-testid="composer-thought-slider"]'),
      composerProviderTrigger: q('[data-testid="composer-provider-trigger"]'),
      composerStatusRow: q('[data-testid="composer-status-row"]'),
      sidebarTaskList: q('[data-testid="sidebar-task-list-region"]')
    },
    styleInjection: { accepted: styleAccepted, rules: styleRules },
    viewport: [window.innerWidth, window.innerHeight]
  });
})()
'@

# ---------------------------------------------------------------- 输出

function Write-Log {
    param(
        [string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )
    Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $Message) -ForegroundColor $Color
    try {
        [System.IO.File]::AppendAllText($script:LogFile, ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message + [Environment]::NewLine), $script:Utf8)
    } catch {}
}

function Write-Plain([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
    Write-Host $Message -ForegroundColor $Color
}

function Add-Step([string]$Name, [string]$Status, [string]$Detail) {
    [void]$script:Steps.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail })
}

function Show-Progress([string]$Text) {
    if (-not $script:Interactive) { return }
    $pad = $Text.PadRight([Math]::Max($Text.Length, $script:ProgressLen))
    $script:ProgressLen = $pad.Length
    Write-Host -NoNewline ("`r" + $pad)
}

function Hide-Progress {
    if (-not $script:Interactive) { return }
    Write-Host -NoNewline ("`r" + (' ' * $script:ProgressLen) + "`r")
    $script:ProgressLen = 0
}

# ---------------------------------------------------------------- 交互

function Read-HotKey {
    try {
        while ($Host.UI.RawUI.KeyAvailable) {
            $k = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown,IncludeKeyUp')
            if ($k.KeyDown) { return ([string]$k.Character).ToLowerInvariant() }
        }
    } catch {
        # 没有控制台或输入被重定向：此后按无人值守处理
        $script:Interactive = $false
        Start-Sleep -Milliseconds 600
    }
    return $null
}

function Wait-Until {
    # 轮询 $Condition 直到为真、超时或按下 $HotKeys 之一。返回 @{ hit; key }
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][int]$TimeoutSec,
        [string]$Label = '',
        [string[]]$HotKeys = @(),
        [switch]$AnyKey
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastShown = -1
    $lastReport = Get-Date
    if ($Label -and -not $script:Interactive) { Write-Log ($Label -f $TimeoutSec) DarkGray }
    while ($true) {
        if (& $Condition) { Hide-Progress; return @{ hit = $true; key = $null } }
        $left = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
        if ($left -le 0) { Hide-Progress; return @{ hit = $false; key = $null } }
        $key = Read-HotKey
        if ($null -ne $key -and ($AnyKey -or ($HotKeys -contains $key))) { Hide-Progress; return @{ hit = $false; key = $key } }
        if ($script:Interactive) {
            if ($left -ne $lastShown) { Show-Progress ($Label -f $left); $lastShown = $left }
        } elseif ($Label -and ((Get-Date) - $lastReport).TotalSeconds -ge 15) {
            $lastReport = Get-Date
            Write-Log ($Label -f $left) DarkGray
        }
        Start-Sleep -Milliseconds 200
    }
}

function Wait-AnyKey([int]$TimeoutSec) {
    if (-not $script:Interactive) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $key = Read-HotKey
        if ($null -ne $key) { return }
        Start-Sleep -Milliseconds 150
    }
}

function Set-ConsoleTopmost([bool]$On) {
    if (-not $script:Interactive) { return }
    try {
        if (-not ('ZCodeVerifyNative' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZCodeVerifyNative {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
        }
        $h = [ZCodeVerifyNative]::GetConsoleWindow()
        if ($h -eq [IntPtr]::Zero) { return }
        [void][ZCodeVerifyNative]::ShowWindow($h, 5)
        $after = [IntPtr]::new(-2)
        if ($On) { $after = [IntPtr]::new(-1) }
        [void][ZCodeVerifyNative]::SetWindowPos($h, $after, 0, 0, 0, 0, 0x0043)
        if ($On) { [void][ZCodeVerifyNative]::SetForegroundWindow($h) }
    } catch {}
}

# ---------------------------------------------------------------- 进程

function Get-ZCodeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='ZCode.exe' OR Name='zcode-runtime-host.exe'" -ErrorAction SilentlyContinue)
}

function Test-IsZCodeMain($Proc) {
    if (-not $Proc) { return $false }
    if ([string]$Proc.Name -ne 'ZCode.exe') { return $false }
    $cl = [string]$Proc.CommandLine
    if ([string]::IsNullOrWhiteSpace($cl)) { return ([string]$Proc.ExecutablePath -like '*\ZCode.exe') }
    return ($cl.IndexOf('zcode.cjs', [StringComparison]::OrdinalIgnoreCase) -lt 0) -and ($cl.IndexOf('--type=', [StringComparison]::OrdinalIgnoreCase) -lt 0)
}

function Get-ZCodeMainProcesses {
    return @(Get-ZCodeProcesses | Where-Object { Test-IsZCodeMain $_ })
}

function Get-ZCodeDesktopProcesses {
    # 归属于桌面端的进程：主进程、它的 --type 子进程、surface=desktop 的引擎，
    # 以及父进程在上面这些之内的插件宿主和 runtime-host。其它（比如终端里单独跑的 CLI）不碰。
    $all = @(Get-ZCodeProcesses)
    $desktop = New-Object System.Collections.ArrayList
    $pending = New-Object System.Collections.ArrayList
    foreach ($p in $all) {
        $cl = [string]$p.CommandLine
        if (Test-IsZCodeMain $p) { [void]$desktop.Add($p) }
        elseif ($cl.IndexOf('--type=', [StringComparison]::OrdinalIgnoreCase) -ge 0) { [void]$desktop.Add($p) }
        elseif ($cl -match '--surface"?\s+"?desktop') { [void]$desktop.Add($p) }
        else { [void]$pending.Add($p) }
    }
    $ids = @($desktop | ForEach-Object { [int]$_.ProcessId })
    $zcodeIds = @($all | Where-Object { [string]$_.Name -eq 'ZCode.exe' } | ForEach-Object { [int]$_.ProcessId })
    for ($round = 0; $round -lt 4; $round++) {
        $changed = $false
        foreach ($item in @($pending)) {
            $ppid = [int]$item.ParentProcessId
            $related = ($ids -contains $ppid) -or (([string]$item.Name -eq 'zcode-runtime-host.exe') -and ($zcodeIds -contains $ppid))
            if ($related) {
                [void]$desktop.Add($item)
                $pending.Remove($item)
                $ids += [int]$item.ProcessId
                $changed = $true
            }
        }
        if (-not $changed) { break }
    }
    return $desktop
}

function Get-AncestorProcessNames {
    $names = New-Object System.Collections.Generic.List[string]
    $cur = $PID
    $guard = 0
    while ($cur -gt 0 -and $guard -lt 64) {
        $guard++
        $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cur) -ErrorAction SilentlyContinue
        if (-not $p) { break }
        $names.Add([string]$p.Name)
        $cur = [int]$p.ParentProcessId
    }
    return $names
}

function Find-ZCodeExe($MainProc) {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($MainProc -and $MainProc.ExecutablePath) { $candidates.Add([string]$MainProc.ExecutablePath) }
    if ($env:ZCODE_WINDOWS_APP_INSTALL_DIR) { $candidates.Add((Join-Path $env:ZCODE_WINDOWS_APP_INSTALL_DIR 'ZCode.exe')) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'ZCode\ZCode.exe')) }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'ZCode\ZCode.exe')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\ZCode\ZCode.exe')) }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Get-CloseToTraySetting {
    # $true / $false；读不到时返回 $null
    try {
        if (-not (Test-Path -LiteralPath $script:SettingFile)) { return $null }
        $json = [System.IO.File]::ReadAllText($script:SettingFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($json.PSObject.Properties.Name -contains 'closeToTrayOnWindows') { return [bool]$json.closeToTrayOnWindows }
    } catch {}
    return $null
}

function Invoke-TaskKillTree([int]$TargetId) {
    try {
        $exe = Join-Path (Join-Path $env:SystemRoot 'System32') 'taskkill.exe'
        $p = Start-Process -FilePath $exe -ArgumentList @('/F', '/T', '/PID', [string]$TargetId) -WindowStyle Hidden -Wait -PassThru
        return ($p.ExitCode -eq 0)
    } catch { return $false }
}

function Stop-ZCodeDesktopProcesses {
    # 只应在主进程已经退出（或即将被强杀）之后调用：结束残留的桌面端进程
    foreach ($p in @(Get-ZCodeDesktopProcesses)) {
        Write-Log ('结束残留进程 {0} (PID {1})' -f $p.Name, $p.ProcessId) DarkGray
        Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ZCodeForcibly {
    $mains = @(Get-ZCodeMainProcesses)
    foreach ($m in $mains) {
        Write-Log ('强制结束 ZCode 主进程 PID {0} 及其子进程树' -f $m.ProcessId) Yellow
        [void](Invoke-TaskKillTree ([int]$m.ProcessId))
    }
    $w = Wait-Until -Condition { @(Get-ZCodeMainProcesses).Count -eq 0 } -TimeoutSec 15 -Label '等待 ZCode 进程结束… 剩余 {0} 秒'
    Stop-ZCodeDesktopProcesses
    Start-Sleep -Milliseconds 800
    return (@(Get-ZCodeProcesses | Where-Object { Test-IsZCodeMain $_ }).Count -eq 0)
}

# ---------------------------------------------------------------- 退出

function Stop-ZCode {
    $mains = @(Get-ZCodeMainProcesses)
    if ($mains.Count -eq 0) {
        Write-Log 'ZCode 当前没有运行，跳过退出步骤' DarkGray
        Add-Step 'quit' 'skipped' 'ZCode 未运行'
        return $true
    }
    foreach ($m in $mains) {
        Write-Log ('ZCode 主进程 PID {0}' -f $m.ProcessId)
    }

    if ($Force) {
        Write-Log '-Force：立即强制结束 ZCode，正在运行的 Agent 任务会被中断' Yellow
        $done = Stop-ZCodeForcibly
        if ($done) { Add-Step 'quit' 'forced' 'taskkill /F /T' }
        else { Add-Step 'quit' 'failed' '强制结束后仍有 ZCode 主进程' }
        return $done
    }

    $closeToTray = Get-CloseToTraySetting
    if ($closeToTray -eq $false) {
        Write-Log '设置是“关闭窗口即退出”：向主窗口发送关闭消息'
        foreach ($m in $mains) {
            try {
                $gp = Get-Process -Id ([int]$m.ProcessId) -ErrorAction Stop
                [void]$gp.CloseMainWindow()
            } catch {}
        }
        Write-Plain '如果 ZCode 弹出“仍有任务在运行”的确认框，请点确认退出。' White
        $w = Wait-Until -Condition { @(Get-ZCodeMainProcesses).Count -eq 0 } -TimeoutSec $QuitTimeoutSec -Label '等待 ZCode 退出… 剩余 {0} 秒   [Q] 放弃' -HotKeys @('q')
    } else {
        if ($null -eq $closeToTray) { $why = '读不到设置，按“隐藏到托盘”处理' } else { $why = 'ZCode 开启了“关闭窗口后隐藏到托盘”' }
        Write-Log ($why + '，脚本没法从外部让它优雅退出，需要你手动点一次退出：') Yellow
        Write-Plain ''
        Write-Plain '    1. 找到任务栏右下角托盘区的 ZCode 图标（可能收在 ^ 展开菜单里）' White
        Write-Plain '    2. 右键 → 退出（或用 ZCode 菜单里的“退出”）' White
        Write-Plain '    只点窗口的 X 没有用，那只是把它收进托盘。' White
        Write-Plain ''
        Set-ConsoleTopmost $true
        try {
            $w = Wait-Until -Condition { @(Get-ZCodeMainProcesses).Count -eq 0 } -TimeoutSec $QuitTimeoutSec -Label '等你退出 ZCode… 剩余 {0} 秒   [F] 强制结束   [Q] 放弃' -HotKeys @('f', 'q')
        } finally {
            Set-ConsoleTopmost $false
        }
        if (-not $w.hit -and $w.key -eq 'f') {
            Write-Plain ''
            Write-Log '强制结束会中断正在运行的 Agent 任务。' Yellow
            $c = Wait-Until -Condition { $false } -TimeoutSec 15 -Label '按 [Y] 确认强制结束，按 [Q] 取消… 剩余 {0} 秒' -HotKeys @('y', 'q')
            if ($c.key -eq 'y') {
                $done = Stop-ZCodeForcibly
                if ($done) { Add-Step 'quit' 'forced' '用户确认后 taskkill /F /T'; return $true }
                Add-Step 'quit' 'failed' '强制结束后仍有 ZCode 主进程'
                return $false
            }
            Write-Log '已取消强制结束' DarkGray
            Add-Step 'quit' 'aborted' '用户取消强制结束'
            return $false
        }
    }

    if ($w.hit) {
        # 主进程已优雅退出；等它的子进程自行收尾，仍残留的按孤儿处理
        [void](Wait-Until -Condition { @(Get-ZCodeDesktopProcesses).Count -eq 0 } -TimeoutSec 15 -Label '等待 ZCode 子进程退出… 剩余 {0} 秒')
        Stop-ZCodeDesktopProcesses
        Add-Step 'quit' 'graceful' '应用自行退出'
        Write-Log 'ZCode 已退出' Green
        return $true
    }
    if ($w.key -eq 'q') {
        Add-Step 'quit' 'aborted' '用户放弃'
        Write-Log '已放弃，ZCode 保持运行' Yellow
        return $false
    }
    Add-Step 'quit' 'timeout' ('等待 ' + $QuitTimeoutSec + ' 秒后 ZCode 仍在运行')
    Write-Log '等待退出超时，ZCode 保持运行。可以加 -Force 强制结束，或先手动退出再运行。' Red
    return $false
}

# ---------------------------------------------------------------- 调试端口

function Read-PortFileState {
    $state = @{ exists = $false; port = $null; mtimeUtc = [DateTime]::MinValue }
    try {
        if (Test-Path -LiteralPath $script:PortFile) {
            $state.exists = $true
            $state.mtimeUtc = (Get-Item -LiteralPath $script:PortFile -Force).LastWriteTimeUtc
            $lines = [System.IO.File]::ReadAllLines($script:PortFile)
            if ($lines.Count -gt 0) {
                $n = 0
                if ([int]::TryParse(([string]$lines[0]).Trim(), [ref]$n) -and $n -gt 0) { $state.port = $n }
            }
        }
    } catch {}
    return $state
}

function Get-LocalJson([string]$Url) {
    # 不走系统代理
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = 4000
    $req.ReadWriteTimeout = 4000
    $req.KeepAlive = $false
    $req.AllowAutoRedirect = $false
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Close() }
    } finally { $resp.Close() }
    return ($text | ConvertFrom-Json)
}

function Test-DebugEndpoint([int]$DebugPort) {
    try {
        $v = Get-LocalJson ('http://127.0.0.1:' + $DebugPort + '/json/version')
        if ($v.webSocketDebuggerUrl -and ([string]$v.webSocketDebuggerUrl) -match '/devtools/browser/') { return $v }
    } catch {}
    return $null
}

function Find-ListeningDebugPort {
    # 端口文件不在预期位置时的退路：看 ZCode 进程在本地回环上监听的哪个端口像 DevTools 端点
    $ids = @(Get-ZCodeProcesses | Where-Object { [string]$_.Name -eq 'ZCode.exe' } | ForEach-Object { [int]$_.ProcessId })
    if ($ids.Count -eq 0) { return $null }
    $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
        ($ids -contains [int]$_.OwningProcess) -and (($_.LocalAddress -eq '127.0.0.1') -or ($_.LocalAddress -eq '::1'))
    })
    foreach ($c in ($conns | Sort-Object LocalPort -Unique)) {
        if (Test-DebugEndpoint ([int]$c.LocalPort)) { return [int]$c.LocalPort }
    }
    return $null
}

function Find-DebugPort([DateTime]$NotBefore, [bool]$RequireFresh, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $nextScan = (Get-Date).AddSeconds(4)
    $lastReport = Get-Date
    while ($true) {
        $st = Read-PortFileState
        if ($st.port) {
            $fresh = ((-not $RequireFresh) -or ($st.mtimeUtc -ge $NotBefore.AddSeconds(-3)))
            if ($fresh) {
                $v = Test-DebugEndpoint $st.port
                if ($v) { Hide-Progress; return @{ port = $st.port; source = 'port-file'; version = $v; portFileTime = $st.mtimeUtc } }
            }
        }
        if ((Get-Date) -ge $nextScan) {
            $nextScan = (Get-Date).AddSeconds(5)
            $lp = Find-ListeningDebugPort
            if ($lp) { Hide-Progress; return @{ port = $lp; source = 'listen-scan'; version = (Test-DebugEndpoint $lp); portFileTime = $null } }
        }
        $left = [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
        if ($left -le 0) { Hide-Progress; return $null }
        $key = Read-HotKey
        if ($null -ne $key -and $key -eq 'q') { Hide-Progress; return @{ cancelled = $true } }
        if ($script:Interactive) {
            Show-Progress ('等待调试端口就绪… 剩余 {0} 秒   [Q] 放弃' -f $left)
        } elseif (((Get-Date) - $lastReport).TotalSeconds -ge 15) {
            $lastReport = Get-Date
            Write-Log ('等待调试端口就绪… 剩余 {0} 秒' -f $left) DarkGray
        }
        Start-Sleep -Milliseconds 300
    }
}

function Invoke-CdpEvaluate([string]$WsUrl, [string]$Expression, [int]$TimeoutMs = 10000) {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutMs)
    try {
        $ws.ConnectAsync([Uri]$WsUrl, $cts.Token).GetAwaiter().GetResult()
        $payload = (@{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expression; returnByValue = $true } } | ConvertTo-Json -Depth 6 -Compress)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $sendSeg = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
        $ws.SendAsync($sendSeg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
        $buffer = New-Object byte[] 65536
        $sb = New-Object System.Text.StringBuilder
        while ($true) {
            $recvSeg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
            $res = $ws.ReceiveAsync($recvSeg, $cts.Token).GetAwaiter().GetResult()
            if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'CDP 连接被对方关闭' }
            [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
            if ($res.EndOfMessage) { break }
        }
        return ($sb.ToString() | ConvertFrom-Json)
    } finally {
        try { $ws.Dispose() } catch {}
        $cts.Dispose()
    }
}

function Get-PageTargets([int]$DebugPort) {
    try {
        $all = @(Get-LocalJson ('http://127.0.0.1:' + $DebugPort + '/json/list'))
        return @($all | Where-Object { $_.type -eq 'page' -and ([string]$_.url) -notmatch '^(devtools|data):' })
    } catch { return @() }
}

function Invoke-ProbePages([int]$DebugPort) {
    $out = New-Object System.Collections.ArrayList
    $pages = @(Get-PageTargets $DebugPort | Select-Object -First 6)
    if ($pages.Count -eq 0) { return $out }
    foreach ($t in $pages) {
        $entry = [ordered]@{ title = [string]$t.title; url = [string]$t.url; ok = $false; error = $null; data = $null }
        if (-not $t.webSocketDebuggerUrl) {
            $entry.error = '没有 webSocketDebuggerUrl'
            [void]$out.Add($entry)
            continue
        }
        try {
            $resp = Invoke-CdpEvaluate ([string]$t.webSocketDebuggerUrl) $script:ProbeExpression
            if ($resp.error) { $entry.error = ('CDP 错误: ' + [string]$resp.error.message) }
            elseif ($resp.result -and $resp.result.exceptionDetails) { $entry.error = ('页面内异常: ' + [string]$resp.result.exceptionDetails.text) }
            else {
                $entry.data = ([string]$resp.result.result.value | ConvertFrom-Json)
                $entry.ok = $true
            }
        } catch { $entry.error = $_.Exception.Message }
        [void]$out.Add($entry)
    }
    return $out
}

function Test-MainWindowReady($Probe) {
    foreach ($e in @($Probe)) {
        if ($e.ok -and $e.data -and ($e.data.testidCount -gt 0) -and ([string]$e.data.readyState -eq 'complete')) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------- 脱离原进程树

function Start-DetachedProcess([string]$CommandLine, [string]$WorkingDirectory) {
    # 经 WMI 创建的进程挂在 WmiPrvSE 下，不属于调用方的进程树或 Job，调用方退出不影响它
    $params = @{ CommandLine = $CommandLine }
    if ($WorkingDirectory) { $params.CurrentDirectory = $WorkingDirectory }
    return (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $params -ErrorAction Stop)
}

function Start-DetachedSelf([string[]]$ExtraArgs = @()) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Detached',
        '-Port', [string]$Port, '-QuitTimeoutSec', [string]$QuitTimeoutSec, '-BootTimeoutSec', [string]$BootTimeoutSec,
        '-OutDir', ('"' + $OutDir + '"')) + $ExtraArgs
    if ($Force) { $argList += '-Force' }
    if ($NoPrompt) { $argList += '-NoPrompt' }
    return (Start-DetachedProcess ('powershell.exe ' + ($argList -join ' ')) $OutDir)
}

# ---------------------------------------------------------------- 主流程

function Invoke-Main {
    if (-not $Detached -and -not $CheckOnly) {
        $chain = @(Get-AncestorProcessNames)
        $inZCode = ($chain -contains 'ZCode.exe')
        $viaExplorer = ($chain -contains 'explorer.exe')
        if ($inZCode -or -not $viaExplorer) {
            Write-Log '当前位于 ZCode 的进程树内（或不是从资源管理器启动），先转为独立进程…' Yellow
            $r = Start-DetachedSelf
            if ($r.ReturnValue -ne 0) {
                Write-Log ('无法创建独立进程（Win32_Process.Create 返回 ' + $r.ReturnValue + '）。请改为在资源管理器里双击 verify-cdp.cmd。') Red
                $script:ExitCode = 3
                return
            }
            Write-Log ('验证已在独立进程（PID ' + $r.ProcessId + '）里继续，会弹出一个新的命令行窗口；本窗口可以关了。') Green
            Write-Log '独立进程里如果要求你退出 ZCode：右键托盘里的 ZCode 图标 → 退出。' Yellow
            Wait-AnyKey 10
            $script:ExitCode = 0
            return
        }
    }

    try { $Host.UI.RawUI.WindowTitle = 'ZCode CDP 通道验证' } catch {}
    $exitCode = 0
    $result = [ordered]@{
        tool = 'zcode-cdp-verify'
        mode = $(if ($CheckOnly) { 'check-only' } else { 'full' })
        status = 'started'
        ok = $false
        startedAt = $script:StartedAt.ToString('yyyy-MM-dd HH:mm:ss')
        sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        interactive = $script:Interactive
        detached = [bool]$Detached
        requestedPort = $Port
        portFile = $script:PortFile
        zcode = $null
        steps = @()
        port = $null
        portSource = $null
        browser = $null
        targets = @()
        probe = @()
        notes = @()
    }
    $notes = New-Object System.Collections.ArrayList

    try {
        Write-Log '=== ZCode CDP 通道验证 ===' Cyan
        Write-Log ('模式: {0}   输出目录: {1}' -f $result.mode, $OutDir) DarkGray

        # ---- 1/5 现状 ----
        Write-Log '[1/5] 检查当前状态'
        $mains = @(Get-ZCodeMainProcesses)
        $exe = Find-ZCodeExe ($mains | Select-Object -First 1)
        $runningWithFlag = $false
        foreach ($m in $mains) {
            $hasFlag = ([string]$m.CommandLine) -match '--remote-debugging-port(=|\s|$)'
            $runningWithFlag = $runningWithFlag -or $hasFlag
            Write-Log ('ZCode 主进程 PID {0}，{1}' -f $m.ProcessId, $(if ($hasFlag) { '已带 --remote-debugging-port' } else { '没带调试参数' }))
        }
        if ($mains.Count -eq 0) { Write-Log 'ZCode 没有在运行' }
        if ($exe) {
            $result.zcode = [ordered]@{ exe = $exe; version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion; wasRunning = ($mains.Count -gt 0); wasRunningWithFlag = $runningWithFlag }
            Write-Log ('程序: {0}  版本 {1}' -f $exe, $result.zcode.version) DarkGray
        } else {
            Write-Log '找不到 ZCode.exe，无法启动' Red
        }
        if (-not $exe -and $mains.Count -eq 0) { throw '找不到 ZCode.exe' }

        if ($CheckOnly) {
            if ($mains.Count -eq 0) {
                Add-Step 'state' 'not-running' 'ZCode 未运行'
                Write-Log 'ZCode 没在运行，无从检查。先完整验证一次（不带 -CheckOnly）。' Yellow
                $result.status = 'not-running'
                $exitCode = 1
                $script:ExitCode = $exitCode; return
            }
        } else {
            if ($mains.Count -gt 0 -and $runningWithFlag) {
                Write-Log 'ZCode 已经带着调试参数在运行，跳过退出和重启' Green
                $skipRelaunch = $true
            } else {
                Write-Plain ''
                if ($Force) {
                    Write-Plain '验证会强制结束并重新启动 ZCode，正在运行的 Agent 任务会被打断。' Yellow
                } else {
                    Write-Plain '验证需要完全退出并重新启动 ZCode，正在运行的 Agent 任务会被打断。' Yellow
                    Write-Plain '先把手头任务停掉再继续更稳妥。' Yellow
                }
                $go = @{ key = $null }
                if ($script:Interactive) {
                    $go = Wait-Until -Condition { $false } -TimeoutSec 10 -Label '按任意键开始（10 秒后自动开始），按 [Q] 取消… 剩余 {0} 秒' -HotKeys @('q') -AnyKey
                }
                if ($go.key -eq 'q') {
                    Add-Step 'confirm' 'aborted' '用户取消'
                    Write-Log '已取消' Yellow
                    $result.status = 'cancelled'
                    $exitCode = 2
                    $script:ExitCode = $exitCode; return
                }
                Hide-Progress
                Write-Plain ''

                # ---- 2/5 退出 ----
                Write-Log '[2/5] 退出 ZCode'
                if (-not (Stop-ZCode)) {
                    $result.status = 'quit-' + $script:Steps[$script:Steps.Count - 1].status
                    $exitCode = 2
                    if ($script:Steps[$script:Steps.Count - 1].status -eq 'failed') { $exitCode = 1 }
                    $script:ExitCode = $exitCode; return
                }
                Start-Sleep -Milliseconds 1500

                # ---- 3/5 启动 ----
                Write-Log '[3/5] 带调试参数启动 ZCode'
                if (-not $exe) { throw '找不到 ZCode.exe，无法重新启动' }
                # 这些变量若从上层环境继承下来，会让 Electron 以纯 Node 方式启动或改变行为
                foreach ($n in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_ENABLE_STACK_DUMPING', 'ELECTRON_DEBUG_NOTIFICATIONS', 'ELECTRON_HIDE_INSPECTOR')) {
                    [Environment]::SetEnvironmentVariable($n, $null, [EnvironmentVariableTarget]::Process)
                }
                $launchStamp = [DateTime]::UtcNow
                Start-Process -FilePath $exe -ArgumentList @('--remote-debugging-port=' + $Port) -WorkingDirectory (Split-Path -Parent $exe) | Out-Null
                $up = Wait-Until -Condition { @(Get-ZCodeMainProcesses).Count -gt 0 } -TimeoutSec 30 -Label '等待 ZCode 启动… 剩余 {0} 秒'
                if (-not $up.hit) {
                    Add-Step 'launch' 'failed' '30 秒内没有看到 ZCode 主进程'
                    Write-Log '启动后没看到 ZCode 主进程。请手动打开 ZCode。' Red
                    throw 'ZCode 启动失败'
                }
                $newMain = @(Get-ZCodeMainProcesses)[0]
                $flagOn = ([string]$newMain.CommandLine) -match '--remote-debugging-port(=|\s|$)'
                Add-Step 'launch' 'ok' ('主进程 PID {0}，命令行带参数: {1}' -f $newMain.ProcessId, $flagOn)
                Write-Log ('ZCode 已启动（主进程 PID {0}）' -f $newMain.ProcessId) Green
                $result.zcode.launchedPid = [int]$newMain.ProcessId
                $result.zcode.launchedWithFlag = $flagOn
            }
        }

        # ---- 4/5 调试端口 ----
        if ($CheckOnly) { Write-Log '[2/3] 查找调试端口' } else { Write-Log '[4/5] 查找调试端口' }
        if (Get-Item -LiteralPath $script:PortFile -ErrorAction SilentlyContinue) {
            $st0 = Read-PortFileState
            Write-Log ('端口文件 {0}  上次写入 {1}  内容端口 {2}' -f $script:PortFile, $st0.mtimeUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss'), $st0.port) DarkGray
        } else {
            Write-Log ('端口文件还不存在: ' + $script:PortFile) DarkGray
        }
        if ($CheckOnly) {
            # 没带调试参数时基本不会有端口，不必久等
            $waitSec = 3
            if ($runningWithFlag) { $waitSec = 10 }
            $found = Find-DebugPort ([DateTime]::Now.AddDays(-30)) $false $waitSec
        }
        elseif ($skipRelaunch) { $found = Find-DebugPort ([DateTime]::Now.AddDays(-30)) $false 20 }
        else { $found = Find-DebugPort $launchStamp $true $BootTimeoutSec }
        if ($found -and $found.cancelled) {
            Add-Step 'port' 'aborted' '用户放弃'
            $result.status = 'cancelled'
            $exitCode = 2
            $script:ExitCode = $exitCode; return
        }
        if (-not $found) {
            Add-Step 'port' 'failed' '没有找到调试端口'
            Write-Log '没有找到调试端口。' Red
            $curMain = @(Get-ZCodeMainProcesses | Select-Object -First 1)
            $flagNow = $false
            if ($curMain.Count -gt 0) { $flagNow = ([string]$curMain[0].CommandLine) -match '--remote-debugging-port(=|\s|$)' }
            if (-not $CheckOnly -and -not $flagNow) {
                Write-Log 'ZCode 主进程的命令行里没有 --remote-debugging-port，参数没传进去。' Red
            } elseif (-not $CheckOnly) {
                Write-Log '参数在主进程上，但没有 DevTools 端点响应：这个版本很可能忽略或禁用了调试端口。' Red
            } else {
                Write-Log '当前这次 ZCode 没有带调试参数运行。先完整验证一次（不带 -CheckOnly）。' Yellow
            }
            $result.status = 'no-debug-port'
            $exitCode = 1
            $script:ExitCode = $exitCode; return
        }
        $debugPort = [int]$found.port
        $result.port = $debugPort
        $result.portSource = $found.source
        $result.browser = [ordered]@{
            Browser = [string]$found.version.Browser
            userAgent = [string]$found.version.'User-Agent'
            protocolVersion = [string]$found.version.'Protocol-Version'
        }
        Add-Step 'port' 'ok' ('端口 {0}（来源: {1}）' -f $debugPort, $found.source)
        Write-Log ('调试端口 {0}，来源 {1}' -f $debugPort, $(if ($found.source -eq 'port-file') { 'DevToolsActivePort' } else { '监听端口扫描' })) Green
        Write-Log ('/json/version: {0}' -f $result.browser.Browser) Green
        if ($found.source -eq 'listen-scan') {
            [void]$notes.Add('端口文件不在预期位置，端口靠扫描监听端口找到；移植时 readPort 要相应调整。')
        }

        # ---- 5/5 页面探测 ----
        if ($CheckOnly) { Write-Log '[3/3] 探测页面' } else { Write-Log '[5/5] 探测页面' }
        $probe = New-Object System.Collections.ArrayList
        $deadline = (Get-Date).AddSeconds(40)
        while ($true) {
            $probe = @(Invoke-ProbePages $debugPort)
            if ((Test-MainWindowReady $probe) -or ((Get-Date) -ge $deadline)) { break }
            Start-Sleep -Seconds 2
        }
        $allTargets = @()
        try { $allTargets = @(Get-LocalJson ('http://127.0.0.1:' + $debugPort + '/json/list')) } catch {}
        $result.targets = @($allTargets | ForEach-Object { [ordered]@{ type = [string]$_.type; title = [string]$_.title; url = [string]$_.url } })
        foreach ($t in ($result.targets | Select-Object -First 12)) {
            $title = [string]$t.title
            if ($title.Length -gt 46) { $title = $title.Substring(0, 43) + '...' }
            $url = [string]$t.url
            if ($url.Length -gt 96) { $url = $url.Substring(0, 93) + '...' }
            Write-Log ('  [{0}] {1}  {2}' -f $t.type, $title, $url) DarkGray
        }
        $result.probe = @($probe)
        $mainPages = @($probe | Where-Object { $_.ok -and $_.data -and (($_.data.bridge -eq 'object') -or ($_.data.testidCount -gt 0)) })
        if ($probe.Count -eq 0) {
            Add-Step 'probe' 'failed' '没有可探测的页面目标'
            Write-Log '端点在，但 /json/list 里没有页面目标。' Red
        } elseif ($mainPages.Count -eq 0) {
            foreach ($e in $probe) { if ($e.error) { Write-Log ('  探测失败: ' + $e.error) Red } }
            Add-Step 'probe' 'failed' '没有探测到主窗口页面'
            Write-Log '端口通了，但没能探测到 ZCode 主窗口页面。' Red
        } else {
            $m = $mainPages[0].data
            $styleOk = ($m.styleInjection.accepted -eq $true)
            Add-Step 'probe' 'ok' ('主窗口: bridge={0}, data-testid={1}, reactFiber={2}, 内联样式={3}' -f $m.bridge, $m.testidCount, $m.reactFiber, $styleOk)
            Write-Log ('主窗口: {0}' -f $mainPages[0].title) Green
            Write-Log ('  主世界脚本执行      OK') Green
            Write-Log ('  window.zcode        {0}' -f $m.bridge) $(if ($m.bridge -eq 'object') { [ConsoleColor]::Green } else { [ConsoleColor]::Yellow })
            Write-Log ('  React Fiber         {0}' -f $m.reactFiber) $(if ($m.reactFiber) { [ConsoleColor]::Green } else { [ConsoleColor]::Yellow })
            Write-Log ('  data-testid 锚点    {0} 个' -f $m.testidCount) $(if ($m.testidCount -gt 0) { [ConsoleColor]::Green } else { [ConsoleColor]::Yellow })
            Write-Log ('  输入框锚点          thoughtSlider={0} providerTrigger={1}' -f $m.anchors.composerThoughtSlider, $m.anchors.composerProviderTrigger) $(if ($m.anchors.composerThoughtSlider) { [ConsoleColor]::Green } else { [ConsoleColor]::Yellow })
            if ($styleOk) {
                Write-Log ('  内联 <style> 注入    没被 CSP 拦截') Green
            } else {
                Write-Log ('  内联 <style> 注入    被拦截或异常: {0}（移植时改用 adoptedStyleSheets）' -f [string]$m.styleInjection.accepted) Yellow
            }
            [void]$notes.Add('CDP 探测是只读的，只执行了一段取信息的脚本并瞬时增删了一个空样式元素。')
        }
        if ($mainPages.Count -eq 0) {
            $result.status = 'no-main-window'
            $exitCode = 1
            $script:ExitCode = $exitCode; return
        }

        $result.status = 'passed'
        $result.ok = $true
        Write-Log '结论: 通过。ZCode 接受 --remote-debugging-port，CDP 注入通道可用。' Green
        if (-not $CheckOnly) {
            [void]$notes.Add('ZCode 现在以带调试端口的状态运行；下次按平常方式启动（不带参数）端口就没了。')
        }
        $exitCode = 0
        $script:ExitCode = $exitCode; return
    } catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) { $msg = $msg + ' / ' + $_.Exception.InnerException.Message }
        Write-Log ('脚本出错: ' + $msg) Red
        Add-Step 'error' 'error' $msg
        $result.status = 'error'
        $exitCode = 3
        $script:ExitCode = $exitCode; return
    } finally {
        $result.finishedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        $result.steps = @($script:Steps)
        $result.notes = @($notes)
        try {
            [System.IO.File]::WriteAllText($script:ResultFile, ($result | ConvertTo-Json -Depth 8), $script:Utf8)
        } catch {
            Write-Log ('结果写入失败: ' + $_.Exception.Message) Red
        }
        Write-Plain ''
        Write-Log ('结果: {0}   {1}' -f $result.status, $script:ResultFile) $(if ($result.ok) { [ConsoleColor]::Green } else { [ConsoleColor]::Yellow })
        if (-not $CheckOnly) {
            Wait-AnyKey 600
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $null = Invoke-Main
    exit $script:ExitCode
}
