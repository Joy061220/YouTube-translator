$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ProjectRoot "local_server\.env.local"
$ExamplePath = Join-Path $ProjectRoot "local_server\.env.local.example"
$ServerPath = Join-Path $ProjectRoot "local_server\server.py"

Set-Location $ProjectRoot

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Copy-Item -LiteralPath $ExamplePath -Destination $ConfigPath
    Write-Host "首次运行：已创建 local_server\.env.local" -ForegroundColor Yellow
    Write-Host "请在打开的文件中填写 DEEPSEEK_API_KEY，保存后重新双击 start-server.cmd。" -ForegroundColor Yellow
    Start-Process notepad.exe -ArgumentList $ConfigPath
    exit 2
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "未找到 Python。请先安装 Python 3.11 或更高版本。" -ForegroundColor Red
    exit 1
}

python $ServerPath
