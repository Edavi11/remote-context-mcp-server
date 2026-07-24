import { describe, it, expect } from 'vitest';
import { buildFullCommand } from '../services/shell-utils.js';

describe('buildFullCommand', () => {
  it('returns the command unchanged when no working_directory is given', () => {
    expect(buildFullCommand('ls -la')).toBe('ls -la');
  });

  it('prefixes with a quoted cd for a plain directory', () => {
    expect(buildFullCommand('ls -la', '/var/www')).toBe(`cd '/var/www' && ls -la`);
  });

  it('quotes directories containing spaces as a single argument', () => {
    expect(buildFullCommand('ls', '/my folder')).toBe(`cd '/my folder' && ls`);
  });

  it('neutralizes shell operators smuggled through working_directory', () => {
    const result = buildFullCommand('ls', '/tmp && rm -rf / #');
    // The injected `&& rm -rf / #` stays inside the single-quoted cd argument
    // (a shell treats everything between quotes as one literal string), so
    // the only real command separator is the trailing `&& ls`.
    expect(result).toBe(`cd '/tmp && rm -rf / #' && ls`);
    expect(result.endsWith(`&& ls`)).toBe(true);
  });

  it('escapes embedded single quotes so they cannot break out of the argument', () => {
    const result = buildFullCommand('ls', `/tmp'; rm -rf / #`);
    expect(result).toBe(`cd '/tmp'\\''; rm -rf / #' && ls`);
  });
});
