export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals > 2) {
        flags[arg.slice(2, equals)] = arg.slice(equals + 1);
        continue;
      }
      const next = args[index + 1];
      if (next && isFlagValue(next)) {
        flags[arg.slice(2)] = next;
        index++;
      } else {
        flags[arg.slice(2)] = "true";
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const next = args[index + 1];
      if (next && isFlagValue(next)) {
        flags[arg.slice(1)] = next;
        index++;
      } else {
        flags[arg.slice(1)] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function isFlagValue(value: string): boolean {
  return !value.startsWith("-") || /^-\d/.test(value);
}
