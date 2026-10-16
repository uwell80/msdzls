# 把画面切成重叠小格，每格放大后单独 OCR —— 小字整体 OCR 会糊，分块能救回来。
# 输出每段文字在**窗口像素**下的左上角坐标。
# 用法: powershell.exe -NoProfile -ExecutionPolicy Bypass -File tile-ocr.ps1 [-Name _screen.png] [-Scale 6] [-TileW 300] [-TileH 160] [-StepX 250] [-StepY 130]
param(
  [string]$Name = "_screen.png",
  [double]$Scale = 6.0,
  [int]$TileW = 300, [int]$TileH = 160,
  [int]$StepX = 250, [int]$StepY = 130,
  [int]$X0 = 0, [int]$Y0 = 90, [int]$X1 = 1200, [int]$Y1 = 525
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
$img = New-Object System.Drawing.Bitmap((Join-Path $PSScriptRoot $Name))
$tmp = Join-Path $PSScriptRoot "_tile.png"

for ($ty = $Y0; $ty -lt $Y1; $ty += $StepY) {
  for ($tx = $X0; $tx -lt $X1; $tx += $StepX) {
    $w = [Math]::Min($TileW, $img.Width - $tx)
    $h = [Math]::Min($TileH, $img.Height - $ty)
    if ($w -lt 40 -or $h -lt 30) { continue }
    $zw = [int]($w * $Scale); $zh = [int]($h * $Scale)
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
        if ($px -lt 0) { $rc = $wd.BoundingRect; $px = [int]($tx + $rc.X / $Scale); $py = [int]($ty + $rc.Y / $Scale) }
        $t += $wd.Text
      }
      if ($t -ne "") { Write-Output ("({0,4},{1,4})  {2}" -f $px, $py, $t) }
    }
  }
}
Remove-Item $tmp -ErrorAction SilentlyContinue
$img.Dispose()
