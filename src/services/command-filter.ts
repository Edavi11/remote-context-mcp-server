type Severity = 'critical' | 'high';

interface BlockedPattern {
  pattern: RegExp;
  severity: Severity;
  reason: string;
}

export interface FilterResult {
  allowed: boolean;
  reason?: string;
  severity?: Severity;
}

// This is a regex blocklist — defense in depth against obviously destructive
// commands, not a security guarantee. It cannot catch every equivalent
// (variable indirection, novel destructive tools, etc.). Connections handling
// sensitive/production servers should also set `allowedCommands` on the
// connection config to switch to an explicit allowlist.
const BLOCKED_PATTERNS: BlockedPattern[] = [
  // Filesystem destruction — only block when targeting root (/) or system dirs directly
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)\s+\/$/, severity: 'critical', reason: 'Recursive deletion from root filesystem' },
  { pattern: /rm\s+-rf\s+\/(\s|$)/, severity: 'critical', reason: 'Recursive deletion from root filesystem' },
  { pattern: /rm\s+-fr\s+\/(\s|$)/, severity: 'critical', reason: 'Recursive deletion from root filesystem' },
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)\s+\/\*/, severity: 'critical', reason: 'Recursive deletion of everything under root filesystem' },
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)\s+\/(home|etc|var|boot|usr|bin|lib32|lib64|lib|root|opt)\/?(\s|$)/, severity: 'critical', reason: 'Recursive deletion of a critical system directory' },
  { pattern: /find\s+\/\s+.*-delete/, severity: 'critical', reason: 'Recursive deletion from root via find -delete' },
  { pattern: /rmtree\(\s*['"]\/['"]/, severity: 'critical', reason: 'Recursive deletion of root filesystem via Python shutil.rmtree' },
  { pattern: /mkfs/, severity: 'critical', reason: 'Disk formatting command detected' },
  { pattern: /dd\s+.*of=\/dev\/[a-zA-Z]/, severity: 'critical', reason: 'Direct write to block device' },
  { pattern: /shred\s+.*\/dev\//, severity: 'critical', reason: 'Device destruction command detected' },
  { pattern: /wipefs/, severity: 'critical', reason: 'Filesystem signature wipe detected' },

  // Fork bombs / DoS
  { pattern: /:\(\)\s*\{.*:\s*\|.*:.*\}/, severity: 'critical', reason: 'Fork bomb pattern detected' },
  { pattern: /\(\)\s*\{\s*\|/, severity: 'critical', reason: 'Possible fork bomb detected' },

  // Remote code execution
  { pattern: /curl\s+.*\|\s*(ba)?sh/, severity: 'high', reason: 'Remote script execution via curl' },
  { pattern: /wget\s+.*\|\s*(ba)?sh/, severity: 'high', reason: 'Remote script execution via wget' },
  { pattern: /curl\s+.*\|\s*python/, severity: 'high', reason: 'Remote code execution via curl+python' },
  { pattern: /base64\s+(-d|--decode).*\|\s*(ba)?sh/, severity: 'high', reason: 'Obfuscated code execution detected' },
  { pattern: /base64\s+(-d|--decode).*\|\s*(python|perl|ruby|node)/, severity: 'high', reason: 'Obfuscated code execution detected' },

  // Privilege escalation / backdoors
  { pattern: /passwd\s+root/, severity: 'high', reason: 'Attempt to change root password' },
  { pattern: /echo\s+.*>>\s*.*\/.ssh\/authorized_keys/, severity: 'high', reason: 'SSH key injection attempt' },
  { pattern: /tee\s+.*\/.ssh\/authorized_keys/, severity: 'high', reason: 'SSH key injection via tee' },
  { pattern: /crontab\s+.*-[a-z]*.*&&.*curl/, severity: 'high', reason: 'Possible backdoor via cron+curl' },
  { pattern: /crontab\s+.*-[a-z]*.*&&.*wget/, severity: 'high', reason: 'Possible backdoor via cron+wget' },
  { pattern: /chmod\s+[0-9]*7[0-9][0-9]\s+\//, severity: 'high', reason: 'Dangerous global permissions change' },

  // System disruption
  { pattern: />\s*\/etc\/passwd/, severity: 'critical', reason: 'Attempt to overwrite /etc/passwd' },
  { pattern: />\s*\/etc\/shadow/, severity: 'critical', reason: 'Attempt to overwrite /etc/shadow' },
  { pattern: />\s*\/etc\/hosts/, severity: 'high', reason: 'Attempt to overwrite /etc/hosts' },
  { pattern: /shutdown\s+(-h|-r|-P)/, severity: 'high', reason: 'Server shutdown/reboot command detected' },
  { pattern: /reboot(\s|$)/, severity: 'high', reason: 'Server reboot command detected' },
  { pattern: /halt(\s|$)/, severity: 'high', reason: 'Server halt command detected' },
  { pattern: /init\s+[06]/, severity: 'high', reason: 'System runlevel change to shutdown/reboot' },
];

export function filterCommand(command: string): FilterResult {
  const normalizedCommand = command.trim();

  for (const { pattern, severity, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalizedCommand)) {
      return { allowed: false, reason, severity };
    }
  }

  return { allowed: true };
}

// Chaining, substitution, redirection or a second line would let an allowed
// prefix smuggle in an arbitrary command, so they're rejected outright.
const SHELL_METACHARS = /[;&|`$<>\n\r]/;

/**
 * When a connection defines `allowedCommands`, the whole command must match one
 * of those regex patterns (anchored at both ends) and contain no shell
 * operators — inverting the default blocklist into an explicit allowlist for
 * sensitive connections. Connections without `allowedCommands` are unaffected.
 */
export function checkAllowlist(command: string, allowedCommands?: string[]): FilterResult {
  if (!allowedCommands || allowedCommands.length === 0) {
    return { allowed: true };
  }

  const normalizedCommand = command.trim();
  if (SHELL_METACHARS.test(normalizedCommand)) {
    return {
      allowed: false,
      severity: 'high',
      reason: 'Shell operators (; & | ` $ < > or newlines) are not allowed on connections with an allowedCommands allowlist',
    };
  }

  const matches = allowedCommands.some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(normalizedCommand);
    } catch {
      return false;
    }
  });

  if (!matches) {
    return {
      allowed: false,
      severity: 'high',
      reason: 'Command does not match this connection\'s allowedCommands allowlist',
    };
  }

  return { allowed: true };
}
