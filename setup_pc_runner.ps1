# Connects this PC to GitHub as a "self-hosted runner", so Amazon.in, Myntra and
# Blinkit are checked from this PC's internet connection (they block cloud servers).
#
# 1. GitHub -> your repository -> Settings -> Actions -> Runners -> New self-hosted runner
#    (choose Windows). Copy the token shown after  --token  in the "Configure" box.
# 2. In PowerShell run:
#       powershell -ExecutionPolicy Bypass -File "D:\Claude AI\price-tracker\setup_pc_runner.ps1" -Token PASTE_TOKEN_HERE
# 3. On GitHub: Settings -> Secrets and variables -> Actions -> Variables ->
#    New repository variable:  HOME_PC_RUNNER = on
#
# The runner then starts automatically each time you log in to Windows.
# The PC must be on (and logged in) for the Amazon / Myntra / Blinkit checks;
# if it is off, those checks wait and run when it is back (up to 24 hours).

param(
    [Parameter(Mandatory = $true)] [string] $Token,
    [string] $Repo = "https://github.com/vishalbansal1108/smartivity-price-tracker",
    [string] $RunnerDir = "D:\actions-runner"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path "$RunnerDir\config.cmd")) {
    throw "Runner files not found in $RunnerDir. Download actions-runner-win-x64 from https://github.com/actions/runner/releases and extract it there."
}

Push-Location $RunnerDir
try {
    & .\config.cmd --url $Repo --token $Token --name "$env:COMPUTERNAME-price-tracker" `
        --labels price-tracker --work _work --unattended --replace
    if ($LASTEXITCODE -ne 0) { throw "config.cmd failed (exit $LASTEXITCODE). The token may have expired - get a new one." }
} finally { Pop-Location }

# Start the runner at every Windows log-in, hidden, as this user (no admin rights needed)
$action   = New-ScheduledTaskAction -Execute "$RunnerDir\run.cmd" -WorkingDirectory $RunnerDir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "GitHub price-tracker runner" -Action $action -Trigger $trigger `
    -Settings $settings -Description "Runs Smartivity price checks for GitHub Actions" -Force | Out-Null
Start-ScheduledTask -TaskName "GitHub price-tracker runner"

Write-Host ""
Write-Host "Runner connected and started. Last step: on GitHub add the repository variable HOME_PC_RUNNER = on" -ForegroundColor Green
