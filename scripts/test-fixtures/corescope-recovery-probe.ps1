param(
    [Parameter(Mandatory=$true)][ValidateSet('Probe','Intent','IntentUpdate','IntentGate','OfflineStop','RecoveryPermit','PermitResume','PermitExpired','PermitNewIntent','Repair','Adopt','Task')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RuntimeScript,
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [Parameter(Mandatory=$true)][string]$Nonce,
    [int]$FakePid
)
$ErrorActionPreference = 'Stop'
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $FixtureRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $FixtureRoot) -notmatch '^corescope-recovery-test-' -or $Nonce -notmatch '^[a-f0-9-]{36}$') {
    throw 'Recovery tests require a new OS temporary fixture directory and nonce.'
}

# Load function definitions only. Do not read the real .env, enter an action,
# invoke CoreScope processes, or start/stop PostgreSQL.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($RuntimeScript,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production runtime failed PowerShell parsing.' }
$functions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
. ([ScriptBlock]::Create(($functions | ForEach-Object {$_.Extent.Text}) -join "`n"))
$ProjectRoot = $FixtureRoot
$RuntimeDir = $FixtureRoot
$LogDir = $FixtureRoot
$StartupLog = Join-Path $FixtureRoot 'startup.log'
$StartupErrorLog = Join-Path $FixtureRoot 'startup.error.log'
$CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Node = $NodeExecutable
$SupervisorEntry = Join-Path $FixtureRoot 'heartbeat.mjs'
$PgRoot = Join-Path $FixtureRoot 'fake-pg-runtime'
$PgData = Join-Path $FixtureRoot 'fake-pg-data'
$script:Config = $null
$script:DbPassword = $null
$script:StartupPhase = 'fixture'

function Write-FixtureResult($Value) { [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 12 -Compress)) }
function Assert-FixtureFailure([scriptblock]$Operation) {
    try { & $Operation | Out-Null; return $false } catch { return $true }
}

if ($Action -eq 'Probe') {
    $heartbeat = Get-Content -LiteralPath (Join-Path $FixtureRoot 'heartbeat.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($heartbeat.pid -ne $FakePid -or $heartbeat.nonce -ne $Nonce) { throw 'Only the fixture heartbeat may be inspected.' }
    $process = [Diagnostics.Process]::GetProcessById($FakePid)
    try {
        $record = [pscustomobject]@{pid=$FakePid;startedAt=$process.StartTime.ToUniversalTime().ToString('o');executable=$process.MainModule.FileName;entry=$SupervisorEntry}
    } finally { $process.Dispose() }
    $alive = Get-OwnedProcessProbe $record $SupervisorEntry
    $script:WmiCalls = 0
    function Get-CimInstance { $script:WmiCalls++; throw (New-Object Runtime.InteropServices.COMException('Fixture WMI unavailable',-2147217402)) }
    $wmiUnavailable = Get-OwnedProcessProbe $record $SupervisorEntry
    $mismatch = $record.PSObject.Copy()
    $mismatch.startedAt = [DateTimeOffset]::Parse($record.startedAt).AddMinutes(-2).ToString('o')
    $creationMismatch = Get-OwnedProcessProbe $mismatch $SupervisorEntry
    $mismatch = $record.PSObject.Copy()
    $mismatch.executable = Join-Path $FixtureRoot 'wrong-executable.exe'
    $executableMismatch = Get-OwnedProcessProbe $mismatch $SupervisorEntry
    $pgRecord = $record.PSObject.Copy()
    $pgRecord.entry = $PgData
    $receipt = [pscustomobject]@{pg=$pgRecord;supervisor=$record}
    function Get-NativeProcessSnapshot([int]$ProcessId) { return [pscustomobject]@{status='unknown';pid=$ProcessId;reason='probe_error'} }
    $unknown = Get-HostedLiveness $receipt 'System'
    function Get-OwnedProcessProbe($Record,[string]$ExpectedEntry) {
        $status = if ($Record.marker -eq 'fixture-exited') {'exited'} else {'alive'}
        return [pscustomobject]@{status=$status;pid=$Record.pid;reason='Fixture explicit result'}
    }
    $healthy = Get-HostedLiveness $receipt 'System'
    $receipt.supervisor = [pscustomobject]@{pid=100;marker='fixture-exited'}
    $missing = Get-HostedLiveness $receipt 'System'
    Write-FixtureResult @{alive=$alive;wmiUnavailable=$wmiUnavailable;wmiCalls=$script:WmiCalls;creationMismatch=$creationMismatch;executableMismatch=$executableMismatch;healthy=$healthy;unknown=$unknown;missing=$missing}
    exit 0
}

if ($Action -in @('Intent','IntentUpdate')) {
    if ($Action -eq 'IntentUpdate') {
        $written = Set-CoreScopeDesiredState -State running -Mode System
        Write-FixtureResult $written
        exit 0
    }
    Set-CoreScopeDesiredState -State stopped -Mode System | Out-Null
    $stopped = Get-CoreScopeDesiredState 'System'
    Set-CoreScopeDesiredState -State stopped -Mode Database | Out-Null
    Set-CoreScopeDesiredState -State running -Mode System | Out-Null
    $running = Get-CoreScopeDesiredState 'System'
    $database = Get-CoreScopeDesiredState 'Database'
    $stateFile = Join-Path $FixtureRoot 'desired-state.json'
    $saved = [IO.File]::ReadAllText($stateFile)
    try {
        $corrupt = $saved | ConvertFrom-Json
        $corrupt.root = Join-Path $FixtureRoot 'other-root'
        [IO.File]::WriteAllText($stateFile,($corrupt | ConvertTo-Json -Depth 12))
        $rootRejected = Assert-FixtureFailure { Get-CoreScopeDesiredState 'System' }
        $rootWriteRejected = Assert-FixtureFailure { Set-CoreScopeDesiredState -State running -Mode System }
        $corrupt = $saved | ConvertFrom-Json
        $corrupt.userSid = 'S-1-0-0'
        [IO.File]::WriteAllText($stateFile,($corrupt | ConvertTo-Json -Depth 12))
        $userRejected = Assert-FixtureFailure { Get-CoreScopeDesiredState 'System' }
        $userWriteRejected = Assert-FixtureFailure { Set-CoreScopeDesiredState -State running -Mode System }
    } finally { [IO.File]::WriteAllText($stateFile,$saved) }
    Write-FixtureResult @{stopped=$stopped;running=$running;database=$database;rootRejected=$rootRejected;userRejected=$userRejected;rootWriteRejected=$rootWriteRejected;userWriteRejected=$userWriteRejected}
    exit 0
}

if ($Action -eq 'OfflineStop') {
    Set-CoreScopeDesiredState -State running -Mode System | Out-Null
    Set-CoreScopeDesiredState -State running -Mode Database | Out-Null
    $StateFile = Join-Path $FixtureRoot 'no-supervisor-state.json'
    $script:ExternalRuntimeCalls = 0
    $script:StopRequests = 0
    function Write-HostedStopRequest { $script:StopRequests++ }
    function Get-SupervisorState { return $null }
    function Get-OwnedPostgresPid { return 0 }
    function Invoke-NodeScript { $script:ExternalRuntimeCalls++; throw 'An offline fixture must never call a runtime process.' }
    Stop-System 6>$null
    Write-FixtureResult @{system=(Get-CoreScopeDesiredState 'System');database=(Get-CoreScopeDesiredState 'Database');externalRuntimeCalls=$script:ExternalRuntimeCalls;stopRequests=$script:StopRequests}
    exit 0
}

if ($Action -eq 'IntentGate') {
    $first = Set-CoreScopeDesiredState -State running -Mode System
    $receipt = [pscustomobject]@{root=$ProjectRoot;userSid=$CurrentUserSid;mode='System';nonce=$Nonce;instanceId='fixture-instance';intentGeneration=$first.generation}
    $currentAllowed = -not (Test-HostedStopRequest $receipt)
    Set-CoreScopeDesiredState -State stopped -Mode System | Out-Null
    $fresh = [pscustomobject]@{root=$ProjectRoot;userSid=$CurrentUserSid;mode='System';nonce=[Guid]::NewGuid().ToString('N');instanceId='fresh-fixture-instance'}
    $freshHostCancelled = Test-HostedStopRequest $fresh
    $next = Set-CoreScopeDesiredState -State running -Mode System
    $oldGenerationCancelled = Test-HostedStopRequest $receipt
    $script:HostReceipt = $receipt
    $HostMode = 'System'
    function Invoke-HostedStartGuard([string]$Action='Hosted') { Assert-HostedStartAllowed }
    $oldGenerationCannotStart = Assert-FixtureFailure {Invoke-HostedStartGuard}
    $receipt.intentGeneration = $next.generation
    $newGenerationAllowed = -not (Test-HostedStopRequest $receipt)
    $currentStartAllowed = -not (Assert-FixtureFailure {Invoke-HostedStartGuard})
    $stateFile = Join-Path $FixtureRoot 'desired-state.json'
    $saved = [IO.File]::ReadAllText($stateFile)
    try {
        [IO.File]::WriteAllText($stateFile,'{invalid JSON')
        $unreadableIntentDoesNotStop = -not (Test-HostedStopRequest $receipt)
        $unreadableIntentCannotStart = Assert-FixtureFailure {Invoke-HostedStartGuard}
    } finally { [IO.File]::WriteAllText($stateFile,$saved) }
    $missingFile = Join-Path $FixtureRoot 'state-temporarily-absent.json'
    [IO.File]::Move($stateFile,$missingFile)
    try { $missingIntentCannotStart = Assert-FixtureFailure {Invoke-HostedStartGuard} }
    finally { [IO.File]::Move($missingFile,$stateFile) }
    Write-FixtureResult @{currentAllowed=$currentAllowed;freshHostCancelled=$freshHostCancelled;oldGenerationCancelled=$oldGenerationCancelled;newGenerationAllowed=$newGenerationAllowed;unreadableIntentDoesNotStop=$unreadableIntentDoesNotStop;firstGeneration=$first.generation;nextGeneration=$next.generation;currentStartAllowed=$currentStartAllowed;oldGenerationCannotStart=$oldGenerationCannotStart;unreadableIntentCannotStart=$unreadableIntentCannotStart;missingIntentCannotStart=$missingIntentCannotStart}
    exit 0
}

if ($Action -in @('RecoveryPermit','PermitResume','PermitExpired','PermitNewIntent')) {
    $HostMode = 'System'
    $script:HostReceipt = @{nonce=$Nonce;intentGeneration=$Nonce}
    $historyFile = Join-Path $FixtureRoot 'recovery-system.json'
    if ($Action -eq 'RecoveryPermit') {
        $permits = @(Get-HostedRecoveryPermit;Get-HostedRecoveryPermit;Get-HostedRecoveryPermit;Get-HostedRecoveryPermit)
        $history = Get-Content -LiteralPath $historyFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-FixtureResult @{permits=$permits;attempts=@($history.attempts).Count;generation=$history.generation}
        exit 0
    }
    if ($Action -eq 'PermitExpired') {
        $history = Get-Content -LiteralPath $historyFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $history.attempts = @([DateTimeOffset]::Now.AddMinutes(-11).ToString('o'),[DateTimeOffset]::Now.AddMinutes(-12).ToString('o'),[DateTimeOffset]::Now.AddMinutes(-13).ToString('o'))
        [IO.File]::WriteAllText($historyFile,($history | ConvertTo-Json -Depth 6))
    }
    if ($Action -eq 'PermitNewIntent') { $script:HostReceipt.intentGeneration = $Nonce + '-new-running-intent' }
    $permit = Get-HostedRecoveryPermit
    $history = Get-Content -LiteralPath $historyFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-FixtureResult @{permit=$permit;attempts=@($history.attempts).Count;generation=$history.generation}
    exit 0
}

if ($Action -eq 'Repair') {
    function Reset-RepairFixture {
        $script:HostReceipt = @{status='ready';error=$null;nonce=$Nonce;intentGeneration=$Nonce;mode='System'}
        $script:Calls = New-Object 'System.Collections.Generic.List[string]'
        $script:FixtureStopped = $false
        $script:BackoffCancelled = $false
        $script:StopAfterDrain = $false
        $script:PermitAllowed = $true
        $script:SupervisorExists = $true
        $script:HostMode = 'System'
    }
    function Save-HostReceipt { $script:Calls.Add('save') }
    function Get-HostedRecoveryPermit { return @{allowed=$script:PermitAllowed;delaySeconds=0} }
    function Test-HostedStopRequest($Receipt) { return $script:FixtureStopped }
    function Wait-HostedRecoveryDelay([int]$Seconds) { $script:Calls.Add('wait');return -not $script:BackoffCancelled }
    function Write-RuntimeLog { $script:Calls.Add('log') }
    function Write-Stage([string]$Phase,[string]$Message) { $script:Calls.Add('stage:'+$Phase) }
    function Write-LifecycleAudit { return 'fixture-recovery-request' }
    function Get-SupervisorState { if ($script:SupervisorExists) { return @{supervisor=@{pid=600}} };return $null }
    function Invoke-NodeScript([string]$RelativePath,[string[]]$ExtraArgs) {
        if ($RelativePath -ne 'scripts/corescope-runtime.ts' -or $ExtraArgs[0] -ne 'stop' -or $ExtraArgs[2] -ne 'recovery') { throw 'Unexpected isolated repair runtime invocation.' }
        $script:Calls.Add('stop')
    }
    function Wait-OwnedApplicationsDrained { $script:Calls.Add('drain');if($script:StopAfterDrain){$script:FixtureStopped=$true};return $true }
    function Start-System([switch]$Recovery) { if(-not $Recovery){throw 'A repair must request recovery mode'};$script:Calls.Add('start-system') }
    function Start-Database { $script:Calls.Add('start-database') }
    function Get-RepairFixtureResult { return @{external=@($script:Calls | Where-Object {$_ -in @('stop','start-system','start-database')});status=$script:HostReceipt.status} }
    $result = @{}
    foreach ($status in @('healthy','unknown','mismatch')) {
        Reset-RepairFixture
        Repair-HostedResources @{status=$status;resource='postgres'}
        $result[$status] = Get-RepairFixtureResult
    }
    foreach ($scenario in @('alreadyStopped','cancelledBackoff','cooldown','postgresMissing','supervisorMissing','stoppedAfterDrain','databaseMissing')) {
        Reset-RepairFixture
        if($scenario -eq 'alreadyStopped'){$script:FixtureStopped=$true}
        if($scenario -eq 'cancelledBackoff'){$script:BackoffCancelled=$true}
        if($scenario -eq 'cooldown'){$script:PermitAllowed=$false}
        if($scenario -eq 'supervisorMissing'){$script:SupervisorExists=$false}
        if($scenario -eq 'stoppedAfterDrain'){$script:StopAfterDrain=$true}
        if($scenario -eq 'databaseMissing'){$script:HostMode='Database'}
        $resource = if($scenario -eq 'supervisorMissing'){'supervisor'}else{'postgres'}
        Repair-HostedResources @{status='missing';resource=$resource}
        $result[$scenario] = Get-RepairFixtureResult
    }
    Write-FixtureResult $result
    exit 0
}

if ($Action -eq 'Adopt') {
    function Reset-AdoptFixture {
        $script:HostReceipt = [ordered]@{pg=$null;supervisor=$null}
        $script:ProbeStatuses = @{100='exited';200='alive';300='alive'}
        $script:CommandValid = $true
        $script:FixturePgPid = 200
        $script:FixtureSupervisorPid = 300
        $script:Saved = $false
        $script:Adopted = New-Object 'System.Collections.Generic.List[int]'
    }
    function Get-OwnedProcessProbe($Record,[string]$ExpectedEntry) { return @{status=$script:ProbeStatuses[[int]$Record.pid];pid=$Record.pid} }
    function Test-OwnedProcess($Record,[string]$ExpectedEntry) { return $script:CommandValid }
    function Get-OwnedPostgresPid { return $script:FixturePgPid }
    function Get-SupervisorState { return @{supervisor=@{pid=$script:FixtureSupervisorPid}} }
    function Save-HostReceipt { $script:Saved=$true }
    function Write-LifecycleAudit([string]$Operation,[string]$Reason,[int]$TargetPid) {
        if($Operation -ne 'resource-adopted'){throw 'Unexpected fixture audit operation'}
        $script:Adopted.Add($TargetPid)
        return 'fixture-adoption-request'
    }
    $previous = @{host=@{pid=100;entry=$RuntimeScript};pg=@{pid=200;entry=$PgData};supervisor=@{pid=300;entry=$SupervisorEntry}}
    $result = @{}
    foreach($scenario in @('hostAlive','hostUnknown','resourceUnknown','supervisorUnknown','commandMismatch','pidFileMismatch','supervisorReceiptMismatch','matching')) {
        Reset-AdoptFixture
        if($scenario -eq 'hostAlive'){$script:ProbeStatuses[100]='alive'}
        if($scenario -eq 'hostUnknown'){$script:ProbeStatuses[100]='unknown'}
        if($scenario -eq 'resourceUnknown'){$script:ProbeStatuses[200]='unknown'}
        if($scenario -eq 'supervisorUnknown'){$script:ProbeStatuses[300]='unknown'}
        if($scenario -eq 'commandMismatch'){$script:CommandValid=$false}
        if($scenario -eq 'pidFileMismatch'){$script:FixturePgPid=999}
        if($scenario -eq 'supervisorReceiptMismatch'){$script:FixtureSupervisorPid=999}
        $rejected = Assert-FixtureFailure {Adopt-PreviousHostedResources $previous}
        $result[$scenario] = @{rejected=$rejected;saved=$script:Saved;pgPid=$script:HostReceipt.pg.pid;supervisorPid=$script:HostReceipt.supervisor.pid;adopted=@($script:Adopted)}
    }
    Write-FixtureResult $result
    exit 0
}

# This creates no process: it registers only one unique, non-running test task.
$taskName = "CoreScope-RecoveryTest-$Nonce"
$spec = [pscustomobject]@{
    TaskName=$taskName;UserSid=$CurrentUserSid;Root=$FixtureRoot;Executable=$NodeExecutable
    Arguments=('"{0}" "{1}" "{2}" "{3}"' -f $SupervisorEntry,(Join-Path $FixtureRoot 'heartbeat.json'),$Nonce,(Join-Path $FixtureRoot 'heartbeat-stop'))
    WorkingDirectory=$FixtureRoot;Description="CoreScope isolated recovery fixture $Nonce";Mode='System';RecoveryPolicy=$false
}
$service = Connect-CoreScopeScheduler
$folder = $service.GetFolder('\')
$createdTask = $false
try {
    $existing = $null
    try { $existing = $folder.GetTask($taskName) }
    catch {
        $exception = $_.Exception
        while ($exception.InnerException) { $exception = $exception.InnerException }
        if ($exception.HResult -ne -2147024894) { throw }
    }
    if ($existing) { throw 'Unique fixture task already exists; it was not changed.' }
    $task = Register-CoreScopeTask $service $spec
    $createdTask = $true
    $legacy = @{triggerCount=[int]$task.Definition.Triggers.Count}
    $spec.RecoveryPolicy = $true
    $task = Register-CoreScopeTask $service $spec
    $definition = $task.Definition
    $logonUser = [string]$definition.Triggers.Item(1).UserId
    $logonSid = if ($logonUser -match '^S-1-') {$logonUser} else {(New-Object Security.Principal.NTAccount($logonUser)).Translate([Security.Principal.SecurityIdentifier]).Value}
    $recovery = @{triggerCount=[int]$definition.Triggers.Count;restartCount=[int]$definition.Settings.RestartCount;restartInterval=[string]$definition.Settings.RestartInterval;executionTimeLimit=[string]$definition.Settings.ExecutionTimeLimit;logonSid=$logonSid}
    $databaseSpec = $spec.PSObject.Copy()
    $databaseSpec.Mode = 'Database'
    $databaseDefinition = New-CoreScopeTaskDefinition $service $databaseSpec
    Assert-CoreScopeTaskDefinition $databaseDefinition $databaseSpec
    $database = @{triggerCount=[int]$databaseDefinition.Triggers.Count;restartCount=[int]$databaseDefinition.Settings.RestartCount}
    $definition.Actions.Item(1).Arguments += ' --fixture-action-tampered'
    $task = $folder.RegisterTaskDefinition($taskName,$definition,4,$CurrentUserSid,$null,3,$null)
    $before = [string]$task.Xml
    $changedActionRejected = Assert-FixtureFailure { Register-CoreScopeTask $service $spec }
    $changedActionPreserved = [string]$folder.GetTask($taskName).Xml -eq $before
} finally {
    if ($createdTask) { try {
        $owned = $folder.GetTask($taskName)
        if ($owned.Definition.RegistrationInfo.Description -ne $spec.Description -or $owned.Definition.Actions.Item(1).Path -ne $NodeExecutable -or
            $owned.Definition.Actions.Item(1).WorkingDirectory -ne $FixtureRoot -or $owned.State -eq 4) { throw 'Fixture cleanup ownership gate failed.' }
        $folder.DeleteTask($taskName,0)
    } catch { if ($_.Exception.HResult -ne -2147024894) { throw } } }
}
$taskDeleted = $false
try { $folder.GetTask($taskName) | Out-Null } catch { $taskDeleted = $true }
Write-FixtureResult @{legacy=$legacy;recovery=$recovery;database=$database;userSid=$CurrentUserSid;changedActionRejected=$changedActionRejected;changedActionPreserved=$changedActionPreserved;taskDeleted=$taskDeleted}
