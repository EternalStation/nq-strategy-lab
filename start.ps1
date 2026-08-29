$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
    throw 'Python environment is missing. Run the setup commands from README.md first.'
}

Start-Process -FilePath $python -ArgumentList '-m','uvicorn','server.main:app','--reload','--host','127.0.0.1','--port','8000' -WorkingDirectory $root -WindowStyle Hidden
Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -WorkingDirectory $root -WindowStyle Hidden

Write-Host 'NQ Strategy Lab is starting at http://127.0.0.1:5173'
