# remote-context-mcp-server

MCP server for SSH remote server management. Connect to multiple remote servers via SSH, execute commands, transfer files, and track long-running processes — all from your LLM.

## Features

- **Multiple SSH connections** — configure as many servers as you need, reused via a connection pool
- **Two auth methods** — username/password or SSH private key (by file path), with optional file-based secrets (`passwordFile`/`passphraseFile`)
- **Host key verification (TOFU)** — the fingerprint of each server is pinned on first connection and verified on every reconnect, to catch man-in-the-middle attempts
- **Command safety** — dangerous commands are blocked automatically before execution (blocklist), with an optional per-connection allowlist for sensitive servers
- **Long-running process tracking** — run commands asynchronously, poll for status, and cancel them mid-run
- **Per-process history** — every command execution is recorded with stdout, stderr, exit code, and timing (bounded, to avoid unbounded memory growth)
- **Persistent audit log** — every execution is optionally appended to a local JSONL file for traceability across restarts
- **SFTP file transfer** — upload/download files over the same SSH connections

## Installation

```bash
npx remote-context-mcp-server
```

Or install globally:
```bash
npm install -g remote-context-mcp-server
```

## Configuration

Set the `SSH_CONNECTIONS` environment variable with a JSON array of connection objects:

```json
[
  {
    "name": "production",
    "host": "192.168.1.100",
    "port": 22,
    "username": "ubuntu",
    "passwordFile": "/home/user/.secrets/prod-password"
  },
  {
    "name": "staging",
    "host": "staging.example.com",
    "port": 22,
    "username": "deploy",
    "privateKeyPath": "/home/user/.ssh/id_rsa"
  },
  {
    "name": "dev-box",
    "host": "10.0.0.5",
    "port": 2222,
    "username": "admin",
    "privateKeyPath": "/home/user/.ssh/dev_key",
    "passphrase": "keypassphrase",
    "allowedCommands": ["git ", "npm ", "ls", "cat ", "df", "systemctl status"]
  }
]
```

### Connection fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique identifier used to reference this connection in tools |
| `host` | Yes | IP address or hostname |
| `port` | No | SSH port (default: `22`) |
| `username` | Yes | SSH username |
| `password` | No* | Password for authentication (inline) |
| `passwordFile` | No* | Path to a file containing the password — **preferred** over `password` so secrets don't sit directly in `SSH_CONNECTIONS`/env |
| `privateKeyPath` | No* | Absolute path to private key file (e.g. `~/.ssh/id_rsa`) |
| `passphrase` | No | Passphrase for the private key (inline) |
| `passphraseFile` | No | Path to a file containing the key passphrase — preferred over `passphrase` |
| `allowedCommands` | No | Array of regex patterns (anchored to the start of the command). When set, only matching commands are allowed on this connection — inverts the default blocklist into an explicit allowlist for sensitive/production servers |

*Either `password`, `passwordFile`, or `privateKeyPath` must be provided.

When using `passwordFile`/`passphraseFile`, keep the referenced file readable only by the user running the MCP server (`chmod 600`).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SSH_CONNECTIONS` | — | JSON array of connection configs (required) |
| `KNOWN_HOSTS_PATH` | `~/.remote-context-mcp/known_hosts.json` | Where trusted host key fingerprints (TOFU) are stored |
| `SSH_POOL_IDLE_MS` | `300000` (5 min) | How long an idle pooled SSH connection stays open before being closed |
| `MAX_OUTPUT_BYTES` | `1000000` (1 MB) | Max stdout/stderr size tracked per process before truncation |
| `MAX_PROCESS_RECORDS` | `500` | Max process records kept in memory; oldest non-running records are evicted beyond this |
| `AUDIT_LOG_PATH` | `~/.remote-context-mcp/audit.jsonl` | Where the persistent audit log is written |
| `AUDIT_LOG_DISABLED` | `false` | Set to `"true"` to disable the persistent audit log |

## Claude Desktop / Cursor setup

Add to your MCP config file:

```json
{
  "mcpServers": {
    "remote-context": {
      "command": "npx",
      "args": ["-y", "remote-context-mcp-server"],
      "env": {
        "SSH_CONNECTIONS": "[{\"name\":\"my-server\",\"host\":\"192.168.1.100\",\"username\":\"ubuntu\",\"passwordFile\":\"/home/user/.secrets/my-server-password\"}]"
      }
    }
  }
}
```

## Available Tools

### `ssh_list_connections`
Lists all configured connections. Safe to call anytime — never exposes credentials.

### `ssh_ping`
Tests SSH connectivity to a named server and returns latency + server info.

```
connection_name: "production"
```

### `ssh_exec`
Executes a command on a remote server. Whether the user is prompted to confirm before running depends on the MCP client's settings — the server does not enforce confirmation itself, but it does always enforce the command filter/allowlist regardless of client settings.

```
connection_name:   "production"
command:           "df -h"
working_directory: "/var/www"   (optional)
timeout_seconds:   30           (optional, default 30)
async:             false        (optional, default false)
dry_run:           false        (optional, default false)
```

Set `async: true` for long-running commands — the tool returns a `process_id` immediately and the command runs in the background. Set `dry_run: true` to see the resolved command and filter verdict without connecting or executing anything.

### `ssh_get_process`
Retrieves the full status and output (stdout + stderr) of a tracked process.

```
process_id: "proc_abc123_xyz"
```

### `ssh_list_processes`
Lists all process records in the current session (metadata only, no output).

```
connection_name: "production"   (optional filter)
status:          "running"      (optional filter: running|completed|failed|timeout|blocked|killed)
```

### `ssh_kill_process`
Cancels a running command started with `ssh_exec` (typically an `async: true` one).

```
process_id: "proc_abc123_xyz"
```

### `ssh_upload_file`
Uploads a local file to a remote server over SFTP.

```
connection_name: "production"
local_path:       "./build/app.tar.gz"
remote_path:      "/opt/releases/app.tar.gz"
```

### `ssh_download_file`
Downloads a file from a remote server over SFTP.

```
connection_name: "production"
remote_path:      "/var/log/app.log"
local_path:       "./app.log"
```

## Command Safety

The following types of commands are automatically blocked:

- Recursive filesystem deletion from root or critical directories (`rm -rf /`, `rm -rf /*`, `rm -rf /home`, `rm -rf /etc`, …)
- Destructive equivalents (`find / -delete`, Python's `shutil.rmtree('/')`)
- Disk formatting (`mkfs`, `wipefs`)
- Direct device writes (`dd if=... of=/dev/...`)
- Fork bombs
- Remote script execution (`curl | bash`, `wget | sh`)
- Obfuscated code execution (`base64 -d | bash`)
- Root password changes
- SSH key injection into `authorized_keys`
- Server shutdown/reboot commands

This blocklist is **defense in depth, not a guarantee** — it is regex-based and cannot catch every equivalent command. For sensitive or production connections, set `allowedCommands` on the connection config to switch that connection to an explicit allowlist instead.

The command filter always validates the fully resolved command (including any `cd` prefix from `working_directory`), so it cannot be bypassed by smuggling shell operators through `working_directory`.

Blocked commands are recorded with status `blocked` and a reason explaining why they were rejected.

## Process Statuses

| Status | Meaning |
|---|---|
| `running` | Command is currently executing |
| `completed` | Command finished with exit code 0 |
| `failed` | Command finished with non-zero exit code |
| `timeout` | Command exceeded the configured timeout |
| `blocked` | Command was rejected by the safety filter/allowlist |
| `killed` | Command was cancelled via `ssh_kill_process` |

## License

MIT
