function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildFullCommand(command: string, workingDirectory?: string): string {
  if (!workingDirectory) {
    return command;
  }
  return `cd ${escapeShellArg(workingDirectory)} && ${command}`;
}
