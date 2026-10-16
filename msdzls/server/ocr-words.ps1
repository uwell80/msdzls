# 截图 + OCR，并把每个词的**窗口内像素坐标**打出来 —— 用于在"看不见画面"时
# 定位按钮位置（坐标 + 窗口原点 = 屏幕坐标，可直接喂给 SetCursorPos/点击）。
#
# 用法（务必 Windows PowerShell 5.1）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr-words.ps1 [-Scale 2.5] [-Name _screen.png]
# 若不加 -Name，会先现场截一张 _screen.png（等价 read-screen.ps1 的截图部分）。
param(
  [double]$Scale = 2.5,
  [string]$Name = "",
  [string[]]$ProcessNames = @('FCBrowserManager', 'SLBrowser', 'FCBrowser')
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$origin = @{ Left = 0; Top = 0 }
if ($Name -eq "") {
  $proc = $null
  foreach ($n in $ProcessNames) {
    $proc = Get-Process $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) { break }
  }
  if (-not $proc) { Write-Output "game window not found"; exit 1 }
  $h = $proc.MainWindowHandle
  [W32W]::ShowWindow($h, 9) | Out-Null
  [W32W]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 900
  $r = New-Object W32W+RECT
  [W32W]::GetWindowRect($h, [ref]$r) | Out-Null
  $origin.Left = $r.Left; $origin.Top = $r.Top
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $pw = [W32W]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  if (-not $pw) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size) }
  $Name = "_screen.png"
  $bmp.Save((Join-Path $PSScriptRoot $Name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "captured window id=$($proc.Id) rect=$($r.Left),$($r.Top) ${w}x${ht}"
}

$src = Join-Path $PSScriptRoot $Name
$dst = Join-Path $PSScriptRoot "_screen_words.png"
$img = [System.Drawing.Image]::FromFile($src)
$zw = [int]($img.Width * $Scale); $zh = [int]($img.Height * $Scale)
$bmp2 = New-Object System.Drawing.Bitmap($zw, $zh)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($img, 0, 0, $zw, $zh)
$g2.Dispose(); $bmp2.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $bmp2.Dispose(); $img.Dispose()

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

Write-Output "===== WORDS (window-pixel center, /$Scale) ====="
foreach ($line in $result.Lines) {
  foreach ($word in $line.Words) {
    $rc = $word.BoundingRect
    $cx = [int](($rc.X + $rc.Width / 2) / $Scale)
    $cy = [int](($rc.Y + $rc.Height / 2) / $Scale)
    Write-Output ("{0,5},{1,5}  {2}" -f $cx, $cy, $word.Text)
  }
}
Write-Output "===== LINES ====="
foreach ($line in $result.Lines) {
  $t = ($line.Words | ForEach-Object { $_.Text }) -join ''
  $y = [int](($line.Words[0].BoundingRect.Y + $line.Words[0].BoundingRect.Height / 2) / $Scale)
  Write-Output ("y={0,4}  {1}" -f $y, $t)
}
