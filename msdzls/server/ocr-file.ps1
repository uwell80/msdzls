# 对**已有图片**跑 Windows OCR（不做任何预处理），把每行的窗口像素坐标打出来。
# 用法: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr-file.ps1 -Path _prep.png [-Scale 3] [-OffX 0] [-OffY 0]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$Scale = 1.0,
  [int]$OffX = 0, [int]$OffY = 0
)
$ErrorActionPreference = "Stop"
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
$full = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $PSScriptRoot $Path }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
foreach ($line in $res.Lines) {
  $px = -1; $py = -1; $t = ""
  foreach ($wd in $line.Words) {
    if ($px -lt 0) { $rc = $wd.BoundingRect; $px = [int]($OffX + $rc.X / $Scale); $py = [int]($OffY + $rc.Y / $Scale) }
    $t += $wd.Text
  }
  if ($t -ne "") { Write-Output ("({0,4},{1,4})  {2}" -f $px, $py, $t) }
}
$stream.Dispose()
