# 把截图降采样成字符画 —— 在无法直接看图时用文字"看"版面结构。
# 每个格子取平均色，按亮度选字符；同时给出该格是否"高饱和"（彩色/图案）的标记。
# 用法: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ascii-view.ps1 [-X 0 -Y 90 -W 1200 -H 435 -Cols 120 -Rows 40]
param(
  [int]$X = 0, [int]$Y = 90, [int]$W = 1200, [int]$H = 435,
  [int]$Cols = 120, [int]$Rows = 40,
  [string]$Name = "_screen.png"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$src = Join-Path $PSScriptRoot $Name
$img = New-Object System.Drawing.Bitmap((Join-Path $PSScriptRoot $Name))
if ($X + $W -gt $img.Width) { $W = $img.Width - $X }
if ($Y + $H -gt $img.Height) { $H = $img.Height - $Y }
$cw = [double]$W / $Cols
$ch = [double]$H / $Rows
$ramp = " .:-=+*#%@"
Write-Output ("view of ({0},{1}) {2}x{3} as {4}x{5}" -f $X,$Y,$W,$H,$Cols,$Rows)
$hdr = "     "
for ($c = 0; $c -lt $Cols; $c++) { $hdr += if ($c % 10 -eq 0) { [string](($c / 10) % 10) } else { " " } }
Write-Output $hdr
for ($r = 0; $r -lt $Rows; $r++) {
  $line = ""
  $satLine = ""
  for ($c = 0; $c -lt $Cols; $c++) {
    $x0 = [int]($X + $c * $cw); $y0 = [int]($Y + $r * $ch)
    $x1 = [Math]::Min([int]($x0 + $cw) , $X + $W - 1); $y1 = [Math]::Min([int]($y0 + $ch), $Y + $H - 1)
    $rs = 0.0; $gs = 0.0; $bs = 0.0; $n = 0
    for ($px = $x0; $px -le $x1; $px += 2) {
      for ($py = $y0; $py -le $y1; $py += 2) {
        $p = $img.GetPixel($px, $py)
        $rs += $p.R; $gs += $p.G; $bs += $p.B; $n++
      }
    }
    if ($n -eq 0) { $n = 1 }
    $rAvg = $rs / $n; $gAvg = $gs / $n; $bAvg = $bs / $n
    $lum = (0.299 * $rAvg + 0.587 * $gAvg + 0.114 * $bAvg) / 255.0
    $mx = [Math]::Max($rAvg, [Math]::Max($gAvg, $bAvg))
    $mn = [Math]::Min($rAvg, [Math]::Min($gAvg, $bAvg))
    $sat = if ($mx -le 0) { 0 } else { ($mx - $mn) / $mx }
    $idx = [int]([Math]::Round($lum * ($ramp.Length - 1)))
    if ($idx -lt 0) { $idx = 0 }
    if ($idx -ge $ramp.Length) { $idx = $ramp.Length - 1 }
    $chr = $ramp[$idx]
    if ($sat -gt 0.55 -and $lum -gt 0.25 -and $lum -lt 0.95) { $chr = if ($lum -gt 0.6) { "O" } else { "o" } }
    $line += $chr
    $satLine += if ($sat -gt 0.55) { "c" } else { " " }
  }
  Write-Output ("{0,4} {1}" -f ([int]($Y + $r * $ch)), $line)
}
$img.Dispose()
