# 对**已预处理**的图片分块 OCR。坐标换算回窗口像素：window = off + img/Scale。
# 用法: powershell.exe -NoProfile -ExecutionPolicy Bypass -File tile-ocr2.ps1 -Path _prep.png -Scale 2.5 -OffX 130 -OffY 105 -TileW 700 -TileH 400 -StepX 600 -StepY 340
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$Scale = 1.0,
  [int]$OffX = 0, [int]$OffY = 0,
  [int]$TileW = 700, [int]$TileH = 400,
  [int]$StepX = 600, [int]$StepY = 340,
  [double]$Sub = 1.0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
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
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$full = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $PSScriptRoot $Path }
$img = New-Object System.Drawing.Bitmap($full)
$tmp = Join-Path $PSScriptRoot "_tile2.png"
for ($ty = 0; $ty -lt $img.Height; $ty += $StepY) {
  for ($tx = 0; $tx -lt $img.Width; $tx += $StepX) {
    $w = [Math]::Min($TileW, $img.Width - $tx)
    $h = [Math]::Min($TileH, $img.Height - $ty)
    if ($w -lt 60 -or $h -lt 40) { continue }
    $zw = [int]($w * $Sub); $zh = [int]($h * $Sub)
    $bmp = New-Object System.Drawing.Bitmap($zw, $zh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0,0,$zw,$zh)), (New-Object System.Drawing.Rectangle($tx,$ty,$w,$h)), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    foreach ($line in $res.Lines) {
      $px = -1; $py = -1; $t = ""
      foreach ($wd in $line.Words) {
        if ($px -lt 0) {
          $rc = $wd.BoundingRect
          $px = [int]($OffX + ($tx + $rc.X / $Sub) / $Scale)
          $py = [int]($OffY + ($ty + $rc.Y / $Sub) / $Scale)
        }
        $t += $wd.Text
      }
      if ($t -ne "") { Write-Output ("({0,4},{1,4})  {2}" -f $px, $py, $t) }
    }
  }
}
Remove-Item $tmp -ErrorAction SilentlyContinue
$img.Dispose()
