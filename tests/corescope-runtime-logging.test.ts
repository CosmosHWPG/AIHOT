import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const runtimeSource = path.resolve(import.meta.dirname, "../scripts/corescope-runtime.ps1");
const fakePassword = "runtime-test-only-password";
const fakeKey = "runtime-test-only-provider-key";

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "corescope-runtime-logging-"));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, ".data", "logs"), { recursive: true });
  await mkdir(path.join(root, ".data", "runtime"));
  await copyFile(runtimeSource, path.join(root, "scripts", "corescope-runtime.ps1"));
  await copyFile(path.resolve(import.meta.dirname, "../Start-CoreScope.cmd"), path.join(root, "Start-CoreScope.cmd"));
  return {
    root,
    async close() {
      for (const relative of [".env", "probe.ps1", "Start-CoreScope.cmd", "scripts/fail.mjs", "scripts/corescope-runtime.ps1", ".data/logs/startup.log", ".data/logs/startup.error.log"]) {
        await unlink(path.join(root, relative)).catch(() => {});
      }
      for (const relative of [".data/logs", ".data/runtime", ".data", "scripts", "."]) {
        await rmdir(path.join(root, relative));
      }
    },
  };
}

async function failingPowerShell(args: string[]) {
  try {
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { windowsHide: true, timeout: 15_000 });
    assert.fail("the sandboxed launch must fail");
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(typeof failure.code, "number", failure.message);
    assert.notEqual(failure.code, 0);
    return failure;
  }
}

test("the Windows cmd launcher preserves its failure exit and shows a durable redacted diagnostic", { skip: process.platform !== "win32" }, async () => {
  const instance = await sandbox();
  try {
    // The malformed URL fails before any database/process lookup. These are fake credentials.
    await writeFile(path.join(instance.root, ".env"), `DATABASE_URL="postgres://corescope:${fakePassword}@invalid host:5448/corescope"\nLLM_API_KEY=${fakeKey}\nWEB_PORT=8780\nAPI_PORT=8781\n`);
    const pending = run("cmd.exe", ["/d", "/c", path.join(instance.root, "Start-CoreScope.cmd")], { windowsHide: true, timeout: 15_000 });
    // A keypress dismisses the real launcher's pause after it has displayed the failure.
    pending.child.stdin?.end("\r\n");
    const failure = await pending.then(() => assert.fail("the sandboxed launch must fail"), (error: Error & { code: number; stdout: string; stderr: string }) => error);
    assert.equal(failure.code, 1);
    const raw = await readFile(path.join(instance.root, ".data", "logs", "startup.error.log"), "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, "Start");
    assert.equal(record.phase, "configuration");
    assert.equal(record.level, "error");
    assert.ok(Number.isFinite(Date.parse(record.at)));
    assert.match(record.message, /Invalid URI|URI is not valid|无法转换|无效/i);
    assert.match(failure.stdout, /\[FAILED\].*configuration/);
    assert.match(failure.stdout, /startup\.error\.log/);
    assert.match(failure.stdout, /Keep this window/);
    const allOutput = raw + failure.stdout + failure.stderr + await readFile(path.join(instance.root, ".data", "logs", "startup.log"), "utf8");
    assert.ok(!allOutput.includes(fakePassword));
    assert.ok(!allOutput.includes(fakeKey));
    assert.ok(!allOutput.includes('"Config"'));
  } finally {
    await instance.close();
  }
});

test("Windows native stderr retains an early OOM diagnostic even after a long stack trace", { skip: process.platform !== "win32" }, async () => {
  const instance = await sandbox();
  try {
    await writeFile(path.join(instance.root, ".env"), `LLM_API_KEY=${fakeKey}\n`);
    await writeFile(path.join(instance.root, "scripts", "fail.mjs"), `console.error("Error: out of memory; request key ${fakeKey}");\nfor (let index = 0; index < 80; index++) console.error("stack detail " + index);\nprocess.exit(17);\n`);
    await writeFile(path.join(instance.root, "probe.ps1"), `$ErrorActionPreference='Stop'
$ProjectRoot=$PSScriptRoot
$EnvFile=Join-Path $ProjectRoot '.env'
$StartupLog=Join-Path $ProjectRoot '.data\\logs\\startup.log'
$StartupErrorLog=Join-Path $ProjectRoot '.data\\logs\\startup.error.log'
$Action='Start'
$Node=(Get-Command node.exe).Source
$script:Config=[pscustomobject]@{LLM_API_KEY='${fakeKey}'}
$script:DbPassword=$null
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'scripts\\corescope-runtime.ps1'),[ref]$tokens,[ref]$parseErrors)
$names=@('Protect-LogText','Write-RuntimeLog','Write-Stage','Invoke-NodeScript')
foreach($statement in $ast.EndBlock.Statements){if($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -in $names){Invoke-Expression $statement.Extent.Text}}
try {Write-Stage 'seed' 'Synchronizing seed data.';Invoke-NodeScript 'scripts/fail.mjs'}
catch {Write-RuntimeLog 'error' $_.Exception.Message -Failure;Write-Host $_.Exception.Message;exit 1}
`);
    const failure = await failingPowerShell(["-File", path.join(instance.root, "probe.ps1")]);
    const raw = await readFile(path.join(instance.root, ".data", "logs", "startup.error.log"), "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.phase, "seed");
    assert.match(record.message, /fail\.mjs failed \(exit 17\)/);
    assert.match(record.message, /out of memory/i);
    const output = raw + failure.stdout + failure.stderr + await readFile(path.join(instance.root, ".data", "logs", "startup.log"), "utf8");
    assert.ok(!output.includes(fakeKey));
    assert.match(output, /\[redacted\]/);
    assert.match(output, /stack detail 79/);
  } finally {
    await instance.close();
  }
});
