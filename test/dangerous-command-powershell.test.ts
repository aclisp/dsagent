import { describe, expect, it } from "vitest";
import { detectDangerousCommand } from "../packages/core/src/dangerous-command.ts";

const assess = (command: string) => detectDangerousCommand(command, "win32");

describe("PowerShell destructive-command approval", () => {
  it.each([
    "Remove-Item -Recurse -Force build", "remove-item build", "REMOVE-ITEM build",
    "ri build", "del build", "erase build", "rd build", "rm build", "rmdir build",
    "Microsoft.PowerShell.Management\\Remove-Item -LiteralPath 'C:\\项目 files\\old'",
    "& 'Remove-Item' build", '& "Remove-Item" build', "Remove`-Item build",
    "Remove-Item `\n -LiteralPath 'C:\\build'", "Remove-Item 'C:\\O''Brien\\old'",
    "Clear-Content data.txt", "clc data.txt", "Set-Content data.txt value", "sc data.txt value",
    "Clear-Item HKCU:\\Software\\fixture", "cli HKCU:\\Software\\fixture",
    "Remove-ItemProperty HKCU:\\Software\\fixture -Name value", "rp HKCU:\\Software\\fixture -Name value",
    "Clear-ItemProperty HKCU:\\Software\\fixture -Name value", "clp HKCU:\\Software\\fixture -Name value",
    "Out-File result.txt", "Out-File result.txt -Append:$false",
    "Stop-Process -Id 123", "spps -Id 123", "kill -Id 123",
    "Stop-Service fixture", "spsv fixture", "Restart-Service fixture", "Suspend-Service fixture",
    "Remove-Service fixture", "Stop-Computer", "Restart-Computer -Force",
    "Format-Volume -DriveLetter X", "Clear-Disk -Number 99", "Initialize-Disk -Number 99",
    "Remove-Partition -DiskNumber 99 -PartitionNumber 1", "Resize-Partition -DriveLetter X -Size 1GB",
    "taskkill.exe /PID 123 /F", "shutdown.exe /s /t 0", "format.com X:", "diskpart.exe /s disk.txt",
    "Start-Process notepad.exe -Verb RunAs", "saps notepad.exe -Verb:RunAs", "sc.exe stop fixture",
    "Remove-Item --help", "rm --version", "Remove-Item -Path '--help'",
    "Remove-Item build -WhatIf:$false", "Remove-Item build -WhatIf:$preview",
    "Remove-Item build '-WhatIf'", 'Remove-Item build "-WhatIf"',
    "Remove-Item build -WhatIf -WhatIf:$false", "Remove-Item build -Confirm:$false",
    "Remove-Item -- -WhatIf", "Clear-Content -- -?", "Out-File -- -Append",
    "Write-Output test > result.txt", "Write-Error test 2> error.txt", "'text' *> result.txt",
    "Remove-Item build -WhatIf > result.txt",
  ])("requires approval for %s", command => {
    expect(assess(command), command).toMatchObject({ dangerous: true, intent: expect.any(String), reason: expect.any(String) });
  });

  it.each([
    "Get-ChildItem", "Get-Content -LiteralPath 'C:\\项目 files\\file.txt'", "Get-Process", "Get-Service",
    "Get-Command Remove-Item", "Get-Help Remove-Item", "Write-Output Remove-Item",
    "Write-Output 'Remove-Item file; Stop-Computer'", 'Write-Output "Remove-Item file; Stop-Computer"',
    "'Remove-Item'", '"Remove-Item"', "Write-Output 'O''Brien; Remove-Item file'",
    'Write-Output "C:\\work\\"; Get-Content file.txt', 'Write-Output "a`"; Remove-Item file"',
    "# Remove-Item file\nGet-Content file.txt", "<# Remove-Item file #> Get-Content file.txt",
    "<# outer <# Remove-Item file #> end #> Get-Content file.txt",
    "Write-Output @'\nRemove-Item file\nStop-Computer\n'@",
    'Write-Output @"\nRemove-Item file\nStop-Computer\n"@',
    "function cleanup { Remove-Item file }; Get-Content file.txt",
    "function Remove-Item { Write-Output harmless }", "$action = { Remove-Item file }",
    "Write-Output { Remove-Item file }", "@('Remove-Item', 'Stop-Computer')",
    "Remove-Item build -WhatIf", "RI build -WHATIF:$true", "Clear-Content file.txt -WhatIf",
    "Remove-Item -WhatIf -- file",
    "Stop-Process -Id 123 -WhatIf", "Remove-Item -?", "Format-Volume -DriveLetter X -WhatIf",
    "Out-File result.txt -Append", "Out-File result.txt -Append:$true",
    "Write-Output test >> result.txt", "Write-Output test > $null", "Write-Output test *> $null",
    "Write-Output test 2>&1", "Write-Output --% literal ; Remove-Item file",
    "sc.exe query fixture", "pwsh --version", "powershell.exe -?", "Start-Process notepad.exe -Verb RunAs -WhatIf",
    "Start-Process notepad.exe -- -Verb RunAs", "'cleanup.ps1'", "Write-Output 'cleanup.ps1'",
    "git.exe status", "git.exe clean -nd", "docker.exe compose --dry-run down -v",
  ])("keeps data, inspection, and literal previews out of destructive approval: %s", command => {
    expect(assess(command), command).toEqual({ dangerous: false });
  });

  it.each([
    "Get-ChildItem build | Remove-Item -Force", "Get-Content file.txt; Remove-Item build", "Get-Content file.txt\nRemove-Item build",
    "Get-Item file && Remove-Item file", "Get-Item file || Remove-Item other",
    "if (Test-Path build) { Remove-Item build }", "if ($false) { Write-Output no } else { Stop-Computer }",
    "foreach ($item in @('build')) { Remove-Item $item }", "while (Test-Path file) { Remove-Item file }",
    "try { Get-Content file } finally { Remove-Item file }", "& { Remove-Item file }", ". { Clear-Content file }",
    "Get-ChildItem | ForEach-Object { Remove-Item $_ }", "Get-ChildItem | % { Remove-Item $_ }",
    "Invoke-Command -ScriptBlock { Stop-Process -Id 123 }",
    "Measure-Command { Remove-Item file }", "Trace-Command -Name ParameterBinding -Expression { Remove-Item file }",
    "return & 'Remove-Item' file", "& { return & { Remove-Item file } }",
    "Write-Output $(Remove-Item file)", 'Write-Output "result: $(Remove-Item file)"',
    'Write-Output @"\nresult: $(Remove-Item file)\n"@',
    "Remove-Item -WhatIf -Path $(Remove-Item other)", "$result = Remove-Item file", "$result=Remove-Item file",
    "pwsh.exe -NoProfile -Command 'Remove-Item build'", 'powershell -NoProfile -c "Stop-Service fixture"',
    "pwsh -NoP -NonI -c 'Remove-Item build'", "& $action", "Invoke-Expression $script", "pwsh -File cleanup.ps1",
    ".\\cleanup.ps1", "& 'C:\\script files\\cleanup.ps1'", ". 'C:\\script files\\cleanup.ps1'",
    "& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -Command 'Clear-Content file'",
    "pwsh -Command { Remove-Item build }", "Invoke-Expression 'Remove-Item build'", "iex 'Stop-Computer'",
    "git.exe reset --hard", "& 'C:\\Program Files\\Git\\cmd\\git.exe' clean -fd",
    "docker.exe volume rm data", "bash.exe -lc 'rm file'",
  ])("finds executable commands within supported PowerShell syntax: %s", command => {
    expect(assess(command), command).toMatchObject({ dangerous: true });
  });

  it("inspects literal encoded PowerShell commands without executing them", () => {
    const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
    expect(assess(`powershell.exe -NoProfile -EncodedCommand ${encoded("Remove-Item build")}`).dangerous).toBe(true);
    expect(assess(`pwsh.exe -enc ${encoded("Get-ChildItem")}`).dangerous).toBe(false);
  });

  it("does not apply cmdlet preview flags to arbitrary executables", () => {
    expect(assess("taskkill.exe /PID 123 -WhatIf").dangerous).toBe(true);
    expect(assess("C:\\tools\\rm.exe file -WhatIf").dangerous).toBe(true);
    expect(assess("C:\\tools\\rm.exe --help").dangerous).toBe(false);
  });

  it("keeps Unix command behavior unchanged", () => {
    expect(detectDangerousCommand("Remove-Item file", "linux").dangerous).toBe(false);
    expect(detectDangerousCommand("rm --help", "linux").dangerous).toBe(false);
    expect(detectDangerousCommand("rm file", "linux").dangerous).toBe(true);
  });
});
