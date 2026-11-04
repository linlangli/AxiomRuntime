import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsInputError } from "../config/service-exposure.js";

export function powershellCommand(source: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")];
}

export function windowsTaskManager(input: { label: string; root: string; kind: "api" | "tunnel"; run(command: string, args: string[]): Promise<string> }) {
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const command = (source: string) => input.run("powershell.exe", powershellCommand(`$ErrorActionPreference='Stop'; ${source}`));
  const taskName = quoted(input.label);
  async function status() {
    try {
      const output = await command(`$task=Get-ScheduledTask -TaskName ${taskName} -ErrorAction SilentlyContinue; if ($null -eq $task) { @{installed=$false;running=$false;autostart=$false}|ConvertTo-Json -Compress } else { @{installed=$true;running=($task.State -eq 'Running');autostart=(@($task.Triggers).Count -gt 0)}|ConvertTo-Json -Compress }`);
      const result = JSON.parse(output) as { installed: boolean; running: boolean; autostart: boolean };
      return { supported: true, ...result, manager: "Windows Task Scheduler", logPath: path.join(input.root, `${input.kind}-service.log`), baseUrl: "http://127.0.0.1:8080", detail: result.running ? "任务运行中" : result.installed ? "任务已安装但未运行" : "任务未安装" };
    } catch { throw new SettingsInputError("无法查询 Windows 任务计划程序，请确认当前用户拥有注册任务的权限。"); }
  }
  async function register(autostart: boolean) {
    await fs.mkdir(input.root, { recursive: true });
    const entry = fileURLToPath(new URL("../../server/managed-service.js", import.meta.url));
    const argument = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    const args = [entry, input.root, input.kind].map(argument).join(" ");
    await command(`$action=New-ScheduledTaskAction -Execute ${quoted(process.execPath)} -Argument ${quoted(args)} -WorkingDirectory ${quoted(input.root)}; $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero); $principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; $parameters=@{TaskName=${taskName};Action=$action;Settings=$settings;Principal=$principal;Force=$true}; ${autostart ? "$parameters.Trigger=New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId;" : ""} Register-ScheduledTask @parameters | Out-Null`);
  }
  async function control(action: string) {
    const before = await status();
    if (action === "stop" && before.installed) await command(`Stop-ScheduledTask -TaskName ${taskName}`);
    if (action === "stop" || action === "disable") {
      if (before.installed) await command(`$task=Get-ScheduledTask -TaskName ${taskName}; $xml=[xml](Export-ScheduledTask -TaskName ${taskName}); $xml.Task.Triggers.RemoveAll(); Register-ScheduledTask -TaskName ${taskName} -Xml $xml.OuterXml -Force | Out-Null`);
    } else {
      if (action === "restart" && before.running) await command(`Stop-ScheduledTask -TaskName ${taskName}`);
      if (!before.installed || action === "restart" || action === "enable") await register(action === "enable" || before.autostart);
      await command(`Start-ScheduledTask -TaskName ${taskName}`);
    }
    return status();
  }
  return { status, control };
}
