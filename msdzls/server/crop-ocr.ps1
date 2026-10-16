# 裁一块画面区域 → 放大 → OCR。用于"看不见画面"时读局部小字（如准备界面的卡片名、按钮）。
# 用法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File crop-ocr.ps1 -X 0 -Y 90 -W 1200 -H 435 -Scale 6
#   powershell.exe ... -Name _screen.png      # 复用已有截图，不再现场抓
param(
  [int]$X = 0, [int]$Y = 90, [int]$W = 1200, [int]$H = 435,
  [double]$Scale = 6.0,
  [string]$Name = "",
  [string[]]$ProcessNames = @('FCBrowserManager', 'SLBrowser', 'FCBrowser')
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32C {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
if ($Name -eq "") {
  $proc = $null
  foreach ($n in $ProcessNames) {
    $proc = Get-Process $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) { break }
  }
  if (-not $proc) { Write-Output "game window not found"; exit 1 }
  $h = $proc.MainWindowHandle
  [W32C]::ShowWindow($h, 9) | Out-Null
  [W32C]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 900
  $r = New-Object W32C+RECT
  [W32C]::GetWindowRect($h, [ref]$r) | Out-Null
  $ww = $r.Right - $r.Left; $wh = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($ww, $wh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc(); $pw = [W32C]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc)
  if (-not $pw) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size) }
  $Name = "_screen.png"
  $bmp.Save((Join-Path $PSScriptRoot $Name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "captured rect=$($r.Left),$($r.Top) ${ww}x${wh}"
}
$src = Join-Path $PSScriptRoot $Name
$img = [System.Drawing.Image]::FromFile($src)
if ($X + $W -gt $img.Width) { $W = $img.Width - $X }
if ($Y + $H -gt $img.Height) { $H = $img.Height - $Y }
$zw = [int]($W * $Scale); $zh = [int]($H * $Scale)
$dst = Join-Path $PSScriptRoot "_screen_crop.png"
$bmp2 = New-Object System.Drawing.Bitmap($zw, $zh)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$dest = New-Object System.Drawing.Rectangle(0, 0, $zw, $zh)
$g2.DrawImage($img, $dest, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose(); $bmp2.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $bmp2.Dispose(); $img.Dispose()
Write-Output "crop: src=($X,$Y) ${W}x${H} -> ${zw}x${zh}  $dst"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($dst)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output "===== CROP OCR (coords are window-pixel) ====="
foreach ($line in $result.Lines) {
  $px = -1; $py = -1; $t = ""
  foreach ($wd in $line.Words) {
    if ($px -lt 0) {
      $rc = $wd.BoundingRect
      $px = [int]($X + $rc.X / $Scale); $py = [int]($Y + $rc.Y / $Scale)
    }
    $t += $wd.Text
  }
  Write-Output ("({0,4},{1,4})  {2}" -f $px, $py, $t)
}
