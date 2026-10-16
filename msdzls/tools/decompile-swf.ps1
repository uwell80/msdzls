#!/usr/bin/env pwsh
# 用随项目携带的便携 JRE + FFDec 反编译 client-cache 里的 SWF，
# 产物写到 decompiled/<SWF名>/（与既有的 TDCore/TDLoaderUI 结构一致）。
#
# 用法：
#   pwsh tools/decompile-swf.ps1 TDTownUI TDWorldMapUI TDGameReadyUI
#   pwsh tools/decompile-swf.ps1 -AllMissing     # 反编译 missing-swfs.txt 里列出的
#
# 依赖：tools/jre（Temurin JRE 17，解压即用，见 README）与 tools/ffdec。

param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Names,
    [switch]$AllMissing
)

$ErrorActionPreference = "Stop"
$msdzls = Split-Path -Parent $PSScriptRoot
$jre = Join-Path $PSScriptRoot "jre\bin\java.exe"
$jar = Join-Path $PSScriptRoot "ffdec\ffdec-cli.jar"
$cache = Join-Path $msdzls "client-cache"
$outRoot = Join-Path $msdzls "decompiled"

if (-not (Test-Path $jre)) { throw "缺少便携 JRE：$jre（见 README 的安装说明）" }
if (-not (Test-Path $jar)) { throw "缺少 FFDec：$jar" }

if ($AllMissing) {
    $listFile = Join-Path $msdzls "server\missing-swfs.txt"
    $Names = Get-Content $listFile | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() -replace '\.swf$', '' }
}

if (-not $Names -or $Names.Count -eq 0) { throw "没有指定 SWF 名。用法：decompile-swf.ps1 TDTownUI ..." }

foreach ($name in $Names) {
    $swf = Join-Path $cache "$name.swf"
    if (-not (Test-Path $swf)) { Write-Warning "跳过（本地无此 SWF）：$name"; continue }
    $out = Join-Path $outRoot $name
    Write-Host "==> $name -> $out"
    & $jre -jar $jar -export script,image $out $swf | Out-Null
    $count = (Get-ChildItem -Path $out -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host "    done ($count files)"
}
