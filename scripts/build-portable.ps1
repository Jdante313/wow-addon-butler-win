# 构建便携版（Windows PowerShell）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $releaseRoot = Join-Path $root 'release'
  $appDir = Join-Path $releaseRoot '魔兽插件管家'
  if (Test-Path $releaseRoot) { Remove-Item $releaseRoot -Recurse -Force }
  New-Item -ItemType Directory -Force $appDir | Out-Null

  # 编译启动器
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { throw '找不到 .NET Framework 4 csc.exe' }
  & $csc /nologo /target:winexe /optimize+ /out:"$root\WowAddonButler.exe" /win32icon:"$root\assets\icon.ico" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Management.dll "$root\launcher\Program.cs" "$root\launcher\AssemblyInfo.cs"
  if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }

  Copy-Item "$root\WowAddonButler.exe" "$appDir\魔兽插件管家.exe" -Force
  Copy-Item "$root\README.md" "$appDir\使用说明.md" -Force
  Copy-Item "$root\CHANGELOG.md" "$appDir\更新记录.md" -Force
  Copy-Item "$root\LICENSE" "$appDir\LICENSE" -Force
  Copy-Item "$root\package.json" "$appDir\package.json" -Force
  Copy-Item "$root\assets" "$appDir\assets" -Recurse -Force
  Copy-Item "$root\renderer" "$appDir\renderer" -Recurse -Force
  Copy-Item "$root\server" "$appDir\server" -Recurse -Force
  New-Item -ItemType Directory -Force "$appDir\node" | Out-Null
  $nodeExe = Join-Path $root 'node\node.exe'
  if (-not (Test-Path $nodeExe)) {
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
  }
  if (-not (Test-Path $nodeExe)) {
    throw '缺少 Node 运行时：请把 node.exe 放到 node\node.exe，或安装 Node.js 并加入 PATH'
  }
  Copy-Item $nodeExe "$appDir\node\node.exe" -Force
  New-Item -ItemType Directory -Force "$appDir\node_modules" | Out-Null
  Copy-Item "$root\node_modules\adm-zip" "$appDir\node_modules\adm-zip" -Recurse -Force

  # 带截图的功能手册（如果已生成）
  $manualPdf = Join-Path $root 'manual\魔兽插件管家-功能手册.pdf'
  $manualDocx = Join-Path $root 'manual\魔兽插件管家-功能手册.docx'
  if (Test-Path $manualPdf) { Copy-Item $manualPdf "$appDir\功能手册.pdf" -Force }
  if (Test-Path $manualDocx) { Copy-Item $manualDocx "$appDir\功能手册.docx" -Force }

  # 清理开发文件
  Get-ChildItem $appDir -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem $appDir -Recurse -File -Include '*.test.js','*.log' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  $zip = Join-Path $releaseRoot '魔兽插件管家-便携版.zip'
  Compress-Archive -Path "$appDir\*" -DestinationPath $zip -CompressionLevel Optimal
  $stableZip = Join-Path $releaseRoot 'WoWAddonButler-Windows-x64.zip'
  Copy-Item $zip $stableZip -Force
  Write-Host "构建完成：$appDir"
  Write-Host "压缩包：$zip"
  Write-Host "固定下载文件名：$stableZip"
} finally {
  Pop-Location
}
