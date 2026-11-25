[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json 版本无效。' }

$nodeVersion = 'v22.23.5'
$nodeArchiveHash = '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'
$nodeHash = '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'
$label = 'ZCode-Claude-Style-' + $package.version + '-win-x64'
$defaultConfig = '{"mascot":"glm","homeRipple":true,"theme":true,"tokenHud":true}'
$dist = Join-Path (Split-Path -Parent $source) 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$dist = (Resolve-Path -LiteralPath $dist).Path
$stage = Join-Path $dist ('.stage-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage $label
$vendor = Join-Path $payload 'vendor\node'
$node = Join-Path $vendor 'node.exe'
$nodeLicense = Join-Path $vendor 'LICENSE.txt'
$zipName = $label + '.zip'
$stagedZip = Join-Path $stage $zipName
$zip = Join-Path $dist $zipName
$checksumFile = $zip + '.sha256'

try {
    New-Item -ItemType Directory -Path $vendor -Force | Out-Null
    $files = @(
        'cdp.js', 'inject.js', 'watch.js', 'remove.js', 'style.css', 'selectors.json',
        'package.json', 'LICENSE', 'launch.cmd', 'launch.ps1', 'restore.cmd', 'create-shortcut.cmd', 'check.cmd',
        'assets\glm-mascot.webp', 'assets\NOTICE.md',
        'runtime\mascot-core.js', 'runtime\ripple-core.js', 'runtime\hud-data.js', 'runtime\mascot.js',
        'runtime\ripple.js', 'runtime\hud.js', 'runtime\main.js'
    )
    foreach ($relative in $files) {
        $destination = Join-Path $payload $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
    }
    foreach ($doc in 'README.txt', 'THIRD-PARTY-NOTICES.txt') {
        Copy-Item -LiteralPath (Join-Path $source ('release\' + $doc)) -Destination (Join-Path $payload $doc)
    }
    [IO.File]::WriteAllText((Join-Path $payload 'config.json'), $defaultConfig + [char]10, [Text.UTF8Encoding]::new($false))

    $nodeFolder = "node-$nodeVersion-win-x64"
    $nodeArchive = Join-Path $stage ($nodeFolder + '.zip')
    & curl.exe --fail --location --retry 1 --connect-timeout 15 --max-time 150 --silent --show-error --output $nodeArchive "https://nodejs.org/dist/$nodeVersion/$nodeFolder.zip"
    if ($LASTEXITCODE -ne 0) { throw '下载官方 Node.js 压缩包失败。' }
    if ((Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeArchiveHash) {
        throw '官方 Node.js 压缩包 SHA256 校验失败。'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($nodeArchive)
    try {
        foreach ($item in @(@{ Name = 'node.exe'; Path = $node }, @{ Name = 'LICENSE'; Path = $nodeLicense })) {
            $entry = $archive.GetEntry("$nodeFolder/$($item.Name)")
            if (-not $entry) { throw "官方 Node.js 压缩包缺少 $($item.Name)。" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $item.Path)
        }
    } finally {
        $archive.Dispose()
    }

    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeHash) {
        throw '内置 Node.js 可执行文件 SHA256 校验失败。'
    }
    if ((Get-Item -LiteralPath $nodeLicense).Length -lt 10000) { throw 'Node.js 许可文件不完整。' }
    $actualVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or $actualVersion -ne $nodeVersion) { throw '内置 Node.js 版本检查失败。' }
    & $node (Join-Path $payload 'inject.js') --validate
    if ($LASTEXITCODE -ne 0) { throw '发布包运行时验证失败。' }

    Compress-Archive -LiteralPath $payload -DestinationPath $stagedZip -CompressionLevel Optimal
    $digest = (Get-FileHash -LiteralPath $stagedZip -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $stagedZip -Destination $zip -Force
    [IO.File]::WriteAllText($checksumFile, "$digest  $zipName" + [Environment]::NewLine, [Text.Encoding]::ASCII)
    [pscustomobject]@{ Zip = $zip; Bytes = (Get-Item -LiteralPath $zip).Length; SHA256 = $digest }
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolved = (Resolve-Path -LiteralPath $stage).Path
        if ((Split-Path -Parent $resolved) -ne $dist -or (Split-Path -Leaf $resolved) -notmatch '^\.stage-[0-9a-f]{32}$') {
            throw '中间目录路径不符合预期。'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
