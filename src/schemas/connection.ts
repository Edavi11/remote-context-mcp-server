import { z } from 'zod';

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const SSHConnectionConfigSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9._-]+$/, 'Connection name must only contain letters, numbers, dots, hyphens or underscores'),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).optional().default(22),
  username: z.string().min(1, 'Username is required'),
  password: z.string().optional(),
  passwordFile: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
  passphraseFile: z.string().optional(),
  allowedCommands: z.array(z.string().refine(isValidRegex, 'allowedCommands entries must be valid regular expressions')).optional(),
  remoteRoots: z.array(z.string().min(1)).optional(),
  localRoots: z.array(z.string().min(1)).optional(),
}).refine(
  (data) => data.password !== undefined || data.passwordFile !== undefined || data.privateKeyPath !== undefined,
  { message: 'Either password, passwordFile, or privateKeyPath must be provided' }
);

export const SSHConnectionsSchema = z
  .array(SSHConnectionConfigSchema)
  .min(1, 'At least one SSH connection is required')
  .superRefine((connections, ctx) => {
    const seen = new Set<string>();
    connections.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate connection name "${c.name}"` });
      }
      seen.add(c.name);
    });
  });
