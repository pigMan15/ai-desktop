$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $root ".workflow-platform"
$rendererLog = Join-Path $logDirectory "dev-renderer.log"
$rendererErrorLog = Join-Path $logDirectory "dev-renderer-error.log"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

# Electron executes apps/desktop/dist. Compile the main and preload processes
# before each development launch; Vite only serves renderer source files.
npm.cmd --workspace apps/desktop run build
if ($LASTEXITCODE -ne 0) {
    throw "Desktop build failed; development application was not started."
}

$renderer = Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run", "dev:renderer" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $rendererLog `
    -RedirectStandardError $rendererErrorLog `
    -PassThru

try {
    $deadline = (Get-Date).AddSeconds(30)
    $response = $null
    do {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                break
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    } while ((Get-Date) -lt $deadline)

    if (-not $response -or $response.StatusCode -ne 200) {
        throw "Renderer development server did not start within 30 seconds. See $rendererLog"
    }

    $electronExecutable = Join-Path $root "node_modules\electron\dist\electron.exe"
    if (-not (Test-Path -LiteralPath $electronExecutable)) {
        throw "Electron executable was not found at $electronExecutable."
    }

    & $electronExecutable (Join-Path $root "apps\desktop")
    $electronExitCode = $LASTEXITCODE
    if ($electronExitCode -ne 0) {
        throw "Electron development process exited with code $electronExitCode."
    }
} finally {
    # Electron may hand off to a child process and return before its window closes.
    # Keep Vite alive so that hand-off cannot leave the renderer URL blank.
}
