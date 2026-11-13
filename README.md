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
- **SFTP file transfer** — upload/download files and whole directories, and list remote directories, over the same pooled SSH connections — with per-connection path roots and protected-file rules
- **Config file** — all connections live in one JSON file instead of a giant env-var string

## Installation

```bash
npx remote-context-mcp-server
```

Or install globally:
```bash
npm install -g remote-context-mcp-server
```

## Configuration

Define all your servers in **one JSON config file**. You only need one MCP server entry no matter how many servers you have.

**Step 1 — Create the config file.** By default the server reads `~/.remote-context-mcp/connections.json`, so if you put it there you don't need any environment variable. See [`remote-context.config.example.json`](remote-context.config.example.json):

```json
[
  {
    "name": "production",
    "host": "192.168.1.100",
    "username": "ubuntu",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "allowedCommands": ["docker ps", "docker logs( --tail \\d+)? [\\w.-]+", "systemctl status [\\w.-]+", "df -h"],
    "remoteRoots": ["/opt/releases", "/var/log"]
  },
  {
    "name": "staging",
    "host": "staging.example.com",
    "username": "deploy",
    "passwordFile": "~/.secrets/staging-password"
  }
]
```

**Step 2 — Configure your MCP client:**

```json
{
  "mcpServers": {
    "remote-context": {
      "command": "npx",
      "args": ["-y", "remote-context-mcp-server"]
    }
  }
}
```

To keep the file elsewhere, point to it with `REMOTE_CONTEXT_CONFIG`:

```json
"env": { "REMOTE_CONTEXT_CONFIG": "/absolute/path/to/connections.json" }
```

Where connections are loaded from (first match wins):

| # | Source | Notes |
|---|---|---|
| 1 | `REMOTE_CONTEXT_CONFIG` | Path to a JSON config file |
| 2 | `~/.remote-context-mcp/connections.json` | Default config file |
| 3 | `SSH_CONNECTIONS` | Legacy: the same JSON array inline in an env var. Still works, logs a deprecation warning |

If the config is missing or invalid, `ssh_list_connections` returns the exact error (file and field), so the LLM can tell you what's wrong.

### Connection fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique identifier (letters, numbers, `.`, `-`, `_`) used to reference this connection in tools |
| `host` | Yes | IP address or hostname |
| `port` | No | SSH port (default: `22`) |
| `username` | Yes | SSH username |
| `password` | No* | Password for authentication (inline) |
| `passwordFile` | No* | Path to a file containing the password — **preferred** over `password` so secrets don't sit in the config |
| `privateKeyPath` | No* | Path to private key file (`~` is expanded) |
| `passphrase` | No | Passphrase for the private key (inline) |
| `passphraseFile` | No | Path to a file containing the key passphrase — preferred over `passphrase` |
| `allowedCommands` | No | Array of regex patterns. When set, a command is allowed only if it **matches one pattern entirely** and contains no shell operators (`; & \| \` $ < >` or newlines). Turns the connection into an explicit allowlist for sensitive servers |
| `remoteRoots` | No | Remote directories SFTP may touch on this connection. Required for SFTP on connections with `allowedCommands` |
| `localRoots` | No | Local directories SFTP may read from / write to for this connection |

*Either `password`, `passwordFile`, or `privateKeyPath` must be provided. `~` is expanded in every path field.

When using `passwordFile`/`passphraseFile`, keep the referenced file readable only by the user running the MCP server (`chmod 600`).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `REMOTE_CONTEXT_CONFIG` | `~/.remote-context-mcp/connections.json` | Path to the connections config file |
| `SSH_CONNECTIONS` | — | Legacy inline JSON array of connections (deprecated) |
| `SFTP_MAX_FILES` | `5000` | Max files in a single recursive transfer |
| `KNOWN_HOSTS_PATH` | `~/.remote-context-mcp/known_hosts.json` | Where trusted host key fingerprints (TOFU) are stored |
| `SSH_POOL_IDLE_MS` | `300000` (5 min) | How long an idle pooled SSH connection stays open before being closed |
| `MAX_OUTPUT_BYTES` | `1000000` (1 MB) | Max stdout/stderr size tracked per process before truncation |
| `MAX_PROCESS_RECORDS` | `500` | Max process records kept in memory; oldest non-running records are evicted beyond this |
| `AUDIT_LOG_PATH` | `~/.remote-context-mcp/audit.jsonl` | Where the persistent audit log is written |
| `AUDIT_LOG_DISABLED` | `false` | Set to `"true"` to disable the persistent audit log |

## Available Tools

### `ssh_list_connections`
Lists all configured connections, where they were loaded from, and each connection's restrictions (`restricted`, `remote_roots`, `local_roots`). Safe to call anytime — never exposes credentials.

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
Uploads a local file or directory over SFTP, reusing the pooled SSH connection. `remote_path` is the full destination path; missing parent directories are created.

```
connection_name: "production"
local_path:       "./build/app.tar.gz"
remote_path:      "/opt/releases/app.tar.gz"
recursive:        false   (optional — required to upload a directory)
overwrite:        false   (optional — refuses if the destination exists)
```

### `ssh_download_file`
Downloads a remote file or directory over SFTP. `local_path` is the full destination path; missing parent directories are created.

```
connection_name: "production"
remote_path:      "/var/log/app.log"
local_path:       "./app.log"
recursive:        false   (optional — required to download a directory)
overwrite:        false   (optional — refuses if the destination exists)
```

### `ssh_list_remote_dir`
Lists a remote directory: name, type, size, permissions and modification time of each entry.

```
connection_name: "production"
remote_path:      "/var/log"   (optional, default: login directory)
```

## SFTP Safety

- **Paths are resolved before checking.** `../` is collapsed and symlinks are followed (both remote and local), so neither can be used to escape `remoteRoots`/`localRoots`.
- **Protected remote files are never written**, even on unrestricted connections: `/etc/passwd`, `/etc/shadow`, `/etc/gshadow`, `/etc/group`, `/etc/sudoers*` and any `.ssh/authorized_keys`.
- **Protected local paths are never read or written:** `~/.ssh`, `~/.remote-context-mcp` (config, known hosts, audit log), the config file and every key/secret file it references.
- **No silent overwrites:** `overwrite` defaults to `false`.
- **Symlinks inside transferred directories are skipped** and listed in the result.
- **Restricted connections** (with `allowedCommands`) need `remoteRoots` to use SFTP at all.
- Every transfer is recorded in the audit log (`upload`/`download` events with files, bytes and duration).

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
| `failed` | Command finished with a non-zero exit code, was terminated by a signal (reported in `signal`), or the connection dropped before it reported an exit status |
| `timeout` | Command exceeded the configured timeout (a `KILL` signal is sent to the remote process) |
| `blocked` | Command was rejected by the safety filter/allowlist |
| `killed` | Command was cancelled via `ssh_kill_process` |

## Upgrading from 1.x

- **Move connections to a config file** — copy the JSON array from `SSH_CONNECTIONS` into `~/.remote-context-mcp/connections.json` and remove the env var. `SSH_CONNECTIONS` still works for now.
- **`allowedCommands` now matches the whole command** (previously only a prefix) and rejects shell operators. A pattern like `"systemctl status"` must become `"systemctl status [\\w.-]+"`.
- **SFTP `overwrite` defaults to `false`** — pass `overwrite: true` to replace existing files.
- **Node.js 20+** is required.

## License

MIT
