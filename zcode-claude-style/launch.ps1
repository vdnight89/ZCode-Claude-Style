[CmdletBinding(DefaultParameterSetName = 'Launch')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Shortcut')]
    [switch]$CreateShortcut,

    [Parameter(Mandatory, ParameterSetName = 'Restore')]
    [switch]$Restore,

    [Parameter(Mandatory, ParameterSetName = 'Check')]
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

function Find-ZCode {
    if ($env:ZCODE_CLAUDE_STYLE_EXE) {
        $candidate = $env:ZCODE_CLAUDE_STYLE_EXE
        if ([IO.Path]::IsPathRooted($candidate) -and (Split-Path -Leaf $candidate) -ieq 'ZCode.exe' -and
            (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
        throw 'ZCODE_CLAUDE_STYLE_EXE 必须是指向 ZCode.exe 的有效绝对路径。'
    }

    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'ZCode\ZCode.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\ZCode\ZCode.exe'),
        (Join-Path $env:LOCALAPPDATA 'ZCode\ZCode.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
}

$program = Find-ZCode
if (-not $program -and -not $Restore) {
    throw '找不到 ZCode.exe。请先安装 ZCode，或设置 ZCODE_CLAUDE_STYLE_EXE 指向其完整路径。'
}
if ($program) { $env:ZCODE_CLAUDE_STYLE_EXE = $program }

if ($CreateShortcut) {
    $shortcutPath = Join-Path $PSScriptRoot 'ZCode (Claude Style).lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $PSScriptRoot 'launch.cmd'
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.IconLocation = "$program,0"
    $shortcut.Description = '启动带 Claude Style 的 ZCode'
    $shortcut.Save()
    Write-Output $shortcutPath
    return
}

$node = Join-Path $PSScriptRoot 'vendor\node\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw '找不到 Node.js。请完整解压分享包。' }
    $node = $command.Source
}

$nodeVersion = & $node -p process.versions.node
if ($LASTEXITCODE -ne 0 -or [int](($nodeVersion -split '\.')[0]) -lt 22) {
    throw '需要 Node.js 22 或更新版本。分享包已经内置 Windows x64 运行时。'
}

if ($Restore) {
    & $node (Join-Path $PSScriptRoot 'remove.js')
    exit $LASTEXITCODE
}

$entry = Join-Path $PSScriptRoot 'inject.js'
& $node $entry --validate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Check) {
    & $node $entry --check
    exit $LASTEXITCODE
}

$running = @(Get-Process -Name ZCode -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    & $node $entry --check
    if ($LASTEXITCODE -ne 0) {
        throw '现有 ZCode 进程没有可连接的调试端口。请从系统托盘退出 ZCode 后再运行 launch.cmd。'
    }
} else {
    foreach ($name in 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING',
        'ELECTRON_ENABLE_STACK_DUMPING', 'ELECTRON_DEBUG_NOTIFICATIONS', 'ELECTRON_HIDE_INSPECTOR') {
        [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
    }
    Start-Process -FilePath $program -ArgumentList '--remote-debugging-port=0' -WorkingDirectory (Split-Path -Parent $program)
}

$watcher = @{
    FilePath = $node
    ArgumentList = @('"' + $entry + '"', '--watch', '--exit-on-host-close')
    WorkingDirectory = $PSScriptRoot
    WindowStyle = 'Hidden'
}
Start-Process @watcher
