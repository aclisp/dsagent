import { makeDangerousMatch, type DangerousMatch } from "./match.ts";
import { powerShellCommands, powerShellName, type PowerShellCommand, type PowerShellWord } from "./powershell-shell.ts";

const aliases: Readonly<Record<string, string>> = {
  ri: "remove-item", del: "remove-item", erase: "remove-item", rd: "remove-item", rm: "remove-item", rmdir: "remove-item",
  clc: "clear-content", sc: "set-content", cli: "clear-item", rp: "remove-itemproperty", clp: "clear-itemproperty",
  spps: "stop-process", kill: "stop-process", spsv: "stop-service", saps: "start-process", start: "start-process",
};

const cmdletIntents: Readonly<Record<string, string>> = {
  "remove-item": "Delete the specified files or provider items",
  "clear-content": "Clear the contents of the specified files or items",
  "set-content": "Overwrite the contents of the specified files or items",
  "clear-item": "Clear the specified provider items",
  "remove-itemproperty": "Delete the specified provider properties",
  "clear-itemproperty": "Clear the specified provider property values",
  "out-file": "Overwrite the output file",
  "stop-process": "Terminate the selected processes",
  "stop-service": "Stop the selected services",
  "restart-service": "Restart the selected services",
  "suspend-service": "Suspend the selected services",
  "remove-service": "Delete the selected service",
  "stop-computer": "Shut down the selected computers",
  "restart-computer": "Restart the selected computers",
  "format-volume": "Format the selected volume",
  "clear-disk": "Remove partition and volume information from the selected disk",
  "initialize-disk": "Initialize the selected disk",
  "remove-partition": "Delete the selected partition",
  "resize-partition": "Resize the selected partition",
};

const nativeIntents: Readonly<Record<string, string>> = {
  taskkill: "Terminate the selected processes",
  shutdown: "Shut down or restart the system",
  format: "Format the selected volume",
  diskpart: "Change disks, partitions, or volumes",
};

/** Only a full, unquoted, explicitly enabled switch is a safe exemption.
 * Quoted '-WhatIf' is data; :$false and runtime values must not grant approval. */
function enabledSwitch(args: PowerShellWord[], name: string, aliases: string[] = []): boolean {
  if (args.some(arg => arg.raw.startsWith("@") || arg.raw.startsWith("--%"))) return false;
  const names = [name, ...aliases].join("|");
  const switches = parameterWords(args).filter(arg => new RegExp(`^-(?:${names})(?::|$)`, "i").test(arg.raw));
  return switches.length === 1 && new RegExp(`^-(?:${names})(?::\\$true)?$`, "i").test(switches[0]!.raw);
}

function parameterWords(args: PowerShellWord[]): PowerShellWord[] {
  const end = args.findIndex(arg => arg.raw === "--");
  return end < 0 ? args : args.slice(0, end);
}

export function isPowerShellCmdlet(word: PowerShellWord): boolean {
  return !/[/!:]|^(?:\.|\\)|\.(?:exe|com|cmd|bat|ps1)$/i.test(word.value);
}

const itemPathParameters = new Set(["path", "literalpath", "pspath", "lp"]);
const itemValueParameters = new Set([
  "filter", "include", "exclude", "credential", "erroraction", "ea", "warningaction", "wa",
  "informationaction", "infa", "progressaction", "proga", "errorvariable", "ev", "warningvariable", "wv",
  "informationvariable", "iv", "outvariable", "ov", "outbuffer", "ob", "pipelinevariable", "pv",
]);
const itemSwitchParameters = new Set(["force", "recurse", "confirm", "cf", "whatif", "wi", "verbose", "vb", "debug", "db"]);

/** Only explicit session-provider paths are exempt. A name may expand after the
 * fixed provider prefix ("Env:$name"); an unknown path or splat may also target
 * files or the registry. Do not infer paths from pipeline input or shell state. */
function sessionItemTargets(command: PowerShellCommand, args: PowerShellWord[]): boolean {
  if (!command.complete) return false;
  let targets = 0, parameters = true, index = 0;
  const sessionPath = (raw: string): boolean => {
    // A trailing comma continues into the next argument. Never exempt a prefix
    // when its next item is missing (including continuation onto another line).
    while (raw.endsWith(",")) {
      const next = args[++index];
      if (!next) return false;
      raw += ` ${next.raw}`;
    }
    const parsed = powerShellCommands(`__target ${raw}`, true).at(-1);
    return !!parsed?.complete && parsed.words[0]?.value === "__target" && !parsed.redirects.length &&
      parsed.words.length > 1 && parsed.words.slice(1).every(target =>
        /^(?:(?:env|variable|alias|function):|(?:Microsoft\.PowerShell\.Core\\)?(?:Environment|Variable|Alias|Function)::)/i.test(target.value));
  };
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (parameters && arg.raw === "--") { parameters = false; continue; }
    const parameter = parameters && /^-([a-z]+)(?::([\s\S]*))?$/i.exec(arg.raw);
    if (parameter) {
      const name = parameter[1]!.toLowerCase();
      if (itemSwitchParameters.has(name)) continue;
      if (!itemPathParameters.has(name) && !itemValueParameters.has(name)) return false;
      const value = parameter[2] ?? args[++index]?.raw;
      if (value === undefined) return false;
      if (itemValueParameters.has(name)) continue;
      if (!sessionPath(value)) return false;
    } else if (!sessionPath(arg.raw)) return false;
    targets++;
  }
  return targets > 0;
}

export function powerShellRule(command: PowerShellCommand): { handled: boolean; match?: DangerousMatch } {
  if (command.redirects.some(({ append, target }) => !append && !/^\$null$/i.test(target.raw) && !/^nul:?$/i.test(target.value))) {
    return { handled: true, match: makeDangerousMatch("PowerShell redirection can overwrite an output file", "Overwrite the redirected output file", false) };
  }
  const [word, ...args] = command.words;
  if (!word) return { handled: true };
  if (!word.literal) {
    return command.invoked && !word.raw.startsWith("{")
      ? { handled: true, match: makeDangerousMatch("PowerShell invokes a command selected at runtime", "Run a PowerShell command selected at runtime", false) }
      : { handled: true };
  }
  // In expression position a quoted string is data, unless & or . invokes it.
  if (!command.invoked && /^[‘’'“”"]/.test(word.raw)) return { handled: true };
  if (/\.(?:ps1|psm1)$/i.test(word.value)) {
    return { handled: true, match: makeDangerousMatch("PowerShell runs a script file whose contents are not inspected", "Run a PowerShell script file", false) };
  }
  const base = powerShellName(word.value);
  const cmdlet = isPowerShellCmdlet(word);
  const name = cmdlet && Object.hasOwn(aliases, base) ? aliases[base]! : base;
  const intent = cmdlet && Object.hasOwn(cmdletIntents, name) ? cmdletIntents[name] : undefined;
  if (intent) {
    const help = parameterWords(args).some(arg => arg.raw === "-?");
    const preview = command.complete && (help || enabledSwitch(args, "whatif", ["wi"]));
    const output = name === "out-file" && command.complete &&
      (enabledSwitch(args, "append") || enabledSwitch(args, "noclobber", ["nooverwrite"]));
    const session = ["remove-item", "clear-item"].includes(name) && sessionItemTargets(command, args);
    return preview || output || session ? { handled: true } : {
      handled: true, match: makeDangerousMatch(`${name} can delete data or alter files/system state`, intent, false),
    };
  }
  const parameters = parameterWords(args);
  if (cmdlet && name === "start-process" && parameters.some((arg, index) =>
    /^-verb:runas$/i.test(arg.raw) || (/^-verb$/i.test(arg.raw) && /^runas$/i.test(parameters[index + 1]?.value ?? "")))) {
    return command.complete && enabledSwitch(args, "whatif", ["wi"]) ? { handled: true } : {
      handled: true, match: makeDangerousMatch("Start-Process -Verb RunAs requests elevated privileges", "Run a process with elevated privileges", true, true),
    };
  }
  if (Object.hasOwn(nativeIntents, name)) {
    return command.complete && args.length === 1 && args[0]!.value === "/?" ? { handled: true } : {
      handled: true, match: makeDangerousMatch(`${name} can delete data or alter system state`, nativeIntents[name]!, false),
    };
  }
  if (!cmdlet && name === "sc" && /^(?:stop|delete|config|failure|failureflag|privs|sdset)$/i.test(args[0]?.value ?? "")) {
    return { handled: true, match: makeDangerousMatch("sc.exe can disrupt services or change their configuration", "Change or stop the selected service", false) };
  }
  return { handled: false };
}

export function powerShellPayload(name: string, args: PowerShellWord[]): { handled: boolean; script?: string; match?: DangerousMatch } {
  if (["invoke-expression", "iex"].includes(name)) {
    const payload = args[0]?.raw.toLowerCase() === "-command" ? args[1] : args[0];
    return payload?.literal ? { handled: true, script: payload.value } : {
      handled: true, match: makeDangerousMatch("Invoke-Expression evaluates code assembled at runtime", "Evaluate PowerShell code assembled at runtime", false),
    };
  }
  if (!["pwsh", "powershell"].includes(name)) return { handled: false };
  const unknown = () => ({ handled: true, match: makeDangerousMatch("PowerShell executes script text or a file that cannot be inspected literally", "Run PowerShell code that is not available as literal text", false) });
  if (args.length === 1 && /^(?:--?help|-\?|\/\?|--version)$/i.test(args[0]!.value)) return { handled: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.literal) return unknown();
    const option = arg.value.toLowerCase();
    if (["-noprofile", "-nologo", "-noninteractive", "-sta", "-mta", "-nol", "-nop", "-noni", "-noexit"].includes(option)) continue;
    if (["-executionpolicy", "-ep", "-windowstyle", "-w", "-inputformat", "-outputformat", "-workingdirectory", "-version"].includes(option)) { index++; continue; }
    if (["-command", "-c"].includes(option)) {
      const payload = args.slice(index + 1);
      if (payload[0]?.raw.startsWith("{")) return { handled: true }; // Already visited as an executing block.
      if (payload.every(word => word.literal)) return { handled: true, script: payload.map(word => word.value).join(" ") };
      return unknown();
    }
    if (["-encodedcommand", "-enc", "-ec"].includes(option)) {
      const payload = args[index + 1];
      if (!payload?.literal) return unknown();
      if (!/^[a-z\d+/]*={0,2}$/i.test(payload.value)) return { handled: true };
      return { handled: true, script: Buffer.from(payload.value, "base64").toString("utf16le") };
    }
    return unknown(); // Files, unknown host options, and dynamic code require approval.
  }
  return { handled: true };
}
