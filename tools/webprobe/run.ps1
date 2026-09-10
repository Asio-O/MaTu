# 码图 端到端自检
#
#   .\run.ps1 [-Port 9222] [-Configuration Debug] [-Analyzer auto|inproc|proc] [-KeepOpen]
#
# 依次做四件事：
#   1. 自包含构建（本机没有注册 Windows App Runtime，打包形态的 exe 无法直接启动）
#   2. 先跑分析器子进程冒烟测试（不启动界面）
#   3. 启动 GUI，用 CDP 探针模拟点击并核对不变量
#   4. 造一个临时 .cs 再删掉，验证「文件监听 → 重建 → 增量推送」
#
# -Analyzer 控制分析跑在哪里：
#   auto   默认策略（大项目才用独立进程，阈值 1500 文件）
#   inproc 强制进程内
#   proc   强制独立进程

param(
    [int]$Port = 9222,
    [string]$Configuration = 'Debug',
    [ValidateSet('auto', 'inproc', 'proc')]
    [string]$Analyzer = 'auto',
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$outDir = Join-Path $repo "bin\x64\$Configuration\net8.0-windows10.0.19041.0\win-x64"
$exe = Join-Path $outDir '码图.exe'
$csproj = Join-Path $repo '码图.csproj'

Get-Process -Name '码图' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600

Write-Host '构建中（自包含 / 非打包）...'
dotnet build $csproj -c $Configuration -p:Platform=x64 `
    -p:WindowsPackageType=None -p:WindowsAppSDKSelfContained=true --nologo -v q
if ($LASTEXITCODE -ne 0) { throw '构建失败' }

$env:MATU_ANALYZER = switch ($Analyzer) {
    'proc' { '1' }
    'inproc' { '0' }
    default { 'auto' }
}

$code = 2
$proc = $null
try {
    Write-Host ''
    Write-Host '分析器子进程冒烟测试...'
    node (Join-Path $PSScriptRoot 'analyzer-smoke.js') $exe $repo
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw '分析器子进程自检失败' }

    $env:MATU_CDP_PORT = "$Port"
    $proc = Start-Process -FilePath $exe -WorkingDirectory $outDir -PassThru
    Write-Host "`n已启动 码图.exe (pid=$($proc.Id))，调试端口 $Port，分析模式 $Analyzer"

    node (Join-Path $PSScriptRoot 'probe.js') $Port
    $code = $LASTEXITCODE

    if ($code -eq 0) {
        Write-Host ''
        Write-Host '热更新链路自检（新增/删除临时 .cs）...'
        node (Join-Path $PSScriptRoot 'watch.js') $Port $repo
        if ($LASTEXITCODE -ne 0) { $code = $LASTEXITCODE }
    }
}
finally {
    # 自检可能被中断在「临时文件已建、还没删」的时刻，这里兜一次底
    Get-ChildItem -Path $repo -Filter '__matu_probe_tmp.cs' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    if (-not $KeepOpen) {
        Get-Process -Name '码图' -ErrorAction SilentlyContinue | Stop-Process -Force
        Write-Host '已关闭 码图'
    }
}

exit $code
