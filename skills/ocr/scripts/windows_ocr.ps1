# Windows 系统自带 OCR（Windows.Media.Ocr）
# 用法: powershell -ExecutionPolicy Bypass -File windows_ocr.ps1 <图片路径>
# 依赖: Windows 10/11 内置引擎，零安装。中文支持需系统已安装中文语言包（中文版系统自带）。
param([Parameter(Mandatory=$true)][string]$ImagePath)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Error "Image not found: $ImagePath"
    exit 1
}
# WinRT 的 GetFileFromPathAsync 要求绝对路径（Test-Path 通过后才 Resolve）
$ImagePath = (Resolve-Path -LiteralPath $ImagePath).Path

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT async -> .NET Task 辅助函数
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

# 加载文件
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])

# 解码为位图
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

# OCR
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
    Write-Error "Failed to create OCR engine (language pack may be missing)"
    exit 1
}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

# 输出文本（带行号）
$lineNum = 1
foreach ($line in $result.Lines) {
    Write-Output ("[{0}] {1}" -f $lineNum, $line.Text)
    $lineNum++
}
