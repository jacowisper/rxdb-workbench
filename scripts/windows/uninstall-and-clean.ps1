$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Process([string]$FileName, [string[]]$Arguments) {
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()

  try {
    $process = Start-Process -FilePath $FileName -ArgumentList $Arguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $output = @()
    if (Test-Path -LiteralPath $stdoutFile) {
      $output += Get-Content -LiteralPath $stdoutFile
    }
    if (Test-Path -LiteralPath $stderrFile) {
      $output += Get-Content -LiteralPath $stderrFile
    }

    if ($output) {
      $output | ForEach-Object { Write-Host $_ }
    }

    return @{
      ExitCode = $process.ExitCode
      Text = ($output -join "`n")
    }
  } finally {
    Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-ExternalChecked([string]$FileName, [string[]]$Arguments, [string]$FailureMessage) {
  $result = Invoke-Process -FileName $FileName -Arguments $Arguments
  if ($result.ExitCode -ne 0) {
    throw "$FailureMessage (exit code $($result.ExitCode))."
  }
  return $result.Text
}

function Invoke-ExternalBestEffort([string]$FileName, [string[]]$Arguments) {
  $null = Invoke-Process -FileName $FileName -Arguments $Arguments
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
  Set-Location $repoRoot

  Write-Step "Checking Docker availability"
  Invoke-ExternalChecked "docker" @("version") "Docker is not available" | Out-Null
  Invoke-ExternalChecked "docker" @("compose", "version") "Docker Compose is not available" | Out-Null

  Write-Host ""
  Write-Host "This will remove RXDB Server Workbench containers, volumes, images, and build cache." -ForegroundColor Yellow
  $confirmation = Read-Host "Type REMOVE to continue"
  if ($confirmation -ne "REMOVE") {
    Write-Host "Cancelled."
    exit 0
  }

  Write-Step "Stopping stack and removing compose resources"
  Invoke-ExternalBestEffort "docker" @("compose", "down", "--volumes", "--rmi", "all", "--remove-orphans")

  Write-Step "Removing known containers (if any remain)"
  Invoke-ExternalBestEffort "docker" @("rm", "-f", "rxdb-workbench-frontend", "rxdb-workbench-backend", "modest_shirley")

  Write-Step "Removing known volumes (if any remain)"
  Invoke-ExternalBestEffort "docker" @("volume", "rm", "rxdb-server-workbench_backend-data", "rxdb-server-workbench_mongo-data")

  Write-Step "Removing known images (if any remain)"
  Invoke-ExternalBestEffort "docker" @("image", "rm", "-f", "rxdb-server-workbench-frontend:latest", "rxdb-server-workbench-backend:latest")

  Write-Step "Pruning build cache"
  Invoke-ExternalBestEffort "docker" @("buildx", "prune", "-af")

  Write-Step "Removing local environment file"
  $envPath = Join-Path $repoRoot ".env"
  if (Test-Path -LiteralPath $envPath) {
    Remove-Item -LiteralPath $envPath -Force -ErrorAction SilentlyContinue
    Write-Host "Removed $envPath"
  } else {
    Write-Host ".env not found; skipping."
  }

  Write-Step "Result"
  Invoke-ExternalBestEffort "docker" @("compose", "ps")
  Write-Host "Uninstall and cleanup completed." -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host "Uninstall/cleanup failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to close"
