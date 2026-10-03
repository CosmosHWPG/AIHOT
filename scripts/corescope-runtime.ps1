param(
    [ValidateSet('Start', 'Stop', 'Status', 'Database', 'Install')][string]$Action = 'Start',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeDir = Join-Path $ProjectRoot '.data\runtime'
$LogDir = Join-Path $ProjectRoot '.data\logs'
$PgRoot = Join-Path $RuntimeDir 'pgsql'
$PgData = Join-Path $RuntimeDir 'postgres-data'
$StateFile = Join-Path $RuntimeDir 'processes.json'
$EnvFile = Join-Path $ProjectRoot '.env'
$Node = $null
$SupervisorEntry = Join-Path $ProjectRoot 'scripts\corescope-runtime.ts'
$DownloadUrl = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip'
$Archive = Join-Path $RuntimeDir 'postgresql-17.11-3-windows-x64-binaries.zip'
$PgPort = 5448
$WebPort = 8780
$ApiPort = 8781
$StartupLog = Join-Path $LogDir 'startup.log'
$StartupErrorLog = Join-Path $LogDir 'startup.error.log'
$script:StartupPhase = 'initialize'
$script:Config = $null
$script:DbPassword = $null

function Protect-LogText([string]$Text) {
    if ($script:Config) {
        foreach ($property in $script:Config.PSObject.Properties) {
            if ($property.Name -match '(?i)(API_KEY|PASSWORD|SECRET|TOKEN|^DATABASE_URL$)') {
                $value = [string]$property.Value
                if ($value.Length -ge 4) { $Text = $Text.Replace($value, '[redacted]') }
            }
        }
    }
    if ($script:DbPassword -and $script:DbPassword.Length -ge 4) { $Text = $Text.Replace($script:DbPassword, '[redacted]') }
    $Text = [regex]::Replace($Text, '(?i)((?:postgres(?:ql)?|https?)://)[^/\s:@]+:[^@\s/]+@', '$1[redacted]@')
    return [regex]::Replace($Text, '(?i)(Bearer\s+)\S+', '$1[redacted]')
}

function Write-RuntimeLog([string]$Level, [string]$Message, [switch]$Failure) {
    $record = [ordered]@{
        at = [DateTimeOffset]::Now.ToString('o')
        action = $Action
        phase = $script:StartupPhase
        level = $Level
        message = (Protect-LogText $Message)
    }
    $line = ($record | ConvertTo-Json -Compress) + [Environment]::NewLine
    [IO.File]::AppendAllText($StartupLog, $line, (New-Object Text.UTF8Encoding($false)))
    if ($Failure) { [IO.File]::AppendAllText($StartupErrorLog, $line, (New-Object Text.UTF8Encoding($false))) }
}

function Write-Stage([string]$Phase, [string]$Message) {
    $script:StartupPhase = $Phase
    Write-Host ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Phase.ToUpperInvariant(), $Message)
    Write-RuntimeLog 'info' $Message
}

function Assert-ProjectPath([string]$Target) {
    $resolved = [IO.Path]::GetFullPath($Target)
    if (-not $resolved.StartsWith($ProjectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runtime path must stay inside this project.'
    }
}

function Read-Config {
    $versionText = & $Node --version
    if ([Version]$versionText.TrimStart('v') -lt [Version]'24.11.0') { throw 'Install Node.js 24.11 or newer before starting CoreScope.' }
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Create the private .env configuration first (see docs/CORESCOPE_LOCAL.md).' }
    $raw = & $Node -e "const fs=require('node:fs');const{parseEnv}=require('node:util');process.stdout.write(JSON.stringify(parseEnv(fs.readFileSync(process.argv[1],'utf8'))));" $EnvFile
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read local .env configuration.' }
    $script:Config = $raw | ConvertFrom-Json
    if ($Config.PSObject.Properties['DEV_AUTH_ROLE']) { throw 'Remove DEV_AUTH_ROLE; this system uses the real administrator login.' }
    $db = [Uri]$Config.DATABASE_URL
    if ($db.Host -notin @('127.0.0.1', 'localhost') -or $db.Port -ne $PgPort) { throw 'Local runtime requires DATABASE_URL on 127.0.0.1:5448.' }
    $script:DbName = [Uri]::UnescapeDataString($db.AbsolutePath.Trim('/'))
    if ($DbName -ne 'corescope') { throw 'This launcher only manages the independent corescope database.' }
    $script:DbUser = [Uri]::UnescapeDataString($db.UserInfo.Split(':')[0])
    $script:DbPassword = [Uri]::UnescapeDataString(($db.UserInfo.Split(':', 2) | Select-Object -Last 1))
    if ($DbUser -ne 'corescope' -or -not $DbPassword -or $DbPassword -eq $DbUser) { throw 'Set an independent corescope database user and random password.' }
    if ([int]$Config.WEB_PORT -ne $WebPort -or [int]$Config.API_PORT -ne $ApiPort) { throw 'Local runtime requires WEB_PORT=8780 and API_PORT=8781.' }
}

function Invoke-NodeScript([string]$RelativePath, [string[]]$ExtraArgs = @()) {
    Push-Location $ProjectRoot
    $previousPreference = $ErrorActionPreference
    $diagnostics = New-Object 'System.Collections.Generic.List[string]'
    try {
        # In Windows PowerShell 5.1 native stderr is an ErrorRecord. Capture it without losing
        # the actual child exit code, while keeping credentials out of console and logs.
        $ErrorActionPreference = 'Continue'
        & $Node "--env-file=$EnvFile" (Join-Path $ProjectRoot $RelativePath) @ExtraArgs 2>&1 | ForEach-Object {
            $line = Protect-LogText ([string]$_)
            Write-Host $line
            $bounded = $line.Substring(0, [Math]::Min(2000, $line.Length))
            if ($diagnostics.Count -lt 4 -and $bounded -match '(?i)(Error|exception|out of memory|failed|refusing|missing)') { $diagnostics.Add($bounded) }
            Write-RuntimeLog 'output' $bounded
        }
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        if ($exitCode -ne 0) {
            $diagnostic = $diagnostics.ToArray() -join ' | '
            if (-not $diagnostic) { $diagnostic = 'See startup.log for the child output.' }
            throw "$RelativePath failed (exit $exitCode): $diagnostic"
        }
    } finally { $ErrorActionPreference = $previousPreference; Pop-Location }
}

function Test-OwnedProcess($Record, [string]$ExpectedEntry) {
    if (-not $Record -or -not $Record.pid) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Record.pid)" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.CommandLine) { return $false }
    if (-not $proc.CommandLine.Contains($ExpectedEntry)) { return $false }
    if ($Record.startedAt) {
        $recorded = [DateTimeOffset]::Parse($Record.startedAt).UtcDateTime
        $created = $proc.CreationDate.ToUniversalTime()
        if ([Math]::Abs(($recorded - $created).TotalSeconds) -gt 5) { return $false }
    }
    return $true
}

function Get-SupervisorState {
    if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
    try {
        $saved = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([IO.Path]::GetFullPath($saved.root) -ne $ProjectRoot) { return $null }
        if (-not (Test-OwnedProcess $saved.supervisor $SupervisorEntry)) { return $null }
        return $saved
    } catch { return $null }
}

function Assert-PortFree([int]$Port, [int]$AllowedPid = 0) {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -ne $AllowedPid) { throw "Port $Port belongs to another process. No process was stopped; choose a free port or resolve the conflict." }
    }
}

function Get-OwnedPostgresPid {
    $pidFile = Join-Path $PgData 'postmaster.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return 0 }
    $lines = Get-Content -LiteralPath $pidFile -Encoding UTF8
    if ($lines.Count -lt 2) { return 0 }
    $pgPid = 0
    if (-not [int]::TryParse($lines[0], [ref]$pgPid)) { return 0 }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pgPid" -ErrorAction SilentlyContinue
    $expectedExe = Join-Path $PgRoot 'bin\postgres.exe'
    if (-not $proc -or -not $proc.ExecutablePath -or [IO.Path]::GetFullPath($proc.ExecutablePath) -ne $expectedExe) { return 0 }
    if (-not $proc.CommandLine -or -not $proc.CommandLine.Replace('/', '\').Contains($PgData)) { return 0 }
    if ([IO.Path]::GetFullPath($lines[1]) -ne $PgData) { return 0 }
    return $pgPid
}

function Install-Postgres {
    if (Test-Path -LiteralPath (Join-Path $PgRoot 'bin\postgres.exe')) { return }
    Assert-ProjectPath $Archive
    Write-Host 'Downloading portable PostgreSQL 17.11 from the official EDB distribution...'
    if (-not (Test-Path -LiteralPath $Archive) -or (Get-Item -LiteralPath $Archive).Length -ne 341325378) {
        $partial = $Archive + '.partial'
        $rangeFile = $Archive + '.range'
        $downloaded = 0L
        if (Test-Path -LiteralPath $partial) { $downloaded = (Get-Item -LiteralPath $partial).Length }
        if ($downloaded -gt 341325378) { throw 'Partial PostgreSQL download is larger than its distribution; inspect .data/runtime before retrying.' }
        while ($downloaded -lt 341325378) {
            # Smaller range requests avoid CDN/proxy stalls on the 325 MB single connection.
            $lastByte = [Math]::Min($downloaded + 33554432 - 1, 341325378 - 1)
            & curl.exe --fail --silent --show-error --location --retry 3 --connect-timeout 30 --max-time 180 --range "$downloaded-$lastByte" --output $rangeFile $DownloadUrl
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL download failed. Re-run Start-CoreScope.cmd to resume completed ranges.' }
            if ((Get-Item -LiteralPath $rangeFile).Length -ne ($lastByte - $downloaded + 1)) { throw 'PostgreSQL download server did not return the expected byte range.' }
            $destination = [IO.File]::Open($partial, [IO.FileMode]::Append, [IO.FileAccess]::Write)
            $source = [IO.File]::OpenRead($rangeFile)
            try { $source.CopyTo($destination) } finally { $source.Dispose(); $destination.Dispose() }
            $downloaded = $lastByte + 1
            Write-Host ("PostgreSQL download: {0} / 325 MB" -f [Math]::Round($downloaded / 1MB))
        }
        if ((Get-Item -LiteralPath $partial).Length -ne 341325378) { throw 'PostgreSQL archive size differs from the pinned official distribution.' }
        Move-Item -LiteralPath $partial -Destination $Archive -Force
    }
    Write-Host 'Extracting PostgreSQL binaries (no Windows service will be installed)...'
    & tar.exe -xf $Archive -C $RuntimeDir pgsql/bin pgsql/lib pgsql/share
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL archive extraction failed.' }
    $sha = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    @{ version = '17.11-3'; url = $DownloadUrl; bytes = 341325378; sha256 = $sha } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir 'postgres-download.json') -Encoding UTF8
    & (Join-Path $PgRoot 'bin\postgres.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL cannot run on this Windows machine.' }
}

function Start-Database {
    Write-Stage 'database-files' 'Checking the independent PostgreSQL runtime.'
    Install-Postgres
    Assert-ProjectPath $PgData
    if (-not (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))) {
        Write-Stage 'database-initialize' 'Initializing the independent PostgreSQL data directory.'
        $passwordFile = Join-Path $RuntimeDir 'initdb-password.tmp'
        Assert-ProjectPath $passwordFile
        try {
            [IO.File]::WriteAllText($passwordFile, $DbPassword + "`n", (New-Object Text.UTF8Encoding($false)))
            & (Join-Path $PgRoot 'bin\initdb.exe') -D $PgData --username=$DbUser --pwfile=$passwordFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed.' }
        } finally {
            if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
        }
    }
    $ownedPg = Get-OwnedPostgresPid
    Assert-PortFree $PgPort $ownedPg
    if (-not $ownedPg) {
        Write-Stage 'database-start' 'Starting PostgreSQL on 127.0.0.1:5448.'
        $pgCtl = Join-Path $PgRoot 'bin\pg_ctl.exe'
        $pgLog = Join-Path $LogDir 'postgres.log'
        $args = @('start', '-D', ('"' + $PgData + '"'), '-o', '"-h 127.0.0.1 -p 5448"', '-l', ('"' + $pgLog + '"'), '-w', '-t', '60')
        $started = Start-Process -FilePath $pgCtl -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir 'pg-control.log') -RedirectStandardError (Join-Path $LogDir 'pg-control.error.log')
        $null = $started.Handle
        if (-not $started.WaitForExit(65000)) { throw 'PostgreSQL control startup timed out; inspect the database log before retrying.' }
        $started.Refresh()
        # Windows PowerShell can report a null exit code for an already exited detached launcher.
        # Ownership and the authenticated query below remain required before we call it ready.
        if ($null -ne $started.ExitCode -and $started.ExitCode -ne 0) { throw 'PostgreSQL failed to start; see .data/logs/postgres.log.' }
        if (-not (Get-OwnedPostgresPid)) { throw 'PostgreSQL PID or command identity could not be verified.' }
    }
    Write-Stage 'database-authenticate' 'Verifying PostgreSQL identity, authentication and independent databases.'
    $oldPassword = $env:PGPASSWORD
    try {
        $env:PGPASSWORD = $DbPassword
        $psql = Join-Path $PgRoot 'bin\psql.exe'
        foreach ($name in @('corescope', 'corescope_test')) {
            $present = & $psql -h 127.0.0.1 -p $PgPort -U $DbUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$name'"
            if ($LASTEXITCODE -ne 0) { throw 'Independent PostgreSQL authentication failed.' }
            if (-not $present -or ([string]$present).Trim() -ne '1') {
                & (Join-Path $PgRoot 'bin\createdb.exe') -h 127.0.0.1 -p $PgPort -U $DbUser $name
                if ($LASTEXITCODE -ne 0) { throw "Cannot create $name database." }
            }
        }
    } finally { $env:PGPASSWORD = $oldPassword }
    Write-Stage 'database-ready' "Independent PostgreSQL is ready on 127.0.0.1:$PgPort. Application startup continues below."
}

function Wait-Health([string]$Url) {
    $deadline = (Get-Date).AddSeconds(90)
    do {
        try {
            $health = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($health.ok -eq $true -and $health.db -eq 'ok') { return }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Health check failed at $Url. Inspect .data/logs."
}

function Assert-ApplicationProcesses($Saved) {
    $roles = @('api', 'web', 'worker')
    if ($Config.V2_DATABASE -and $Config.CORESCOPE_BRIDGE_ENABLED -ne 'false') { $roles += 'bridge' }
    foreach ($role in $roles) {
        $record = $Saved.children.$role
        if (-not $record -or -not $record.ready -or -not (Test-OwnedProcess $record $record.entry)) {
            throw "$role is not a healthy owned process. Inspect .data/logs before retrying."
        }
    }
}

function Start-System {
    Write-Stage 'existing-processes' 'Checking for an already running CoreScope supervisor.'
    $existing = Get-SupervisorState
    if ($existing) {
        Write-Stage 'existing-health' 'Checking the database-backed API and all application process identities.'
        Wait-Health "http://127.0.0.1:$WebPort/api/health"
        Assert-ApplicationProcesses (Get-SupervisorState)
        Write-Stage 'ready' "CoreScope is already running: $($Config.SITE_URL)"
        if (-not $NoBrowser) { Start-Process $Config.SITE_URL }
        return
    }
    Write-Stage 'ports' 'Checking that application ports 8780 and 8781 are free.'
    Assert-PortFree $WebPort
    Assert-PortFree $ApiPort
    Start-Database
    Push-Location $ProjectRoot
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
            Write-Stage 'dependencies' 'Installing application dependencies with npm ci.'
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        }
        Write-Stage 'migration' 'Applying any pending database migrations.'
        Invoke-NodeScript 'scripts/migrate.ts'
        Write-Stage 'seed' 'Synchronizing topics, sources and the model directory.'
        Invoke-NodeScript 'scripts/seed.ts'
        Write-Stage 'budgets' 'Checking the initial model request budgets.'
        Invoke-NodeScript 'scripts/corescope-operations.ts' @('configure')
        Write-Stage 'web-build-check' 'Checking whether the production web build needs updating.'
        $buildFile = Join-Path $ProjectRoot 'apps\web\build\server\index.js'
        $sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'apps\web\app'), (Join-Path $ProjectRoot 'industry'), (Join-Path $ProjectRoot 'packages\contracts\src') -Recurse -File)
        $needsBuild = -not (Test-Path -LiteralPath $buildFile)
        if (-not $needsBuild) { $needsBuild = @($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt (Get-Item -LiteralPath $buildFile).LastWriteTimeUtc }).Count -gt 0 }
        if ($needsBuild) {
            Write-Stage 'web-build' 'Building the production website.'
            & npm.cmd run build -w '@aihot/web'
            if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
        }
    } finally { Pop-Location }
    Write-Stage 'supervisor-start' 'Starting the API, website, worker and configured V2 bridge.'
    $savedEnvironment = @{}
    try {
        foreach ($property in $Config.PSObject.Properties) {
            $savedEnvironment[$property.Name] = [Environment]::GetEnvironmentVariable($property.Name, 'Process')
            [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
        }
        $savedEnvironment['NODE_ENV'] = $env:NODE_ENV
        $env:NODE_ENV = 'production'
        $args = @(('"--env-file=' + $EnvFile + '"'), ('"' + $SupervisorEntry + '"'), 'daemon')
        Start-Process -FilePath $Node -ArgumentList $args -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'supervisor.log') -RedirectStandardError (Join-Path $LogDir 'supervisor.error.log') | Out-Null
    } finally {
        foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    }
    Write-Stage 'api-health' 'Waiting for the API to answer a real database health query.'
    Wait-Health "http://127.0.0.1:$ApiPort/api/health"
    Write-Stage 'web-health' 'Waiting for the website to proxy the database health query.'
    Wait-Health "http://127.0.0.1:$WebPort/api/health"
    Write-Stage 'worker-health' 'Waiting for the worker to complete startup.'
    $workerDeadline = (Get-Date).AddSeconds(90)
    do {
        $pending = Get-SupervisorState
        if ($pending -and $pending.children.worker.ready) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $workerDeadline)
    $saved = Get-SupervisorState
    if (-not $saved) { throw 'Supervisor identity check failed.' }
    if (-not $saved.children.worker.ready) { throw 'Worker did not finish startup; inspect .data/logs/worker.error.log.' }
    Assert-ApplicationProcesses $saved
    Write-Stage 'ready' "CoreScope is ready: $($Config.SITE_URL) | admin: /admin | logs: .data/logs"
    if (-not $NoBrowser) { Start-Process $Config.SITE_URL }
}

function Stop-System {
    $saved = Get-SupervisorState
    if ($saved) {
        Write-Host 'Stopping owned CoreScope processes gracefully; an in-flight model call may take up to 205 seconds...'
        Invoke-NodeScript 'scripts/corescope-runtime.ts' @('stop')
    } elseif (Test-Path -LiteralPath $StateFile) {
        $stale = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($property in $stale.children.PSObject.Properties) {
            $record = $property.Value
            if (Test-OwnedProcess $record $record.entry) { throw 'Supervisor is unavailable but an owned child is still running. Inspect logs before stopping PostgreSQL; no process was killed.' }
        }
    }
    $ownedPg = Get-OwnedPostgresPid
    if ($ownedPg) {
        & (Join-Path $PgRoot 'bin\pg_ctl.exe') stop -D $PgData -m fast -w -t 60
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL graceful stop failed; it was not force-killed.' }
    }
    Write-Host 'CoreScope stopped. Database and imported content are retained.'
}

try {
    New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null
    Write-Stage 'node-runtime' 'Checking Node.js 24.11 or newer.'
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    Write-Stage 'configuration' 'Validating local configuration without displaying credentials.'
    Read-Config
    switch ($Action) {
        'Install' { Install-Postgres }
        'Database' { Start-Database }
        'Start' { Start-System }
        'Stop' { Stop-System }
        'Status' {
            $saved = Get-SupervisorState
            if ($saved) { Invoke-NodeScript 'scripts/corescope-runtime.ts' @('status') }
            else { Write-Host 'CoreScope application processes are not running.' }
            Write-Host "Owned PostgreSQL PID: $(Get-OwnedPostgresPid)"
        }
    }
} catch {
    $failure = Protect-LogText $_.Exception.Message
    try { Write-RuntimeLog 'error' $failure -Failure }
    catch { Write-Host 'The error log could not be written; check the project directory permissions and disk space.' }
    Write-Host "[FAILED] CoreScope $Action failed during '$($script:StartupPhase)': $failure" -ForegroundColor Red
    Write-Host "Failure details: $StartupErrorLog"
    Write-Host "Step output: $StartupLog"
    exit 1
}
