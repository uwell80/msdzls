# 诊断脚本：截取 Flash 浏览器窗口并用 Windows 自带 OCR 把画面文字读成文本。
# 用途：无 GUI 视觉能力时，"读取"游戏画面上的文字（提示、按钮、报错）。
# 用法（务必用 Windows PowerShell 5.1，WinRT 互操作需要）：powershell.exe -NoProfile -File read-screen.ps1
#   可加 -ProcessNames FCBrowserManager 指定承载游戏的进程（默认按 SLBrowser/FCBrowser 顺序尝试）。
# 产物：同目录 _screen.png（画面截图）

param([string[]]$ProcessNames = @('SLBrowser', 'FCBrowserManager', 'FCBrowser'))

$ErrorActionPreference = "Stop"
$out = Join-Path $PSScriptRoot "_screen.png"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = $null
foreach ($name in $ProcessNames) {
    $proc = Get-Process $name -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) { Write-Output "window process=$($proc.ProcessName) id=$($proc.Id)"; break }
}
if (-not $proc) { Write-Output "game window not found (tried: $($ProcessNames -join ', '))"; exit 1 }

$h = $proc.MainWindowHandle
[W32]::ShowWindow($h, 9) | Out-Null
[W32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object W32+RECT
[W32]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Output "window rect=$($r.Left),$($r.Top) ${w}x${ht}"

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
# 优先用 PrintWindow(PW_RENDERFULLCONTENT=2) —— 即使窗口被遮挡也能抓自身内容
$hdc = $g.GetHdc()
$pw = [W32]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
if (-not $pw) {
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    Write-Output "PrintWindow failed; used screen capture"
} else {
    Write-Output "PrintWindow ok"
}
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved=$out size=$((Get-Item $out).Length)"

# ---- Windows.Media.Ocr ----
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($out)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output "OCR engine unavailable (no language pack)"; exit 2 }
Write-Output "ocr language=$($engine.RecognizerLanguage.LanguageTag)"

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
Write-Output "===== OCR TEXT BEGIN ====="
Write-Output $result.Text
Write-Output "===== OCR TEXT END ====="

# ---- 备用：屏幕截取（PrintWindow 抓不到 Flash 内容时用）。需要窗口在前台 ----
$out2 = Join-Path $PSScriptRoot "_screen2.png"
$bmp2 = New-Object System.Drawing.Bitmap($w, $ht)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp2.Size)
$bmp2.Save($out2, [System.Drawing.Imaging.ImageFormat]::Png)
$g2.Dispose()
$bmp2.Dispose()

$file2 = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($out2)) ([Windows.Storage.StorageFile])
$stream2 = Await ($file2.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder2 = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream2)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap2 = Await ($decoder2.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result2 = Await ($engine.RecognizeAsync($bitmap2)) ([Windows.Media.Ocr.OcrResult])
Write-Output "===== OCR SCREEN TEXT BEGIN ====="
Write-Output $result2.Text
Write-Output "===== OCR SCREEN TEXT END ====="
