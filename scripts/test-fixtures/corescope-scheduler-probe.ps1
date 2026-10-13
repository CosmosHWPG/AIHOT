param(
    [Parameter(Mandatory=$true)][ValidateSet('Start','Inspect','Cleanup')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RuntimeScript,
    [Parameter(Mandatory=$true)][string]$SpecFile,
    [Parameter(Mandatory=$true)][string]$HeartbeatFile,
    [Parameter(Mandatory=$true)][string]$ReceiptFile,
    [string]$ProbePidFile
)
$ErrorActionPreference = 'Stop'

# Load the actual production functions, never the runtime's top-level action,
# environment, readiness checks or CoreScope application configuration.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($RuntimeScript,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production runtime failed PowerShell parsing.' }
$names = @('Connect-CoreScopeScheduler','New-CoreScopeTaskDefinition','Assert-CoreScopeTaskDefinition','Register-CoreScopeTask','Start-CoreScopeTask','Get-CoreScopeTaskInstances','Test-CoreScopeEngineAncestry')
$functions = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names},$true))
foreach ($name in $names) { if (@($functions | Where-Object Name -eq $name).Count -ne 1) { throw "Missing or ambiguous production function: $name" } }
. ([ScriptBlock]::Create(($functions | Sort-Object {$_.Extent.StartOffset} | ForEach-Object {$_.Extent.Text}) -join "`n"))
$spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($spec.TaskName -notmatch '^CoreScope-JobTest-[a-f0-9-]{36}$' -or $spec.UserSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Only this user and a unique fixture task are allowed.' }
if ($spec.Root -ne $spec.WorkingDirectory -or -not (Test-Path -LiteralPath $spec.Root -PathType Container)) { throw 'Fixture root must match its existing working directory.' }
if ((Split-Path -Parent $SpecFile) -ne $spec.Root -or (Split-Path -Parent $HeartbeatFile) -ne $spec.Root -or (Split-Path -Parent $ReceiptFile) -ne $spec.Root) { throw 'All fixture files must be inside the fixed fixture root.' }
function Save-FixtureValue($Value) {
    [IO.File]::WriteAllText($ReceiptFile,($Value | ConvertTo-Json -Depth 8 -Compress),(New-Object Text.UTF8Encoding($false)))
}
function Read-FixtureHeartbeat {
    try { return (Get-Content -LiteralPath $HeartbeatFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Get-FixtureProcess($Heartbeat) {
    $process = [Diagnostics.Process]::GetProcessById([int]$Heartbeat.pid)
    $creation = $process.StartTime.ToUniversalTime().ToString('o')
    $details = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f [int]$Heartbeat.pid)
    if (-not $details -or $details.ExecutablePath -ne $spec.Executable -or -not $details.CommandLine.Contains($Heartbeat.nonce)) { throw 'Heartbeat process identity differs from this task action.' }
    return [pscustomobject]@{pid=[int]$Heartbeat.pid;creationTimeUtc=$creation;executable=$details.ExecutablePath;commandLine=$details.CommandLine}
}
$rawProbe = $null
function Get-FixtureRawInstanceProbe($Service,$Task) {
    $value = [ordered]@{}
    foreach ($flags in @(0,1)) {
        $row = [ordered]@{}
        try {
            $collection = $Task.GetInstances($flags)
            $row.collectionType = if ($null -ne $collection) {$collection.GetType().FullName} else {'null'}
            $row.count = $collection.Count
            $row.pipelineArrayCount = @($collection).Count
            foreach ($index in @(0,1)) {
                try {
                    $instance = $collection.Item($index)
                    $row[('item'+$index)] = @{instanceId=[string]$instance.InstanceGuid;enginePid=[int]$instance.EnginePID;state=$instance.State}
                } catch { $row[('item'+$index+'Error')] = $_.Exception.Message }
            }
        } catch { $row.error = $_.Exception.Message }
        $value[('taskInstancesFlags'+$flags)] = $row
        $running = [ordered]@{matching=@()}
        try {
            $collection = $Service.GetRunningTasks($flags)
            $running.collectionType = if ($null -ne $collection) {$collection.GetType().FullName} else {'null'}
            $running.count = $collection.Count
            for ($index=1;$index -le [int]$collection.Count;$index++) {
                $instance=$collection.Item($index)
                if ($instance.Path -eq ('\'+$spec.TaskName)) {
                    $running.matching += @{instanceId=[string]$instance.InstanceGuid;enginePid=[int]$instance.EnginePID;state=$instance.State;index=$index}
                }
            }
        } catch { $running.error = $_.Exception.Message }
        $value[('serviceRunningFlags'+$flags)] = $running
    }
    return $value
}
function Get-FixtureVerifiedInstance($Task,[int]$ActionPid) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $instances = @(Get-CoreScopeTaskInstances $Task)
        if ($instances.Count -eq 1 -and $instances[0].instanceId -and (Test-CoreScopeEngineAncestry $instances[0].enginePid $ActionPid)) { return $instances[0] }
        if ([DateTime]::UtcNow -gt $deadline) { throw ('Production instance/ancestry gate failed: '+(@{count=$instances.Count;instances=$instances;actionPid=$ActionPid}|ConvertTo-Json -Depth 4 -Compress)) }
        Start-Sleep -Milliseconds 100
    } while ($true)
}
try {
    $service = Connect-CoreScopeScheduler
    $folder = $service.GetFolder('\')
    if ($Action -eq 'Start') {
        $task = Register-CoreScopeTask $service $spec
        # Idempotent registration must reuse this exact safe definition.
        $again = Register-CoreScopeTask $service $spec
        if ($again.Path -ne $task.Path) { throw 'Idempotent registration changed the task identity.' }
        Start-CoreScopeTask $task
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            $heartbeat = Read-FixtureHeartbeat
            if ($heartbeat -and $heartbeat.ticks -ge 3) { break }
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Scheduler fixture never produced its nonce heartbeat.' }
            Start-Sleep -Milliseconds 100
        } while ($true)
        $identity = Get-FixtureProcess $heartbeat
        $rawProbe = Get-FixtureRawInstanceProbe $service $task
        $instance = Get-FixtureVerifiedInstance $task ([int]$heartbeat.pid)
        $callerAncestry = Test-CoreScopeEngineAncestry $instance.enginePid $PID
        $scheduleAncestry = Test-CoreScopeEngineAncestry 0 ([int]$heartbeat.pid)
        if ($callerAncestry -or -not $scheduleAncestry) { throw 'The ancestry control did not distinguish Scheduler action from the isolated caller.' }
        Start-CoreScopeTask $task
        $reusedInstance = Get-FixtureVerifiedInstance $task ([int]$heartbeat.pid)
        if ($reusedInstance.instanceId -ne $instance.instanceId) { throw 'Repeated Start changed the existing running-task instance.' }
        $definition = $task.Definition
        $principal = [string]$definition.Principal.UserId
        $principalSid = if ($principal -match '^S-1-') { (New-Object Security.Principal.SecurityIdentifier($principal)).Value } else { (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value }
        $value = [ordered]@{state='ready';callerPid=$PID;heartbeat=$heartbeat;identity=$identity;taskPath=$task.Path;principal=$principal;principalSid=$principalSid;logonType=$definition.Principal.LogonType;runLevel=$definition.Principal.RunLevel;triggerCount=$definition.Triggers.Count;actionCount=$definition.Actions.Count;executionTimeLimit=$definition.Settings.ExecutionTimeLimit;multipleInstances=$definition.Settings.MultipleInstances;hidden=$definition.Settings.Hidden;instanceCount=1;instanceId=$instance.instanceId;enginePid=$instance.enginePid;engineAncestry=$true;scheduleAncestry=$scheduleAncestry;callerEngineAncestry=$callerAncestry;rawInstanceProbe=$rawProbe}
        if ($ProbePidFile) { [IO.File]::WriteAllText($ProbePidFile,(@{pids=@([int]$heartbeat.pid)} | ConvertTo-Json -Compress)) }
        Save-FixtureValue $value
        # Remain alive inside the private Job until its last handle is closed.
        while ([DateTime]::UtcNow -lt $deadline.AddSeconds(60)) { Start-Sleep -Milliseconds 100 }
        throw 'Caller unexpectedly reached its fixture lifetime limit.'
    } elseif ($Action -eq 'Inspect') {
        $task = $folder.GetTask($spec.TaskName)
        Assert-CoreScopeTaskDefinition $task.Definition $spec
        # writeFileSync briefly truncates the fake heartbeat before writing JSON.
        # Retry only unavailable/incomplete reads; all identity checks stay strict.
        $heartbeatDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $heartbeat = Read-FixtureHeartbeat
            if ($heartbeat) { break }
            if ([DateTime]::UtcNow -ge $heartbeatDeadline) { throw 'Independent inspection found no complete heartbeat within five seconds.' }
            Start-Sleep -Milliseconds 25
        } while ($true)
        $rawProbe = Get-FixtureRawInstanceProbe $service $task
        $instance = Get-FixtureVerifiedInstance $task ([int]$heartbeat.pid)
        Save-FixtureValue ([ordered]@{state='inspected';inspectorPid=$PID;heartbeat=$heartbeat;identity=(Get-FixtureProcess $heartbeat);taskPath=$task.Path;taskState=$task.State;instanceCount=1;instanceId=$instance.instanceId;enginePid=$instance.enginePid;engineAncestry=$true;scheduleAncestry=(Test-CoreScopeEngineAncestry 0 ([int]$heartbeat.pid));rawInstanceProbe=$rawProbe})
    } else {
        $task = $null
        try { $task = $folder.GetTask($spec.TaskName) } catch {
            $exception = $_.Exception
            while ($exception.InnerException) { $exception = $exception.InnerException }
            if ($exception.HResult -ne -2147024894) { throw }
        }
        if ($task) {
            # A receipt alone is never authority to stop/delete an unrelated task.
            Assert-CoreScopeTaskDefinition $task.Definition $spec
            $task.Stop(0)
            $folder.DeleteTask($spec.TaskName,0)
        }
        Save-FixtureValue (@{state='cleaned';taskExisted=[bool]$task;taskName=$spec.TaskName})
    }
} catch {
    Save-FixtureValue (@{state='failed';error=$_.Exception.Message;callerPid=$PID;rawInstanceProbe=$rawProbe})
    throw
}
