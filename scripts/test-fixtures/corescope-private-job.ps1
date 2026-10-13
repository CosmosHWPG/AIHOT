param(
    [Parameter(Mandatory=$true)][string]$CommandFile,
    [Parameter(Mandatory=$true)][string]$ReceiptFile,
    [Parameter(Mandatory=$true)][string]$CloseFile,
    [string]$NegativeCommandFile,
    [string]$ProbePidFile,
    [ValidateRange(5,600)][int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'

# This fixture owns only its newly created, non-inheritable Job. It never opens,
# closes or terminates the calling Codex Job, nor terminates a PID from a receipt.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class CoreScopeFixtureProcess {
    public int pid;
    public bool alive;
    public bool? inJob;
    public string creationTimeUtc;
}
public static class CoreScopeFixtureJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit; public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public uint cb; public string reserved, desktop, title;
        public uint x,y,width,height,xChars,yChars,fill,flags;
        public ushort showWindow,reservedBytes; public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process,thread; public uint processId,threadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public uint length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit info,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle,out uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SecurityAttributes attributes,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inJob);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool okay,string operation) { if(!okay) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
    static string Quote(string value) {
        StringBuilder result=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='\"') result.Append('\\',slashes*2+1).Append(c);
            else result.Append('\\',slashes).Append(c);
            slashes=0;
        }
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    public static IntPtr Create(string name) {
        IntPtr job=CreateJobObject(IntPtr.Zero,name);
        if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"Create private fixture Job");
        try {
            ExtendedLimit limits=new ExtendedLimit(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE only; no breakaway allowance.
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))),"Set private Job kill-on-close");
            Check(SetHandleInformation(job,1,0),"Clear private Job handle inheritance");
            uint flags; Check(GetHandleInformation(job,out flags),"Verify private Job handle flags");
            if((flags&1)!=0) throw new InvalidOperationException("Private Job handle is inheritable");
            return job;
        } catch { CloseHandle(job); throw; }
    }
    public static CoreScopeFixtureProcess Start(IntPtr job,string executable,string[] arguments,string directory,string[] environment,string stdoutFile,string stderrFile) {
        StringBuilder command=new StringBuilder(Quote(executable));
        foreach(string argument in arguments) command.Append(' ').Append(Quote(argument));
        string block=String.Join("\0",environment)+"\0\0";
        IntPtr memory=Marshal.StringToHGlobalUni(block);
        StartupInfoEx startup=new StartupInfoEx(); startup.startup.cb=(uint)Marshal.SizeOf(typeof(StartupInfoEx));
        startup.startup.flags=0x101; startup.startup.showWindow=0; // USESTDHANDLES + USESHOWWINDOW(SW_HIDE).
        IntPtr input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,handles=IntPtr.Zero;
        bool attributesInitialized=false;
        ProcessInfo info=new ProcessInfo(); bool created=false;
        try {
            SecurityAttributes security=new SecurityAttributes(); security.length=(uint)Marshal.SizeOf(typeof(SecurityAttributes)); security.inherit=true;
            input=CreateFile("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero);
            if(input==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Open fixture stdin NUL");
            output=CreateFile(stdoutFile,0x40000000,3,ref security,2,0x80,IntPtr.Zero);
            if(output==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Open fixture stdout log");
            error=CreateFile(stderrFile,0x40000000,3,ref security,2,0x80,IntPtr.Zero);
            if(error==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Open fixture stderr log");
            startup.startup.input=input; startup.startup.output=output; startup.startup.error=error;
            IntPtr bytes=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
            startup.attributes=Marshal.AllocHGlobal(bytes);
            Check(InitializeProcThreadAttributeList(startup.attributes,1,0,ref bytes),"Initialize fixture stdio handle allowlist");
            attributesInitialized=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
            Check(UpdateProcThreadAttribute(startup.attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Limit fixture inheritance to stdio");
            // Suspended assignment removes the race in which a caller launches a
            // descendant before entering the private Job. Only listed stdio file
            // handles are inherited, never the private Job or any other handle.
            // No visible console and no inherited caller console. Explicit stdio
            // makes errors observable even for this isolated suspended caller.
            created=CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,memory,directory,ref startup,out info);
            Check(created,"Create suspended fixture caller");
            Check(AssignProcessToJobObject(job,info.process),"Assign fixture caller to private Job");
            if(ResumeThread(info.thread)==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume fixture caller");
            return Snapshot((int)info.processId,job);
        } catch {
            // This handle is only the process this exact invocation created.
            if(created) TerminateProcess(info.process,125);
            throw;
        } finally {
            if(info.thread!=IntPtr.Zero) CloseHandle(info.thread);
            if(info.process!=IntPtr.Zero) CloseHandle(info.process);
            if(attributesInitialized) DeleteProcThreadAttributeList(startup.attributes);
            if(startup.attributes!=IntPtr.Zero) Marshal.FreeHGlobal(startup.attributes);
            if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
            foreach(IntPtr handle in new IntPtr[]{input,output,error}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
            Marshal.FreeHGlobal(memory);
        }
    }
    public static CoreScopeFixtureProcess Snapshot(int pid,IntPtr job) {
        CoreScopeFixtureProcess result=new CoreScopeFixtureProcess(); result.pid=pid;
        IntPtr process=OpenProcess(0x1000,false,(uint)pid);
        if(process==IntPtr.Zero) return result;
        try {
            uint code; Check(GetExitCodeProcess(process,out code),"Read fixture process exit status"); result.alive=code==259;
            FileTime creation,exit,kernel,user;
            Check(GetProcessTimes(process,out creation,out exit,out kernel,out user),"Read fixture process creation time");
            long filetime=((long)creation.high<<32)|creation.low;
            result.creationTimeUtc=DateTime.FromFileTimeUtc(filetime).ToString("o");
            // IntPtr.Zero deliberately means no membership query after our Job
            // handle closes, not IsProcessInJob(process,NULL)'s 'any Job'.
            if(job!=IntPtr.Zero) { bool member; Check(IsProcessInJob(process,job,out member),"Read specific private Job membership"); result.inJob=member; }
            return result;
        } finally { CloseHandle(process); }
    }
    public static void Close(IntPtr job) { if(job!=IntPtr.Zero) Check(CloseHandle(job),"Close last private Job handle"); }
}
'@

function Read-FixtureCommand([string]$File) {
    $spec = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $spec.executable -or -not [IO.Path]::IsPathRooted($spec.executable) -or -not (Test-Path -LiteralPath $spec.executable -PathType Leaf)) { throw 'Fixture executable must be an existing absolute file.' }
    if (-not $spec.workingDirectory -or -not [IO.Path]::IsPathRooted($spec.workingDirectory) -or -not (Test-Path -LiteralPath $spec.workingDirectory -PathType Container)) { throw 'Fixture working directory must exist and be absolute.' }
    if ($null -eq $spec.args -or @($spec.args | Where-Object { $_ -isnot [string] }).Count) { throw 'Fixture args must be an array of strings.' }
    return $spec
}
function Write-FixtureReceipt($Value) {
    $temporary = $ReceiptFile + '.writing'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $ReceiptFile -Force
}
function Read-FixtureProbes([IntPtr]$Job) {
    $results = @()
    if ($ProbePidFile -and (Test-Path -LiteralPath $ProbePidFile)) {
        try { $probe = Get-Content -LiteralPath $ProbePidFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $results }
        foreach ($processId in @($probe.pids)) {
            if ($processId -isnot [int] -and $processId -isnot [long]) { throw 'Probe PID must be an integer.' }
            if ($processId -le 0 -or $processId -gt [int]::MaxValue) { throw 'Probe PID is outside the supported process range.' }
            $results += [CoreScopeFixtureJob]::Snapshot([int]$processId,$Job)
        }
    }
    return $results
}

# Only nonsecret system process prerequisites are forwarded; no .env or API key
# is read. The command itself may be an explicitly authorized caller supplied by
# the root agent, while normal tests use only nonce heartbeat fixtures.
$systemNames = @('SystemRoot','WINDIR','SystemDrive','ComSpec','Path','TEMP','TMP','USERPROFILE','USERNAME','USERDOMAIN','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH')
$environment = @()
foreach ($name in $systemNames) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $environment += $name + '=' + $value }
}
$environment += 'COLLECT_ENABLED=false'
$environment += 'MODEL_CALLS_ENABLED=false'
$environment = @($environment | Sort-Object)
$callerSpec = Read-FixtureCommand $CommandFile
$negativeSpec = if ($NegativeCommandFile) { Read-FixtureCommand $NegativeCommandFile } else { $null }
$nonce = [Guid]::NewGuid().ToString()
$jobName = 'CoreScope-PrivateJob-' + $nonce
$job = [IntPtr]::Zero
$receipt = [ordered]@{ schemaVersion=1; nonce=$nonce; jobName=$jobName; jobHostPid=$PID; jobFlags=8192; handleInheritable=$false; state='starting'; caller=$null; negative=$null; probesBefore=@(); probesAfter=@() }
try {
    $job = [CoreScopeFixtureJob]::Create($jobName)
    $receipt.caller = [CoreScopeFixtureJob]::Start($job,$callerSpec.executable,[string[]]$callerSpec.args,$callerSpec.workingDirectory,[string[]]$environment,($CommandFile+'.stdout.log'),($CommandFile+'.stderr.log'))
    if ($negativeSpec) { $receipt.negative = [CoreScopeFixtureJob]::Start($job,$negativeSpec.executable,[string[]]$negativeSpec.args,$negativeSpec.workingDirectory,[string[]]$environment,($NegativeCommandFile+'.stdout.log'),($NegativeCommandFile+'.stderr.log')) }
    $receipt.state = 'running'
    Write-FixtureReceipt $receipt
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $CloseFile)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Private Job fixture timed out waiting for its own close file.' }
        Start-Sleep -Milliseconds 75
    }
    $receipt.probesBefore = @(Read-FixtureProbes $job)
    $receipt.callerBefore = [CoreScopeFixtureJob]::Snapshot($receipt.caller.pid,$job)
    if ($receipt.negative) { $receipt.negativeBefore = [CoreScopeFixtureJob]::Snapshot($receipt.negative.pid,$job) }
    [CoreScopeFixtureJob]::Close($job)
    $job = [IntPtr]::Zero
    $receipt.closedAt = [DateTime]::UtcNow.ToString('o')
    Start-Sleep -Milliseconds 500
    $receipt.callerAfter = [CoreScopeFixtureJob]::Snapshot($receipt.caller.pid,[IntPtr]::Zero)
    if ($receipt.negative) { $receipt.negativeAfter = [CoreScopeFixtureJob]::Snapshot($receipt.negative.pid,[IntPtr]::Zero) }
    $receipt.probesAfter = @(Read-FixtureProbes ([IntPtr]::Zero))
    $receipt.state = 'closed'
    Write-FixtureReceipt $receipt
} catch {
    $receipt.state = 'failed'
    $receipt.error = $_.Exception.Message
    Write-FixtureReceipt $receipt
    throw
} finally {
    if ($job -ne [IntPtr]::Zero) { [CoreScopeFixtureJob]::Close($job) }
}
