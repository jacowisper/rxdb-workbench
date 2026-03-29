$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Should-SuppressProgressLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $false
  }

  $trimmed = $Line.Trim()
  if (
    $trimmed -match "^[a-f0-9]{12}\s+(Downloading|Extracting|Pulling fs layer|Waiting)\s+\[" -or
    $trimmed -match "^\#\d+\s+\[[^\]]+\]\s+.+\s+[0-9.]+(kB|MB|GB)/[0-9.]+(kB|MB|GB)$" -or
    $trimmed -match "^\#\d+\s+.+\s+transferring\s+context:\s+[0-9.]+(B|kB|MB|GB)"
  ) {
    return $true
  }

  return $false
}

function Invoke-Process([string]$FileName, [string[]]$Arguments, [bool]$SuppressOutput = $false) {
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()

  try {
    $process = Start-Process -FilePath $FileName -ArgumentList $Arguments -NoNewWindow -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $stdoutIndex = 0
    $stderrIndex = 0
    $output = New-Object System.Collections.Generic.List[string]
    $lastProgressAt = [DateTime]::UtcNow
    $lastInlineProgress = ""
    $progressLineVisible = $false

    function Write-InlineProgress([string]$Text) {
      $script:lastInlineProgress = $Text
      $script:progressLineVisible = $true
      Write-Host ("`r" + $Text) -NoNewline
    }

    function Clear-InlineProgress() {
      if (-not $script:progressLineVisible) {
        return
      }
      $clear = " " * [Math]::Max(1, $script:lastInlineProgress.Length)
      Write-Host ("`r" + $clear + "`r") -NoNewline
      $script:progressLineVisible = $false
      $script:lastInlineProgress = ""
    }

    while (-not $process.HasExited) {
      $hadNewOutput = $false

      if (Test-Path -LiteralPath $stdoutFile) {
        $stdoutLines = Get-Content -LiteralPath $stdoutFile
        for ($i = $stdoutIndex; $i -lt $stdoutLines.Count; $i++) {
          $line = [string]$stdoutLines[$i]
          if (-not (Should-SuppressProgressLine -Line $line)) {
            Clear-InlineProgress
            if (-not $SuppressOutput) {
              Write-Host $line
            }
          } else {
            if (-not $SuppressOutput) {
              Write-InlineProgress "... downloading/building layers ..."
            }
          }
          $output.Add($line)
          $hadNewOutput = $true
        }
        $stdoutIndex = $stdoutLines.Count
      }

      if (Test-Path -LiteralPath $stderrFile) {
        $stderrLines = Get-Content -LiteralPath $stderrFile
        for ($i = $stderrIndex; $i -lt $stderrLines.Count; $i++) {
          $line = [string]$stderrLines[$i]
          if (-not (Should-SuppressProgressLine -Line $line)) {
            Clear-InlineProgress
            if (-not $SuppressOutput) {
              Write-Host $line
            }
          } else {
            if (-not $SuppressOutput) {
              Write-InlineProgress "... downloading/building layers ..."
            }
          }
          $output.Add($line)
          $hadNewOutput = $true
        }
        $stderrIndex = $stderrLines.Count
      }

      if ($hadNewOutput) {
        $lastProgressAt = [DateTime]::UtcNow
      } elseif (([DateTime]::UtcNow - $lastProgressAt).TotalSeconds -ge 15) {
        if (-not $SuppressOutput) {
          Write-InlineProgress "... still working (build/pull in progress) ..."
        }
        $lastProgressAt = [DateTime]::UtcNow
      }

      Start-Sleep -Milliseconds 400
    }
    $process.WaitForExit()

    if (Test-Path -LiteralPath $stdoutFile) {
      $stdoutLines = Get-Content -LiteralPath $stdoutFile
      for ($i = $stdoutIndex; $i -lt $stdoutLines.Count; $i++) {
        $line = [string]$stdoutLines[$i]
        if (-not (Should-SuppressProgressLine -Line $line)) {
          Clear-InlineProgress
          if (-not $SuppressOutput) {
            Write-Host $line
          }
        } else {
          if (-not $SuppressOutput) {
            Write-InlineProgress "... downloading/building layers ..."
          }
        }
        $output.Add($line)
      }
    }

    if (Test-Path -LiteralPath $stderrFile) {
      $stderrLines = Get-Content -LiteralPath $stderrFile
      for ($i = $stderrIndex; $i -lt $stderrLines.Count; $i++) {
        $line = [string]$stderrLines[$i]
        if (-not (Should-SuppressProgressLine -Line $line)) {
          Clear-InlineProgress
          if (-not $SuppressOutput) {
            Write-Host $line
          }
        } else {
          if (-not $SuppressOutput) {
            Write-InlineProgress "... downloading/building layers ..."
          }
        }
        $output.Add($line)
      }
    }

    if (-not $SuppressOutput) {
      Clear-InlineProgress
    }

    $exitCode = if ($null -eq $process.ExitCode) { 1 } else { [int]$process.ExitCode }

    return @{
      ExitCode = $exitCode
      Text = ($output.ToArray() -join "`n")
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

function Invoke-NativeChecked([string]$FileName, [string[]]$Arguments, [string]$FailureMessage) {
  $output = (& $FileName @Arguments 2>&1 | ForEach-Object { "$_" })
  if ($output) {
    $output | ForEach-Object { Write-Host $_ }
  }

  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code $LASTEXITCODE)."
  }
}

function Get-RunningComposeServices() {
  $result = Invoke-Process -FileName "docker" -Arguments @("compose", "ps", "--services", "--filter", "status=running") -SuppressOutput $true
  if ($result.ExitCode -ne 0) {
    return @()
  }

  return @(
    $result.Text -split "`r?`n" |
      ForEach-Object { ($_ -replace "\x1b\[[0-9;]*m", "").Trim().ToLowerInvariant() } |
      Where-Object { $_ -ne "" }
  )
}

function RequiredServicesRunning() {
  $running = @(Get-RunningComposeServices)
  if ($running.Count -eq 0) {
    return $false
  }

  $required = @("mongodb", "backend", "frontend")
  foreach ($service in $required) {
    if (-not ($running -contains $service)) {
      return $false
    }
  }

  return $true
}

function ComposeOutputShowsServicesStarted([string]$ComposeText) {
  if ([string]::IsNullOrWhiteSpace($ComposeText)) {
    return $false
  }

  $backendOk = $ComposeText -match [Regex]::Escape("Container rxdb-workbench-backend Started")
  $frontendOk = $ComposeText -match [Regex]::Escape("Container rxdb-workbench-frontend Started")
  $mongoOk =
    $ComposeText -match [Regex]::Escape("Container modest_shirley Started") -or
    $ComposeText -match [Regex]::Escape("Container modest_shirley Running")

  return ($backendOk -and $frontendOk -and $mongoOk)
}

function Wait-ForRequiredServicesRunning([int]$TimeoutSeconds = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (RequiredServicesRunning) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Save-ComposeOutputLog([string]$Content, [string]$Reason) {
  try {
    $logsDir = Join-Path $repoRoot "scripts\windows\logs"
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    $timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $filePath = Join-Path $logsDir "compose-up-$timestamp.log"
    $header = @(
      "Reason: $Reason"
      "GeneratedAt: $((Get-Date).ToString('o'))"
      ""
      "---- docker compose up output ----"
      $Content
    ) -join "`r`n"
    Set-Content -LiteralPath $filePath -Value $header -Encoding UTF8
    return $filePath
  } catch {
    return ""
  }
}

function Parse-EnvFile([string]$Path) {
  $values = @{}
  if (!(Test-Path -LiteralPath $Path)) {
    return $values
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith("#")) {
      return
    }

    $eq = $line.IndexOf("=")
    if ($eq -lt 1) {
      return
    }

    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1)
    $values[$key] = $value
  }

  return $values
}

function Prompt-Default([string]$Prompt, [string]$Default) {
  $input = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($input)) {
    return $Default
  }
  return $input.Trim()
}

function Prompt-Optional([string]$Prompt, [string]$Default) {
  $input = Read-Host "$Prompt [$Default] (press Enter to keep, type NONE for blank)"
  if ([string]::IsNullOrWhiteSpace($input)) {
    return $Default
  }

  if ($input.Trim().ToUpperInvariant() -eq "NONE") {
    return ""
  }

  return $input.Trim()
}

function Wait-ForHttp([string]$Url, [string]$Method = "GET", $Headers = $null, [int]$TimeoutSeconds = 120) {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    try {
      if ($Headers -ne $null) {
        $response = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -UseBasicParsing -TimeoutSec 5
      } else {
        $response = Invoke-WebRequest -Uri $Url -Method $Method -UseBasicParsing -TimeoutSec 5
      }
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

function Is-PortAvailable([int]$Port) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener -ne $null) {
      $listener.Stop()
    }
  }
}

function Prompt-AvailablePort([string]$Label, [string]$DefaultValue) {
  $value = Prompt-Default $Label $DefaultValue
  while ($true) {
    $port = 0
    if (-not [int]::TryParse($value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
      $value = Read-Host "$Label must be a number between 1 and 65535. Enter a new value"
      continue
    }

    if (Is-PortAvailable $port) {
      return [string]$port
    }

    $value = Read-Host "Port $port is already in use. Enter a different $Label"
  }
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
  Set-Location $repoRoot

  Write-Step "Checking Docker availability"
  Invoke-NativeChecked "docker" @("version") "Docker is not available"
  Invoke-NativeChecked "docker" @("compose", "version") "Docker Compose is not available"

  $envPath = Join-Path $repoRoot ".env"
  $existing = Parse-EnvFile $envPath

  $defaults = @{
    RXDB_PREMIUM = ""
    BACKEND_GITHUB_SERVER_SCHEMAS_URL = ""
    BACKEND_TOKEN = "85533878a62652c01f764ba4d7e154ddaf6e7"
    BACKEND_PORT = "4000"
    BACKEND_DEFAULT_WEBSOCKET_PORT = "4001"
    BACKEND_JSON_BODY_LIMIT = "10mb"
    FRONTEND_PORT = "8080"
    MONGO_PORT = "27017"
    MONGO_INITDB_ROOT_USERNAME = "rxdbadmin"
    MONGO_INITDB_ROOT_PASSWORD = "rxdbpass"
    MONGO_INITDB_DATABASE = "rxdb-workbench"
  }

  foreach ($key in @($defaults.Keys)) {
    if ($existing.ContainsKey($key) -and $existing[$key] -ne $null -and $existing[$key] -ne "") {
      $defaults[$key] = [string]$existing[$key]
    }
  }
  if ($existing.ContainsKey("BACKEND_GITHUB_SERVER_SCHEMAS_URL")) {
    $defaults["BACKEND_GITHUB_SERVER_SCHEMAS_URL"] = [string]$existing["BACKEND_GITHUB_SERVER_SCHEMAS_URL"]
  }

  Write-Step "Configuring environment"
  Write-Host "Leave blank to keep defaults."
  Write-Host "RXDB premium key is optional. Type NONE if you want no premium key."
  $defaults["RXDB_PREMIUM"] = Prompt-Optional "RXDB_PREMIUM (optional)" $defaults["RXDB_PREMIUM"]
  $defaults["BACKEND_PORT"] = Prompt-AvailablePort "BACKEND_PORT" $defaults["BACKEND_PORT"]
  $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"] = Prompt-AvailablePort "BACKEND_DEFAULT_WEBSOCKET_PORT" $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"]
  $defaults["FRONTEND_PORT"] = Prompt-AvailablePort "FRONTEND_PORT" $defaults["FRONTEND_PORT"]
  $defaults["MONGO_PORT"] = Prompt-AvailablePort "MONGO_PORT" $defaults["MONGO_PORT"]
  $defaults["MONGO_INITDB_ROOT_USERNAME"] = Prompt-Default "MONGO_INITDB_ROOT_USERNAME" $defaults["MONGO_INITDB_ROOT_USERNAME"]
  $defaults["MONGO_INITDB_ROOT_PASSWORD"] = Prompt-Default "MONGO_INITDB_ROOT_PASSWORD" $defaults["MONGO_INITDB_ROOT_PASSWORD"]

  while (
    $defaults["BACKEND_PORT"] -eq $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"] -or
    $defaults["BACKEND_PORT"] -eq $defaults["FRONTEND_PORT"] -or
    $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"] -eq $defaults["FRONTEND_PORT"] -or
    $defaults["BACKEND_PORT"] -eq $defaults["MONGO_PORT"] -or
    $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"] -eq $defaults["MONGO_PORT"] -or
    $defaults["FRONTEND_PORT"] -eq $defaults["MONGO_PORT"]
  ) {
    Write-Host "Ports must be unique across backend, websocket, frontend, and mongo." -ForegroundColor Yellow
    $defaults["BACKEND_PORT"] = Prompt-AvailablePort "BACKEND_PORT" $defaults["BACKEND_PORT"]
    $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"] = Prompt-AvailablePort "BACKEND_DEFAULT_WEBSOCKET_PORT" $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"]
    $defaults["FRONTEND_PORT"] = Prompt-AvailablePort "FRONTEND_PORT" $defaults["FRONTEND_PORT"]
    $defaults["MONGO_PORT"] = Prompt-AvailablePort "MONGO_PORT" $defaults["MONGO_PORT"]
  }

  $defaults["VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN"] = $defaults["BACKEND_TOKEN"]
  $defaults["VITE_FRONTEND_TO_USE_BACKEND_URL"] = "http://localhost:$($defaults["BACKEND_PORT"])"
  $defaults["VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT"] = $defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"]
  $encodedMongoUser = [System.Uri]::EscapeDataString($defaults["MONGO_INITDB_ROOT_USERNAME"])
  $encodedMongoPassword = [System.Uri]::EscapeDataString($defaults["MONGO_INITDB_ROOT_PASSWORD"])
  $mongoConnectionString = "mongodb://$encodedMongoUser`:$encodedMongoPassword@mongodb:27017/$($defaults["MONGO_INITDB_DATABASE"])?authSource=admin"
  $defaults["BACKEND_DEFAULT_MONGODB_CONNECTION_STRING"] = $mongoConnectionString
  $defaults["VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING"] = $mongoConnectionString

  $managedEnvKeys = @(
    "RXDB_PREMIUM",
    "BACKEND_GITHUB_SERVER_SCHEMAS_URL",
    "BACKEND_TOKEN",
    "BACKEND_PORT",
    "BACKEND_DEFAULT_WEBSOCKET_PORT",
    "BACKEND_JSON_BODY_LIMIT",
    "VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN",
    "VITE_FRONTEND_TO_USE_BACKEND_URL",
    "VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT",
    "VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING",
    "BACKEND_DEFAULT_MONGODB_CONNECTION_STRING",
    "FRONTEND_PORT",
    "MONGO_PORT",
    "MONGO_INITDB_ROOT_USERNAME",
    "MONGO_INITDB_ROOT_PASSWORD",
    "MONGO_INITDB_DATABASE"
  )

  $envLines = @(
    "RXDB_PREMIUM=$($defaults["RXDB_PREMIUM"])",
    "BACKEND_GITHUB_SERVER_SCHEMAS_URL=$($defaults["BACKEND_GITHUB_SERVER_SCHEMAS_URL"])",
    "BACKEND_TOKEN=$($defaults["BACKEND_TOKEN"])",
    "BACKEND_PORT=$($defaults["BACKEND_PORT"])",
    "BACKEND_DEFAULT_WEBSOCKET_PORT=$($defaults["BACKEND_DEFAULT_WEBSOCKET_PORT"])",
    "BACKEND_JSON_BODY_LIMIT=$($defaults["BACKEND_JSON_BODY_LIMIT"])",
    "VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN=$($defaults["VITE_FRONTEND_TO_USE_FORBACKEND_TOKEN"])",
    "VITE_FRONTEND_TO_USE_BACKEND_URL=$($defaults["VITE_FRONTEND_TO_USE_BACKEND_URL"])",
    "VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT=$($defaults["VITE_FRONTEND_TO_USE_BACKEND_WEBSOCKET_PORT"])",
    "VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING=$($defaults["VITE_FRONTEND_DEFAULT_MONGODB_CONNECTION_STRING"])",
    "BACKEND_DEFAULT_MONGODB_CONNECTION_STRING=$($defaults["BACKEND_DEFAULT_MONGODB_CONNECTION_STRING"])",
    "FRONTEND_PORT=$($defaults["FRONTEND_PORT"])",
    "MONGO_PORT=$($defaults["MONGO_PORT"])",
    "MONGO_INITDB_ROOT_USERNAME=$($defaults["MONGO_INITDB_ROOT_USERNAME"])",
    "MONGO_INITDB_ROOT_PASSWORD=$($defaults["MONGO_INITDB_ROOT_PASSWORD"])",
    "MONGO_INITDB_DATABASE=$($defaults["MONGO_INITDB_DATABASE"])"
  )

  $preservedKeys = @(
    $existing.Keys |
      Where-Object { $managedEnvKeys -notcontains [string]$_ } |
      Sort-Object
  )
  foreach ($key in $preservedKeys) {
    $envLines += "$key=$($existing[$key])"
  }

  Set-Content -LiteralPath $envPath -Value $envLines -Encoding ASCII
  Write-Host "Wrote $envPath"
  if ($preservedKeys.Count -gt 0) {
    Write-Host "Preserved additional .env keys: $($preservedKeys -join ", ")"
  }

  Write-Step "Building and starting containers"
  $composeResult = Invoke-Process -FileName "docker" -Arguments @("compose", "--progress", "plain", "up", "-d", "--build")
  if ($composeResult.ExitCode -ne 0) {
    if ($composeResult.Text -match "failed to prepare extraction snapshot" -or $composeResult.Text -match "parent snapshot .* does not exist") {
      Write-Step "Detected Docker cache snapshot issue; pruning build cache and retrying once"
      Invoke-ExternalChecked "docker" @("buildx", "prune", "-af") "docker buildx prune failed" | Out-Null
      $retryResult = Invoke-Process -FileName "docker" -Arguments @("compose", "--progress", "plain", "up", "-d", "--build")
      if ($retryResult.ExitCode -ne 0) {
        if ((Wait-ForRequiredServicesRunning) -or (ComposeOutputShowsServicesStarted -ComposeText $retryResult.Text)) {
          Write-Host "Warning: docker compose returned exit code $($retryResult.ExitCode), but all services are running." -ForegroundColor Yellow
          $logPath = Save-ComposeOutputLog -Content $retryResult.Text -Reason "compose-up exit code non-zero after retry; services running"
          if ($logPath) {
            Write-Host "Details saved to: $logPath" -ForegroundColor Yellow
          }
        } else {
          throw "docker compose up failed after retry (exit code $($retryResult.ExitCode))."
        }
      }
    } else {
      if ((Wait-ForRequiredServicesRunning) -or (ComposeOutputShowsServicesStarted -ComposeText $composeResult.Text)) {
        Write-Host "Warning: docker compose returned exit code $($composeResult.ExitCode), but all services are running." -ForegroundColor Yellow
        $logPath = Save-ComposeOutputLog -Content $composeResult.Text -Reason "compose-up exit code non-zero; services running"
        if ($logPath) {
          Write-Host "Details saved to: $logPath" -ForegroundColor Yellow
        }
      } else {
        throw "docker compose up failed (exit code $($composeResult.ExitCode))."
      }
    }
  }

  $frontendUrl = "http://localhost:$($defaults["FRONTEND_PORT"])"
  $backendHealthUrl = "http://localhost:$($defaults["BACKEND_PORT"])/api/health"
  $backendHeaders = @{ Authorization = "Bearer $($defaults["BACKEND_TOKEN"])" }

  Write-Step "Waiting for services"
  $backendReady = Wait-ForHttp $backendHealthUrl "POST" $backendHeaders 120
  $frontendReady = Wait-ForHttp $frontendUrl "GET" $null 120

  Write-Step "Result"
  if ($backendReady -and $frontendReady) {
    Write-Host "Backend is reachable at $backendHealthUrl" -ForegroundColor Green
    Write-Host "Frontend is reachable at $frontendUrl" -ForegroundColor Green
    Write-Host "MongoDB is exposed at mongodb://localhost:$($defaults["MONGO_PORT"])" -ForegroundColor Green
    Write-Host "MongoDB auth user: $($defaults["MONGO_INITDB_ROOT_USERNAME"])" -ForegroundColor Green
    Write-Host "App default Mongo connection string uses: mongodb://<user>:<password>@mongodb:27017/<db>?authSource=admin" -ForegroundColor Green
  } else {
    Write-Host "Services started, but one or more health checks timed out." -ForegroundColor Yellow
    Write-Host "Frontend URL: $frontendUrl"
    Write-Host "Backend URL:  $backendHealthUrl"
  }

  Write-Host ""
  $psResult = Invoke-Process -FileName "docker" -Arguments @("compose", "ps")
  if ($psResult.ExitCode -ne 0 -and -not (RequiredServicesRunning)) {
    Write-Host "Warning: docker compose ps returned exit code $($psResult.ExitCode)." -ForegroundColor Yellow
    $psLogPath = Save-ComposeOutputLog -Content $psResult.Text -Reason "compose-ps non-zero exit code after successful startup checks"
    if ($psLogPath) {
      Write-Host "Details saved to: $psLogPath" -ForegroundColor Yellow
    }
  }
  Write-Host ""
  Write-Host "Opening frontend in your default browser..."
  Start-Process $frontendUrl | Out-Null
} catch {
  Write-Host ""
  Write-Host "Installation/start failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to close"
