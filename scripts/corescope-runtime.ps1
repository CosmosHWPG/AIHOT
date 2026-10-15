param(
    [ValidateSet('Start', 'Stop', 'Status', 'Database', 'Install', 'Hosted')][string]$Action = 'Start',
    [switch]$NoBrowser,
    [ValidateSet('System', 'Database')][string]$HostMode = 'System',
    [string]$NodeExecutable
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
$RuntimeScript = Join-Path $ProjectRoot 'scripts\corescope-runtime.ps1'
$CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:HostReceipt = $null
$script:HostedErrorLog = $StartupErrorLog
$script:HostCreatedPostgres = $false
$script:HostCreatedSupervisor = $false

function Protect-LogText([string]$Text) {
    if ($script:Config) {
        foreach ($property in $script:Config.PSObject.Properties) {
            if ($property.Name -match '(?i)(API_KEY|DAJIALA_KEY|SOCIALDATA_KEY|PASSWORD|SECRET|TOKEN|^DATABASE_URL$)') {
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
    if ($Action -eq 'Hosted') {
        $record.hostMode = $HostMode
        $record.hostNonce = if ($script:HostReceipt) { $script:HostReceipt.nonce } else { $null }
    }
    $line = ($record | ConvertTo-Json -Compress) + [Environment]::NewLine
    [IO.File]::AppendAllText($StartupLog, $line, (New-Object Text.UTF8Encoding($false)))
    if ($Failure) {
        [IO.File]::AppendAllText($StartupErrorLog, $line, (New-Object Text.UTF8Encoding($false)))
        if ($Action -eq 'Hosted' -and $script:HostedErrorLog -ne $StartupErrorLog) {
            [IO.File]::AppendAllText($script:HostedErrorLog, $line, (New-Object Text.UTF8Encoding($false)))
        }
    }
}

function Write-Stage([string]$Phase, [string]$Message) {
    $script:StartupPhase = $Phase
    Write-Host ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Phase.ToUpperInvariant(), $Message)
    Write-RuntimeLog 'info' $Message
    if ($Action -eq 'Hosted' -and $script:HostReceipt) {
        $script:HostReceipt.phase = $Phase
        Save-HostReceipt
        if ($script:HostReceipt.status -eq 'starting' -and (Test-HostedStopRequest $script:HostReceipt)) { throw 'Windows host startup was cancelled by Stop.' }
    }
}

function Assert-ProjectPath([string]$Target) {
    $resolved = [IO.Path]::GetFullPath($Target)
    if (-not $resolved.StartsWith($ProjectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runtime path must stay inside this project.'
    }
}

function Invoke-CapturedExecutable([string]$Executable, [string[]]$Arguments, $Environment = @{}) {
    # Windows PowerShell's native-command runner can silently fail inside a Job
    # that disallows breakaway. Direct Process capture supports that caller too.
    $quoted = foreach ($value in $Arguments) {
        $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $quoted -join ' '
    $start.WorkingDirectory = $ProjectRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    foreach ($key in $Environment.Keys) { $start.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'The read-only runtime probe could not start.' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $diagnostic = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill() # Only this just-created, read-only configuration probe.
            throw 'The read-only runtime probe timed out.'
        }
        $captured = $output.GetAwaiter().GetResult()
        $null = $diagnostic.GetAwaiter().GetResult() # Never echo the private configuration.
        if ($process.ExitCode -ne 0) { throw "Read-only $([IO.Path]::GetFileName($Executable)) probe failed (exit $($process.ExitCode)); configuration values were not logged." }
        return $captured
    } finally { $process.Dispose() }
}

function Invoke-CapturedNode([string[]]$Arguments) { return (Invoke-CapturedExecutable -Executable $Node -Arguments $Arguments) }

function Read-Config {
    $versionText = Invoke-CapturedNode -Arguments @('--version')
    if (-not $versionText) { throw 'Node.js version check did not return output. Inspect the Windows host log.' }
    if ([Version]$versionText.TrimStart('v') -lt [Version]'24.11.0') { throw 'Install Node.js 24.11 or newer before starting CoreScope.' }
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Create the private .env configuration first (see docs/CORESCOPE_LOCAL.md).' }
    $raw = Invoke-CapturedNode -Arguments @('-e', "const fs=require('node:fs');const{parseEnv}=require('node:util');process.stdout.write(JSON.stringify(parseEnv(fs.readFileSync(process.argv[1],'utf8'))));", $EnvFile)
    if (-not $raw) { throw 'Cannot read local .env configuration.' }
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
    $savedEnvironment = @{}
    try {
        # Node's --env-file does not override ambient variables. Every child uses the
        # same private configuration that this launcher has validated.
        if ($script:Config) {
            foreach ($property in $script:Config.PSObject.Properties) {
                $savedEnvironment[$property.Name] = [Environment]::GetEnvironmentVariable($property.Name, 'Process')
                [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
            }
        }
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
    } finally {
        foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
        $ErrorActionPreference = $previousPreference
        Pop-Location
    }
}

function Connect-CoreScopeScheduler {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    return $service
}

function Get-CoreScopeTaskSpec([string]$Mode) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 20).ToLowerInvariant() }
    finally { $sha.Dispose() }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return [pscustomobject]@{
        TaskName = "CoreScope-$hash-$Mode"
        UserSid = $CurrentUserSid
        Root = $ProjectRoot
        Executable = $powershell
        Arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Hosted -HostMode {1} -NodeExecutable "{2}" -NoBrowser' -f $RuntimeScript, $Mode, $Node)
        WorkingDirectory = $ProjectRoot
        Description = "CoreScope current-user runtime host ($Mode): $ProjectRoot"
    }
}

# These functions also accept a fixed isolated Spec in the Windows lifecycle regression.
# Production specs always come from the checkout path and the current user's SID above.
function New-CoreScopeTaskDefinition($Service, $Spec) {
    $definition = $Service.NewTask(0)
    $definition.RegistrationInfo.Description = $Spec.Description
    $definition.Principal.UserId = $Spec.UserSid
    $definition.Principal.LogonType = 3 # InteractiveToken; no saved Windows password.
    $definition.Principal.RunLevel = 0 # LeastPrivilege.
    $definition.Settings.Enabled = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.MultipleInstances = 2 # IgnoreNew.
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.RunOnlyIfIdle = $false
    $definition.Settings.Hidden = $true
    $action = $definition.Actions.Create(0)
    $action.Path = $Spec.Executable
    $action.Arguments = $Spec.Arguments
    $action.WorkingDirectory = $Spec.WorkingDirectory
    return $definition
}

function Assert-CoreScopeTaskDefinition($Definition, $Spec) {
    # Task Scheduler COM may expose a local account name even when its XML stores SID.
    $principalSid = ''
    try {
        if ($Definition.Principal.UserId -match '^S-1-') { $principalSid = (New-Object Security.Principal.SecurityIdentifier($Definition.Principal.UserId)).Value }
        else { $principalSid = (New-Object Security.Principal.NTAccount($Definition.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    } catch {}
    $valid = $Definition.RegistrationInfo.Description -eq $Spec.Description -and
        $principalSid -eq $Spec.UserSid -and
        $Definition.Principal.LogonType -eq 3 -and $Definition.Principal.RunLevel -eq 0 -and
        $Definition.Triggers.Count -eq 0 -and $Definition.Actions.Count -eq 1 -and
        $Definition.Settings.Enabled -and $Definition.Settings.AllowDemandStart -and
        $Definition.Settings.ExecutionTimeLimit -eq 'PT0S' -and $Definition.Settings.MultipleInstances -eq 2 -and
        -not $Definition.Settings.DisallowStartIfOnBatteries -and -not $Definition.Settings.StopIfGoingOnBatteries -and
        -not $Definition.Settings.RunOnlyIfIdle
    if ($valid) {
        $action = $Definition.Actions.Item(1)
        $valid = $action.Type -eq 0 -and $action.Path -eq $Spec.Executable -and
            $action.Arguments -eq $Spec.Arguments -and $action.WorkingDirectory -eq $Spec.WorkingDirectory
    }
    if (-not $valid) { throw "Scheduled task '$($Spec.TaskName)' does not match this checkout, user or safe host definition. It was not changed." }
}

function Register-CoreScopeTask($Service, $Spec) {
    $folder = $Service.GetFolder('\')
    $task = $null
    try { $task = $folder.GetTask($Spec.TaskName) }
    catch {
        $exception = $_.Exception
        while ($exception.InnerException) { $exception = $exception.InnerException }
        if ($exception.HResult -ne -2147024894) { throw }
    }
    if ($task) {
        Assert-CoreScopeTaskDefinition $task.Definition $Spec
        return $task
    }
    $definition = New-CoreScopeTaskDefinition $Service $Spec
    try { $task = $folder.RegisterTaskDefinition($Spec.TaskName, $definition, 2, $Spec.UserSid, $null, 3, $null) }
    catch {
        # A simultaneous Start may have won TASK_CREATE. Only reuse an exact match.
        $registrationFailure = $_
        try { $task = $folder.GetTask($Spec.TaskName) }
        catch { throw $registrationFailure }
        Assert-CoreScopeTaskDefinition $task.Definition $Spec
    }
    Assert-CoreScopeTaskDefinition $task.Definition $Spec
    return $task
}

function Start-CoreScopeTask($Task) {
    if ($Task.State -ne 4) { $Task.Run($null) | Out-Null }
}

function Get-CoreScopeTaskInstances($Task) {
    # GetRunningTasks documents TASK_ENUM_HIDDEN; filter by this exact task path.
    # RegisteredTask.GetInstances(0) omits this hidden task on the tested Windows.
    $service = Connect-CoreScopeScheduler
    $collection = $service.GetRunningTasks(1)
    if ($null -eq $collection) { throw 'Task Scheduler did not return its running-task collection.' }
    for ($index = 1; $index -le [int]$collection.Count; $index++) {
        $instance = $collection.Item($index)
        if ($instance.Path -eq $Task.Path -and $instance.InstanceGuid) {
            [pscustomobject]@{ instanceId = [string]$instance.InstanceGuid; enginePid = [int]$instance.EnginePID; state = $instance.State }
        }
    }
}

function Test-CoreScopeEngineAncestry([int]$EnginePid, [int]$ActionPid) {
    if (-not $EnginePid) {
        $schedule = Get-CimInstance Win32_Service -Filter "Name = 'Schedule'" -ErrorAction SilentlyContinue
        if (-not $schedule -or $schedule.State -ne 'Running' -or -not $schedule.ProcessId) { return $false }
        $EnginePid = [int]$schedule.ProcessId
    }
    $nextPid = $ActionPid
    $childCreated = [DateTime]::MaxValue
    for ($index = 0; $index -lt 8 -and $nextPid; $index++) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $nextPid" -ErrorAction SilentlyContinue
        if (-not $process -or $process.CreationDate -gt $childCreated) { return $false }
        if ($nextPid -eq $EnginePid) { return $true }
        $childCreated = $process.CreationDate
        $nextPid = [int]$process.ParentProcessId
    }
    return $false
}

function Get-HostReceiptPath([string]$Mode) { return (Join-Path $RuntimeDir ("host-{0}.json" -f $Mode.ToLowerInvariant())) }

function Save-HostReceipt {
    $script:HostReceipt.updatedAt = [DateTimeOffset]::Now.ToString('o')
    $file = Get-HostReceiptPath $HostMode
    $temporary = $file + '.' + $script:HostReceipt.nonce + '.tmp'
    [IO.File]::WriteAllText($temporary, ($script:HostReceipt | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $file -Force
}

function Get-HostReceipt([string]$Mode, [switch]$RequireAlive) {
    $file = Get-HostReceiptPath $Mode
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    try {
        $receipt = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($receipt.root -ne $ProjectRoot -or $receipt.userSid -ne $CurrentUserSid -or $receipt.mode -ne $Mode -or -not $receipt.nonce) { return $null }
        if ($RequireAlive) {
            if (-not (Test-OwnedProcess $receipt.host $RuntimeScript)) { return $null }
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$receipt.host.pid)" -ErrorAction SilentlyContinue
            if (-not $proc -or $proc.CommandLine -notmatch '(?i)(?:^|\s)-Action\s+"?Hosted"?(?:\s|$)' -or
                $proc.CommandLine -notmatch ("(?i)(?:^|\s)-HostMode\s+`"?{0}`"?(?:\s|$)" -f $Mode)) { return $null }
            $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid -ErrorAction Stop
            if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $CurrentUserSid) { return $null }
        }
        return $receipt
    } catch { return $null }
}

function Get-ManagedPostgresHost([int]$PgPid) {
    if (-not $PgPid) { return $null }
    foreach ($mode in @('System', 'Database')) {
        $receipt = Get-HostReceipt $mode -RequireAlive
        if ($receipt -and $receipt.status -in @('starting', 'ready') -and -not (Test-HostedStopRequest $receipt) -and
            $receipt.pg -and $receipt.pg.pid -eq $PgPid -and (Test-OwnedProcess $receipt.pg $PgData)) {
            $service = Connect-CoreScopeScheduler
            $spec = Get-CoreScopeTaskSpec $mode
            $task = $service.GetFolder('\').GetTask($spec.TaskName)
            Assert-CoreScopeTaskDefinition $task.Definition $spec
            $instances = @(Get-CoreScopeTaskInstances $task)
            if ($task.State -eq 4 -and $instances.instanceId -contains $receipt.instanceId) { return $receipt }
        }
    }
    return $null
}

function Get-PostgresRecord {
    $pgPid = Get-OwnedPostgresPid
    if (-not $pgPid) { throw 'The owned PostgreSQL process is not running.' }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pgPid" -ErrorAction Stop
    return [pscustomobject]@{ pid = $pgPid; startedAt = $proc.CreationDate.ToUniversalTime().ToString('o'); entry = $PgData }
}

function Assert-DatabaseAuthentication {
    if (-not (Get-OwnedPostgresPid)) { throw 'Owned PostgreSQL identity could not be verified.' }
    $result = Invoke-CapturedExecutable -Executable (Join-Path $PgRoot 'bin\psql.exe') -Arguments @('-h', '127.0.0.1', '-p', [string]$PgPort, '-U', $DbUser, '-d', $DbName, '-tAc', 'SELECT 1') -Environment @{ PGPASSWORD = $DbPassword; PGCONNECT_TIMEOUT = '10' }
    if (([string]$result).Trim() -ne '1') { throw 'Independent PostgreSQL authentication failed.' }
}

function Test-HostedStopRequest($Receipt) {
    try {
        $request = Get-Content -LiteralPath (Join-Path $RuntimeDir 'host-stop.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        return $request.root -eq $ProjectRoot -and $request.userSid -eq $CurrentUserSid -and
            (($request.nonces -contains $Receipt.nonce) -or ($Receipt.instanceId -and $request.instances -contains $Receipt.instanceId))
    } catch { return $false }
}

function Write-HostedStopRequest {
    $nonces = @()
    $instances = @()
    $service = Connect-CoreScopeScheduler
    foreach ($mode in @('System', 'Database')) {
        $receipt = Get-HostReceipt $mode -RequireAlive
        if ($receipt) { $nonces += $receipt.nonce }
        try {
            $spec = Get-CoreScopeTaskSpec $mode
            $task = $service.GetFolder('\').GetTask($spec.TaskName)
            Assert-CoreScopeTaskDefinition $task.Definition $spec
            $running = @(Get-CoreScopeTaskInstances $task)
            $instances += @($running | ForEach-Object { $_.instanceId })
        } catch {}
    }
    if ($nonces.Count -or $instances.Count) {
        @{ root = $ProjectRoot; userSid = $CurrentUserSid; at = [DateTimeOffset]::Now.ToString('o'); nonces = $nonces; instances = $instances } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeDir 'host-stop.json') -Encoding UTF8
    }
}

function Test-OwnedProcess($Record, [string]$ExpectedEntry) {
    if (-not $Record -or -not $Record.pid) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Record.pid)" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.CommandLine) { return $false }
    if (-not $proc.CommandLine.Replace('/', '\').Contains($ExpectedEntry.Replace('/', '\'))) { return $false }
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
    $spec = Get-CoreScopeTaskSpec 'Database'
    $mutex = New-Object Threading.Mutex($false, ("Local\{0}" -f $spec.TaskName))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(180000) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another verified host is preparing PostgreSQL. Wait for it to finish and retry; no process was stopped.' }
        Start-DatabaseUnlocked
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Start-DatabaseUnlocked {
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
    if ($ownedPg -and $Action -eq 'Hosted' -and -not (Get-ManagedPostgresHost $ownedPg)) {
        throw 'The existing PostgreSQL process has no verified Windows host. Run Stop-CoreScope.cmd before restarting; it was not reused or killed.'
    }
    if (-not $ownedPg) {
        Write-Stage 'database-start' 'Starting PostgreSQL on 127.0.0.1:5448.'
        $launchStarted = [DateTimeOffset]::Now
        try { Invoke-NodeScript 'scripts/corescope-runtime.ts' @('launch-postgres') }
        finally {
            if ($Action -eq 'Hosted' -and $script:HostReceipt -and (Get-OwnedPostgresPid)) {
                $created = Get-PostgresRecord
                if ([DateTimeOffset]::Parse($created.startedAt) -ge $launchStarted.AddSeconds(-1)) {
                    $script:HostReceipt.pg = $created
                    $script:HostCreatedPostgres = $true
                    Save-HostReceipt
                }
            }
        }
        if (-not (Get-OwnedPostgresPid)) { throw 'PostgreSQL PID or command identity could not be verified.' }
    }
    if ($Action -eq 'Hosted' -and $script:HostReceipt) {
        $script:HostReceipt.pg = Get-PostgresRecord
        Save-HostReceipt
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
    if ($Action -eq 'Hosted' -and $script:HostReceipt) {
        $script:HostReceipt.pg = Get-PostgresRecord
        Save-HostReceipt
    }
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
        if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'industry\corescope-source-profiles.json')) {
            Write-Stage 'source-routes' 'Applying reviewed source routes while preserving administrator changes.'
            Invoke-NodeScript 'scripts/corescope-source-upgrade.ts' @('--apply')
        }
        Write-Stage 'budgets' 'Checking the initial model request budgets.'
        Invoke-NodeScript 'scripts/corescope-operations.ts' @('configure')
        if ($Config.PSObject.Properties.Name -contains 'BIRD_ENABLED' -and $Config.BIRD_ENABLED -match '^(?i:true|1)$') {
            Write-Stage 'bird-configuration' 'Checking the pinned read-only Bird adapter; no X request is sent.'
            Invoke-NodeScript 'scripts/corescope-bird.ts' @('check')
        }
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
    if ($Action -eq 'Hosted') { $script:HostCreatedSupervisor = $true }
    Invoke-NodeScript 'scripts/corescope-runtime.ts' @('launch-supervisor')
    if ($Action -eq 'Hosted') {
        $identityDeadline = (Get-Date).AddSeconds(10)
        do {
            $launched = Get-SupervisorState
            if ($launched) { $script:HostReceipt.supervisor = $launched.supervisor; Save-HostReceipt; break }
            Start-Sleep -Milliseconds 100
        } while ((Get-Date) -lt $identityDeadline)
        if (-not $script:HostReceipt.supervisor) { throw 'The launched supervisor identity could not be verified.' }
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
    Write-HostedStopRequest
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
    Write-Host 'Owned applications and PostgreSQL stopped normally. Database and imported content are retained.'
}

function Get-RecentHostedFailure([string]$Mode, [DateTimeOffset]$Since, [string]$ExpectedNonce) {
    $file = Join-Path $LogDir ("host-{0}.error.log" -f $Mode.ToLowerInvariant())
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    foreach ($line in @(Get-Content -LiteralPath $file -Tail 8 -Encoding UTF8)) {
        try {
            $record = $line | ConvertFrom-Json
            $sameRun = if ($ExpectedNonce) { $record.hostNonce -eq $ExpectedNonce } else { -not $record.hostNonce }
            if ($sameRun -and [DateTimeOffset]::Parse($record.at) -ge $Since -and $record.level -eq 'error') { return (Protect-LogText $record.message) }
        } catch {}
    }
    return $null
}

function Assert-HostedReady($Receipt, [string]$Mode) {
    if (-not $Receipt -or $Receipt.status -ne 'ready') { throw 'The Windows host has not completed startup.' }
    $live = Get-HostReceipt $Mode -RequireAlive
    if (-not $live -or $live.nonce -ne $Receipt.nonce) { throw 'Windows host identity changed during startup.' }
    $ownedPg = Get-OwnedPostgresPid
    if (-not $ownedPg -or -not $live.pg -or $live.pg.pid -ne $ownedPg -or -not (Test-OwnedProcess $live.pg $PgData)) {
        throw 'Windows host PostgreSQL identity does not match the authenticated database.'
    }
    Assert-DatabaseAuthentication
    if ($Mode -eq 'System') {
        $saved = Get-SupervisorState
        if (-not $saved -or $saved.stopping -or -not $live.supervisor -or $saved.supervisor.pid -ne $live.supervisor.pid -or
            -not (Test-OwnedProcess $live.supervisor $SupervisorEntry)) { throw 'The Windows host does not own the running supervisor.' }
        Assert-ApplicationProcesses $saved
        Wait-Health "http://127.0.0.1:$ApiPort/api/health"
        Wait-Health "http://127.0.0.1:$WebPort/api/health"
    }
}

function Start-HostedRuntime([string]$Mode) {
    Write-Stage 'windows-host' "Checking the current-user Windows $Mode host task (no automatic trigger)."
    $service = Connect-CoreScopeScheduler
    $spec = Get-CoreScopeTaskSpec $Mode
    $task = Register-CoreScopeTask $service $spec
    $existingPg = Get-OwnedPostgresPid
    if ($existingPg -and -not (Get-ManagedPostgresHost $existingPg)) {
        # A peer host can be waiting for pg_ctl to return before publishing its PID.
        $pendingDeadline = (Get-Date).AddSeconds(120)
        do {
            $pending = @('System', 'Database') | ForEach-Object { Get-HostReceipt $_ -RequireAlive } | Where-Object { $_.status -eq 'starting' }
            if (-not $pending -or (Get-ManagedPostgresHost $existingPg)) { break }
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $pendingDeadline)
    }
    if ($existingPg -and -not (Get-ManagedPostgresHost $existingPg)) {
        throw 'The existing PostgreSQL process has no verified Windows host. Run Stop-CoreScope.cmd before restarting; no process was stopped.'
    }
    if ($Mode -eq 'System') {
        $existing = Get-SupervisorState
        $existingHost = Get-HostReceipt 'System' -RequireAlive
        if ($existing -and (-not $existingHost -or -not $existingHost.supervisor -or $existingHost.supervisor.pid -ne $existing.supervisor.pid)) {
            throw 'The existing application process has no verified Windows host. Run Stop-CoreScope.cmd before restarting; no process was stopped.'
        }
    } elseif ($existingPg) {
        $managed = Get-ManagedPostgresHost $existingPg
        if ($managed -and $managed.mode -eq 'System' -and $managed.status -eq 'starting') {
            # Do not attach a second host to a PG instance that System may still
            # clean up if its migrations/build fail. Join only after owner READY.
            Write-Stage 'database-owner-startup' 'Waiting for the existing System host to complete startup before reusing its PostgreSQL.'
            $ownerDeadline = (Get-Date).AddMinutes(15)
            do {
                Start-Sleep -Milliseconds 500
                $owner = Get-HostReceipt 'System' -RequireAlive
                if (-not $owner -or $owner.nonce -ne $managed.nonce -or $owner.status -in @('failed', 'stopped') -or (Test-HostedStopRequest $owner)) {
                    throw 'The System host stopped or failed before PostgreSQL could be reused. Wait for normal cleanup, then retry Database; no second host was started.'
                }
                if ($owner.status -eq 'ready') { $managed = $owner; break }
            } while ((Get-Date) -lt $ownerDeadline)
            if ($managed.status -ne 'ready') { throw 'The System host has not completed startup; Database did not start another host.' }
        }
        if ($managed -and $managed.status -eq 'ready') {
            if (-not (Get-ManagedPostgresHost $existingPg)) { throw 'The PostgreSQL owner changed before reuse could be confirmed.' }
            Assert-DatabaseAuthentication
            Write-Stage 'database-ready' 'Independent PostgreSQL is already running under a verified Windows host.'
            return
        }
    }
    $since = [DateTimeOffset]::Now
    $known = Get-HostReceipt $Mode -RequireAlive
    $knownNonce = if ($known) { $known.nonce } else { $null }
    $knownInstances = @()
    $instances = @(Get-CoreScopeTaskInstances $task)
    $knownInstances += @($instances | ForEach-Object { $_.instanceId })
    Write-Stage 'host-request' "Requesting '$($spec.TaskName)'; task registration or Running does not mean the system is ready."
    Start-CoreScopeTask $task
    $deadline = (Get-Date).AddMinutes(15)
    $lastPhase = ''
    do {
        $receipt = Get-HostReceipt $Mode
        $current = $receipt -and (($knownNonce -and $receipt.nonce -eq $knownNonce) -or
            ($receipt.instanceId -and $knownInstances -contains $receipt.instanceId) -or [DateTimeOffset]::Parse($receipt.startedAt) -ge $since)
        if ($current) {
            if ($receipt.status -eq 'failed') { throw "Windows $Mode host failed during '$($receipt.phase)': $(Protect-LogText $receipt.error)" }
            if ($receipt.status -eq 'stopped') { throw 'The Windows host stopped before readiness was confirmed. Start again after Stop has completed.' }
            if ($receipt.phase -and $receipt.phase -ne $lastPhase) {
                $lastPhase = $receipt.phase
                Write-Stage 'host-progress' "Windows $Mode host: $lastPhase. Detailed output: .data/logs/host-$($Mode.ToLowerInvariant()).log"
            }
            if ($receipt.status -eq 'ready') {
                Assert-HostedReady $receipt $Mode
                if ($Mode -eq 'System') {
                    Write-Stage 'ready' "CoreScope is ready under Windows: $($Config.SITE_URL) | logs: .data/logs"
                    if (-not $NoBrowser) { Start-Process $Config.SITE_URL }
                } else { Write-Stage 'database-ready' 'Independent PostgreSQL is ready under its Windows host.' }
                return
            }
        }
        $failureNonce = if ($current) { $receipt.nonce } else { $null }
        $failure = Get-RecentHostedFailure $Mode $since $failureNonce
        if ($failure) { throw "Windows $Mode host failed: $failure" }
        if ((Get-Date) -gt $deadline) { break }
        Start-Sleep -Milliseconds 750
    } while ($true)
    throw "Windows $Mode host did not reach complete readiness within 15 minutes. Inspect .data/logs/host-$($Mode.ToLowerInvariant()).log and startup.error.log; no process was killed."
}

function Run-HostedRuntime {
    # Keep the task action alive for the complete process lifetime, including PG shutdown.
    $script:NoBrowser = $true
    $service = Connect-CoreScopeScheduler
    $spec = Get-CoreScopeTaskSpec $HostMode
    $task = $service.GetFolder('\').GetTask($spec.TaskName)
    Assert-CoreScopeTaskDefinition $task.Definition $spec
    if ($task.State -ne 4) { throw 'Hosted is an internal Windows task entry. Use Start-CoreScope.cmd or -Action Database.' }
    $previous = Get-HostReceipt $HostMode -RequireAlive
    if ($previous -and $previous.host.pid -ne $PID) { throw 'Another verified Windows host is already running; no process was changed.' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    if (-not $process.ExecutablePath -or [IO.Path]::GetFullPath($process.ExecutablePath) -ne $spec.Executable -or
        -not $process.CommandLine -or -not $process.CommandLine.Contains($spec.Arguments)) {
        throw 'Hosted executable or complete action arguments do not match the verified Windows task.'
    }
    $instanceDeadline = (Get-Date).AddSeconds(15)
    do {
        $instances = @(Get-CoreScopeTaskInstances $task)
        if ($instances.Count -eq 1 -and (Test-CoreScopeEngineAncestry $instances[0].enginePid $PID)) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $instanceDeadline)
    if ($instances.Count -ne 1 -or -not (Test-CoreScopeEngineAncestry $instances[0].enginePid $PID)) {
        throw "The Windows host task instance or engine ancestry could not be verified (instances=$($instances.Count), actionPID=$PID)."
    }
    $script:HostReceipt = [ordered]@{
        root = $ProjectRoot; userSid = $CurrentUserSid; mode = $HostMode; nonce = [Guid]::NewGuid().ToString('N')
        host = @{ pid = $PID; startedAt = $process.CreationDate.ToUniversalTime().ToString('o'); entry = $RuntimeScript }
        startedAt = [DateTimeOffset]::Now.ToString('o'); updatedAt = ''; status = 'starting'; phase = $script:StartupPhase; instanceId = $instances[0].instanceId
        pg = $null; supervisor = $null; error = $null
    }
    Save-HostReceipt
    if (Test-HostedStopRequest $script:HostReceipt) { throw 'Windows host startup was cancelled by Stop.' }
    if ($HostMode -eq 'Database') { Start-Database }
    else {
        Start-System
        $script:HostReceipt.supervisor = (Get-SupervisorState).supervisor
    }
    $script:HostReceipt.status = 'ready'
    Save-HostReceipt
    Write-Stage 'host-running' "Windows $HostMode host is holding its verified process lifetime."
    do {
        if (Test-HostedStopRequest $script:HostReceipt) {
            # The independent Stop caller drains applications, then pg_ctl stops PG.
            if (-not (Get-OwnedPostgresPid)) { break }
        } elseif (-not (Test-OwnedProcess $script:HostReceipt.pg $PgData)) {
            throw 'Owned PostgreSQL exited unexpectedly; inspect postgres.log.'
        }
        if ($HostMode -eq 'System' -and -not (Test-OwnedProcess $script:HostReceipt.supervisor $SupervisorEntry)) {
            if (-not (Test-HostedStopRequest $script:HostReceipt)) { throw 'Owned supervisor exited unexpectedly; inspect supervisor.error.log.' }
            if (-not (Get-OwnedPostgresPid)) { break }
        }
        Start-Sleep -Milliseconds 750
    } while ($true)
    $script:HostReceipt.status = 'stopped'
    Write-Stage 'host-stopped' 'Owned processes stopped normally; the Windows task host is exiting.'
    Save-HostReceipt
}

function Wait-HostedShutdown {
    $deadline = (Get-Date).AddSeconds(300)
    do {
        $remaining = @('System', 'Database') | Where-Object { Get-HostReceipt $_ -RequireAlive }
        $service = Connect-CoreScopeScheduler
        foreach ($mode in @('System', 'Database')) {
            try {
                $spec = Get-CoreScopeTaskSpec $mode
                $task = $service.GetFolder('\').GetTask($spec.TaskName)
                Assert-CoreScopeTaskDefinition $task.Definition $spec
                if (@(Get-CoreScopeTaskInstances $task).Count -gt 0) { $remaining += $mode }
            } catch {}
        }
        if (-not $remaining) { Write-Host 'CoreScope stopped; Windows hosts exited normally.'; return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw 'Processes stopped, but a Windows host has not exited normally. Inspect host logs; no task was force-ended.'
}

function Stop-HostedOwnedResources {
    # Failure cleanup is scoped to resources created by this particular host.
    # A System startup failure must leave a previously healthy Database host intact.
    if ($script:HostCreatedSupervisor) {
        $saved = Get-SupervisorState
        if ($saved -and [DateTimeOffset]::Parse($saved.supervisor.startedAt) -ge [DateTimeOffset]::Parse($script:HostReceipt.startedAt)) {
            if ($script:HostReceipt.supervisor -and $script:HostReceipt.supervisor.pid -ne $saved.supervisor.pid) { throw 'Failure cleanup found a different supervisor; no process was stopped.' }
            Invoke-NodeScript 'scripts/corescope-runtime.ts' @('stop')
        }
    }
    if ($script:HostCreatedPostgres -and $script:HostReceipt.pg -and (Get-OwnedPostgresPid) -eq $script:HostReceipt.pg.pid -and
        (Test-OwnedProcess $script:HostReceipt.pg $PgData)) {
        Write-HostedStopRequest
        & (Join-Path $PgRoot 'bin\pg_ctl.exe') stop -D $PgData -m fast -w -t 60
        if ($LASTEXITCODE -ne 0) { throw 'Owned PostgreSQL normal failure cleanup did not complete; it was not force-killed.' }
    }
}

function Show-RuntimeStatus {
    $service = Connect-CoreScopeScheduler
    foreach ($mode in @('System', 'Database')) {
        $spec = Get-CoreScopeTaskSpec $mode
        try {
            $task = $service.GetFolder('\').GetTask($spec.TaskName)
            Assert-CoreScopeTaskDefinition $task.Definition $spec
            Write-Host "Windows $mode task: state=$($task.State), lastResult=$($task.LastTaskResult), no automatic trigger."
        } catch { Write-Host "Windows $mode task: not registered or definition could not be verified." }
        $receipt = Get-HostReceipt $mode -RequireAlive
        if ($receipt) { Write-Host "Owned $mode host PID: $($receipt.host.pid), status=$($receipt.status), phase=$($receipt.phase)." }
        else { Write-Host "Owned $mode host: not running." }
    }
    $ownedPg = Get-OwnedPostgresPid
    Write-Host "Owned PostgreSQL PID: $ownedPg"
    if ($ownedPg) {
        try { Assert-DatabaseAuthentication; Write-Host 'PostgreSQL authentication: healthy.' }
        catch { Write-Host 'PostgreSQL authentication: FAILED.' }
    }
    $saved = Get-SupervisorState
    if ($saved) {
        Invoke-NodeScript 'scripts/corescope-runtime.ts' @('status')
        foreach ($role in @('api', 'web', 'worker', 'bridge')) {
            $record = $saved.children.$role
            if ($record) {
                $healthy = $record.ready -and (Test-OwnedProcess $record $record.entry)
                Write-Host "$role PID=$($record.pid), identityAndReady=$healthy."
            }
        }
    } else { Write-Host 'CoreScope application processes are not running.' }
    foreach ($port in @($ApiPort, $WebPort)) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
            Write-Host "HTTP $port database health: $($health.ok -eq $true -and $health.db -eq 'ok')."
        } catch { Write-Host "HTTP $port database health: unavailable." }
    }
}

try {
    New-Item -ItemType Directory -Force $RuntimeDir, $LogDir | Out-Null
    if ($Action -eq 'Hosted') {
        $StartupLog = Join-Path $LogDir ("host-{0}.log" -f $HostMode.ToLowerInvariant())
        $script:HostedErrorLog = Join-Path $LogDir ("host-{0}.error.log" -f $HostMode.ToLowerInvariant())
    }
    Write-Stage 'node-runtime' 'Checking Node.js 24.11 or newer.'
    if ($NodeExecutable) {
        if (-not [IO.Path]::IsPathRooted($NodeExecutable) -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf) -or [IO.Path]::GetFileName($NodeExecutable) -ne 'node.exe') { throw 'NodeExecutable must name an existing absolute node.exe path.' }
        $Node = [IO.Path]::GetFullPath($NodeExecutable)
    } else { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
    Write-Stage 'configuration' 'Validating local configuration without displaying credentials.'
    Read-Config
    switch ($Action) {
        'Install' { Install-Postgres }
        'Database' { Start-HostedRuntime 'Database' }
        'Start' { Start-HostedRuntime 'System' }
        'Hosted' { Run-HostedRuntime }
        'Stop' { Stop-System; Wait-HostedShutdown }
        'Status' { Show-RuntimeStatus }
    }
} catch {
    $failure = Protect-LogText $_.Exception.Message
    if ($Action -eq 'Hosted' -and $script:HostReceipt) {
        $cancelled = Test-HostedStopRequest $script:HostReceipt
        $script:HostReceipt.status = if ($cancelled) { 'stopped' } else { 'failed' }
        $script:HostReceipt.error = $failure
        try { Save-HostReceipt } catch {}
        # Do not abandon PG to task cleanup after a failed migration or app startup.
        try { Stop-HostedOwnedResources }
        catch { $failure += ' Normal cleanup could not complete; inspect host logs. No foreign process was killed.'; $cancelled = $false; $script:HostReceipt.status = 'failed' }
        $script:HostReceipt.error = if ($cancelled) { $null } else { $failure }
        try { Save-HostReceipt } catch {}
        if ($cancelled) { Write-RuntimeLog 'info' 'Windows host startup cancelled and owned resources stopped normally.'; exit 0 }
    }
    try { Write-RuntimeLog 'error' $failure -Failure }
    catch { Write-Host 'The error log could not be written; check the project directory permissions and disk space.' }
    Write-Host "[FAILED] CoreScope $Action failed during '$($script:StartupPhase)': $failure" -ForegroundColor Red
    Write-Host "Failure details: $StartupErrorLog"
    Write-Host "Step output: $StartupLog"
    exit 1
}
