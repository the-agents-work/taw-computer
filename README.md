# taw-computer

> Give any AI a real computer.

Open source MCP server that spins up isolated Ubuntu sandboxes with shell, browser, and desktop — controlled by any AI client (Claude Code, Cursor, Claude Desktop, ChatGPT).

**No internal LLM. No chat UI. Your AI is the brain, this is the body.**

## What it does

Each sandbox is a Docker container with:
- Ubuntu 22.04 + xfce4 desktop
- Chromium browser with CDP (Chrome DevTools Protocol)
- Shell access (bash, git, npm, pip, python, etc.)
- VNC for live viewing via noVNC
- File operations (read, write, edit, search)
- Desktop automation (click, type, screenshot)
- Browser automation via Playwright (Set-of-Mark prompting)

## Quick start

### 1. Build the sandbox image

```bash
docker build -f images/Dockerfile.taw -t taw-computer-base .
```

### 2. Run the MCP server

```bash
npm install
npm start
```

### 3. Connect from your AI client

**Claude Code** — add to your MCP config:

```json
{
  "mcpServers": {
    "taw-computer": {
      "command": "npx",
      "args": ["tsx", "/path/to/taw-computer/mcp/index.ts"]
    }
  }
}
```

**Cursor / Claude Desktop** — same format in your MCP settings.

## Tools (30+)

| Category | Tools |
|----------|-------|
| **VM** | `vm_create`, `vm_list`, `vm_destroy`, `vm_reset`, `vm_restart`, `vm_status`, `vm_rename` |
| **Snapshots** | `snapshot_list`, `snapshot_delete` |
| **Shell** | `exec` |
| **Files** | `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_search`, `code_search`, `file_upload` |
| **Desktop** | `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_drag` |
| **Browser (CDP)** | `browser_navigate`, `browser_snapshot`, `browser_click_ref`, `browser_type_ref`, `browser_extract`, `browser_eval`, `browser_wait_for`, `browser_console_logs`, `browser_network_errors`, `browser_run_test` |
| **Browser (xdotool)** | `browser_open`, `browser_close` |
| **Search** | `web_search` |

## How it works

```
Your AI Client (Claude Code, Cursor, etc.)
    ↕ MCP protocol (stdio)
taw-computer MCP server
    ↕ Docker API
Ubuntu 22.04 sandbox (isolated container)
    ├── Shell (bash)
    ├── Chromium + CDP
    ├── xfce4 Desktop + VNC
    └── /workspace (your files)
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_SANDBOXES` | `3` | Max concurrent sandboxes |
| `SANDBOX_TYPE` | `auto` | `auto`, `docker`, or `firecracker` |
| `DOCKER_IMAGE` | `taw-computer-base` | Docker image for sandboxes |
| `DOCKER_MEMORY_MB` | `4096` | Memory limit per container |
| `DOCKER_CPUS` | `2` | CPU limit per container |
| `DESKTOP_ENABLED` | `true` | Enable VNC desktop |
| `DESKTOP_RESOLUTION` | `1280x720` | Desktop resolution |

## VNC access

Each sandbox exposes a noVNC web viewer. When `vm_create` returns, you'll get a `vnc_url` — open it in your browser to watch the AI work in real time.

If you use Docker Desktop, you can also click on the container to see its desktop.

## Requirements

- Docker
- Node.js 20+
- ~4GB RAM per sandbox

## Hosted version

Don't want to self-host? Use [shipkit.cc](https://shipkit.cc) — managed hosting with auth, chat UI, and team features.

## License

MIT
