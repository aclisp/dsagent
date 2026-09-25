/** Only known option arities are accepted. Unknown options leave the invocation
 * unclassified; guessing could turn an option value into a dry-run exemption. */
export interface OptionSpec {
  flags?: readonly string[];
  values?: readonly string[];
  /** Docker-style flags also accept --flag=true/false. */
  booleans?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
}

export interface ParsedOptions {
  flags: Set<string>;
  operands: string[];
}

export function parseOptions(
  args: string[],
  spec: OptionSpec,
  stopAtOperand = false,
): ParsedOptions | undefined {
  const flags = new Set<string>();
  const operands: string[] = [];
  const setFlag = (name: string, enabled: boolean) => {
    const canonical = spec.aliases?.[name] ?? name;
    if (enabled) flags.add(canonical);
    else flags.delete(canonical);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      if (stopAtOperand) {
        operands.push(...args.slice(i));
        break;
      }
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const value = equals < 0 ? undefined : arg.slice(equals + 1);
      if (spec.values?.includes(name)) {
        if (value === undefined && args[++i] === undefined) return;
      } else if (spec.booleans?.includes(name)) {
        if (value !== undefined && value !== "true" && value !== "false") return;
        setFlag(name, value !== "false");
      } else if (spec.flags?.includes(name) && value === undefined) {
        setFlag(name, true);
      } else return;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const name = `-${arg[j]}`;
      if (spec.values?.includes(name)) {
        if (j === arg.length - 1 && args[++i] === undefined) return;
        break; // The remainder of this word is the option's value, not flags.
      }
      if (spec.booleans?.includes(name) && arg[j + 1] === "=") {
        const value = arg.slice(j + 2);
        if (value !== "true" && value !== "false") return;
        setFlag(name, value === "true");
        break;
      }
      if (!spec.flags?.includes(name) && !spec.booleans?.includes(name)) return;
      setFlag(name, true);
    }
  }
  return { flags, operands };
}
