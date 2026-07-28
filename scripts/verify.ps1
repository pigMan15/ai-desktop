$ErrorActionPreference = "Stop"

function Invoke-NpmScript {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ScriptName
    )

    npm.cmd run $ScriptName
    if ($LASTEXITCODE -ne 0) {
        throw "npm script failed: $ScriptName"
    }
}

Invoke-NpmScript "test"
Invoke-NpmScript "test:runtime"
