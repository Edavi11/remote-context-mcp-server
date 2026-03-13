# remote-context-mcp-server

MCP server for SSH remote server management. Connect to multiple remote servers via SSH, execute commands, and track long-running processes — all from your LLM.

## Features

- **Multiple SSH connections** — configure as many servers as you need
- **Two auth methods** — username/password or SSH private key (by file path)
- **Command safety** — dangerous commands are blocked automatically before execution
- **Long-running process tracking** — run commands asynchronously and poll for status
- **Per-process history** — every command execution is recorded with stdout, stderr, exit code, and timing

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
    "password": "yourpassword"
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
    "passphrase": "keypassphrase"
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
| `password` | No* | Password for authentication |
| `privateKeyPath` | No* | Absolute path to private key file (e.g. `~/.ssh/id_rsa`) |
| `passphrase` | No | Passphrase for the private key (if encrypted) |

*Either `password` or `privateKeyPath` must be provided.

## Claude Desktop / Cursor setup

Add to your MCP config file:

```json
{
  "mcpServers": {
    "remote-context": {
      "command": "npx",
      "args": ["-y", "remote-context-mcp-server"],
      "env": {
        "SSH_CONNECTIONS": "[{\"name\":\"my-server\",\"host\":\"192.168.1.100\",\"username\":\"ubuntu\",\"password\":\"secret\"}]"
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
Executes a command on a remote server. **Always asks for user confirmation before running.**

```
connection_name: "production"
command:         "df -h"
working_directory: "/var/www"   (optional)
timeout_seconds: 30             (optional, default 30)
async:           false          (optional, default false)
```

For long-running commands, set `async: true` — the tool returns a `process_id` immediately and the command runs in the background.

### `ssh_get_process`
Retrieves the full status and output (stdout + stderr) of a tracked process.

```
process_id: "proc_abc123_xyz"
```

### `ssh_list_processes`
Lists all process records in the current session (metadata only, no output).

```
connection_name: "production"   (optional filter)
status:          "running"      (optional filter: running|completed|failed|timeout|blocked)
```

## Command Safety

The following types of commands are automatically blocked:

- Recursive filesystem deletion from root (`rm -rf /`)
- Disk formatting (`mkfs`, `wipefs`)
- Direct device writes (`dd if=... of=/dev/...`)
- Fork bombs
- Remote script execution (`curl | bash`, `wget | sh`)
- Obfuscated code execution (`base64 -d | bash`)
- Root password changes
- SSH key injection into `authorized_keys`
- Server shutdown/reboot commands

Blocked commands are recorded with status `blocked` and a reason explaining why they were rejected.

## Process Statuses

| Status | Meaning |
|---|---|
| `running` | Command is currently executing |
| `completed` | Command finished with exit code 0 |
| `failed` | Command finished with non-zero exit code |
| `timeout` | Command exceeded the configured timeout |
| `blocked` | Command was rejected by the safety filter |

## License

MIT
