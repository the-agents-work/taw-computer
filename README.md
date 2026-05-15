<p align="center">
  <h1 align="center">taw-computer</h1>
  <p align="center">
    <strong>Give any AI a real computer.</strong>
  </p>
  <p align="center">
    <a href="https://github.com/the-agents-work/taw-computer/stargazers"><img src="https://img.shields.io/github/stars/the-agents-work/taw-computer?style=social" alt="GitHub Stars"></a>
    <a href="https://github.com/the-agents-work/taw-computer/blob/main/LICENSE"><img src="https://img.shields.io/github/license/the-agents-work/taw-computer" alt="License"></a>
    <a href="https://github.com/the-agents-work/taw-computer/issues"><img src="https://img.shields.io/github/issues/the-agents-work/taw-computer" alt="Issues"></a>
    <a href="https://www.npmjs.com/package/taw-computer"><img src="https://img.shields.io/npm/v/taw-computer" alt="npm"></a>
  </p>
</p>

---

Open source [MCP](https://modelcontextprotocol.io) server that gives AI agents a **real Ubuntu computer** — shell, browser, desktop, files — inside an isolated Docker container.

**No internal LLM. No chat UI. Your AI is the brain, this is the body.**

> Think of it as a computer that your AI can see, click, type, and code in — just like a human would.

## Why taw-computer?

Most AI coding tools generate code in a text editor. **taw-computer gives AI a full operating system:**

| Feature | Code-gen tools | taw-computer |
|---------|---------------|--------------|
| Run shell commands | Limited/sandboxed | Full Ubuntu bash |
| Browse the web | No | Real Chromium with CDP |
| See the screen | No | Desktop screenshots + VNC |
| Click UI elements | No | Desktop + browser automation |
| Install any software | No | apt, npm, pip, anything |
| Persist across sessions | No | Snapshot & resume |

## Use cases

- **AI builds a full-stack app** — scaffolds, codes, installs deps, runs dev server, tests in browser
- **AI browses the web** — research, scraping, filling forms, testing deployed apps
- **AI automates desktop apps** — interacts with any GUI application
- **AI runs tests** — E2E testing with real Playwright against real browsers
- **AI manages servers** — SSH, Docker, databases, deployments inside sandbox

## Quick start

### 1. Build the sandbox image

```bash
git clone https://github.com/the-agents-work/taw-computer.git
cd taw-computer
docker build -f images/Dockerfile.taw -t taw-computer-base .
```

### 2. Install & run

```bash
npm install
npm start
```

### 3. Connect your AI client

<details>
<summary><strong>Claude Code</strong></summary>

Add to `~/.claude/mcp.json`:

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

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to Cursor MCP settings (Settings > MCP Servers):

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

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

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

</details>

<details>
<summary><strong>Any MCP-compatible client</strong></summary>

taw-computer speaks standard MCP over stdio. Any client that supports MCP can connect.

</details>

## How it works

```
┌─────────────────────────────────────────────────┐
│  Your AI Client                                 │
│  (Claude Code, Cursor, Claude Desktop, etc.)    │
└──────────────────────┬──────────────────────────┘
                       │ MCP protocol (stdio)
┌──────────────────────▼──────────────────────────┐
│  taw-computer MCP server                        │
│  30+ tools: shell, files, browser, desktop      │
└──────────────────────┬──────────────────────────┘
                       │ Docker API
┌──────────────────────▼──────────────────────────┐
│  Ubuntu 22.04 Sandbox (isolated container)      │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Shell   │ │ Chromium │ │  xfce4 Desktop   │ │
│  │  (bash)  │ │  + CDP   │ │  + VNC viewer    │ │
│  └─────────┘ └──────────┘ └──────────────────┘ │
│  ┌─────────────────────────────────────────────┐│
│  │  /workspace (your project files)            ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

## Tools

### VM Management
| Tool | Description |
|------|-------------|
| `vm_create` | Create a new sandbox with label. Returns VNC URL for live viewing |
| `vm_list` | List active sandboxes |
| `vm_destroy` | Destroy sandbox (auto-saves snapshot for resume) |
| `vm_reset` | Destroy + delete snapshot (fresh start) |
| `vm_restart` | Restart container (preserves all files) |
| `vm_status` | CPU, memory, disk, uptime, top processes |
| `vm_rename` | Rename a running VM |

### Snapshots
| Tool | Description |
|------|-------------|
| `snapshot_list` | List saved snapshots |
| `snapshot_delete` | Delete a snapshot to free disk space |

> Snapshots let you pause and resume work. `vm_destroy` saves automatically; `vm_create` with `use_snapshot: true` picks up where you left off.

### Shell & Files
| Tool | Description |
|------|-------------|
| `exec` | Run any shell command (git, npm, pip, curl, etc.) |
| `fs_read` | Read a file |
| `fs_write` | Write a file (creates parent dirs) |
| `fs_edit` | Find-and-replace in a file |
| `fs_list` | List directory contents |
| `fs_search` | grep for patterns |
| `code_search` | ripgrep with regex, file types, context lines |
| `file_upload` | Upload file (base64, max 50MB) |

### Desktop Automation
| Tool | Description |
|------|-------------|
| `desktop_screenshot` | JPEG screenshot of the desktop |
| `desktop_click` | Click at (x, y) coordinates |
| `desktop_type` | Type text into focused window |
| `desktop_key` | Press key combos (ctrl+c, alt+tab, etc.) |
| `desktop_scroll` | Scroll up/down at position |
| `desktop_drag` | Drag from point A to point B |

### Browser Automation (CDP/Playwright)
| Tool | Description |
|------|-------------|
| `browser_navigate` | Go to URL, wait for load |
| `browser_snapshot` | Screenshot with numbered element overlays (Set-of-Mark) |
| `browser_click_ref` | Click element by ref number from snapshot |
| `browser_type_ref` | Type into element by ref number |
| `browser_extract` | Read text content (CSS selector or full page) |
| `browser_eval` | Run JavaScript in page context |
| `browser_wait_for` | Wait for selector/text/network idle |
| `browser_console_logs` | Read browser console output |
| `browser_network_errors` | Read network failures (404s, CORS, etc.) |
| `browser_run_test` | Run Playwright test scripts |
| `browser_open` | Open Chrome via xdotool (fallback) |
| `browser_close` | Kill all Chrome processes |

### Search
| Tool | Description |
|------|-------------|
| `web_search` | Google search, returns top 8 results |

## Set-of-Mark browser automation

taw-computer uses **Set-of-Mark prompting** for reliable browser interaction:

```
1. browser_navigate → go to page
2. browser_snapshot  → screenshot with numbered overlays on every clickable element
3. browser_click_ref(ref=5) → click element #5
4. browser_type_ref(ref=3, text="hello") → type into element #3
```

The AI sees numbered badges on buttons, links, and inputs — no guessing pixel coordinates. Much more reliable than raw coordinate clicking.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_SANDBOXES` | `3` | Max concurrent sandboxes |
| `SANDBOX_TYPE` | `auto` | `auto`, `docker`, or `firecracker` |
| `DOCKER_IMAGE` | `taw-computer-base` | Docker image for sandboxes |
| `DOCKER_MEMORY_MB` | `4096` | Memory limit per container |
| `DOCKER_CPUS` | `2` | CPU limit per container |
| `DOCKER_PIDS_LIMIT` | `512` | Process limit per container |
| `DOCKER_SHM_SIZE` | `2g` | Shared memory for Chromium |
| `DESKTOP_ENABLED` | `true` | Enable VNC desktop |
| `DESKTOP_RESOLUTION` | `1280x720` | Desktop resolution |

## VNC — watch your AI work

Each sandbox runs a noVNC web viewer. When you create a VM, you get a `vnc_url` — open it in your browser to **watch the AI work in real time**.

You can see it:
- Navigate websites
- Click buttons and fill forms
- Write code in the terminal
- Build and test applications

Great for demos, debugging, and trust-building.

## Requirements

- **Docker** (Docker Desktop or Docker Engine)
- **Node.js 20+**
- **~4GB RAM** per sandbox (Chromium + desktop are hungry)

## What's inside the sandbox

The Docker image (`Dockerfile.taw`) includes:

| Category | Software |
|----------|----------|
| **OS** | Ubuntu 22.04 |
| **Desktop** | xfce4, Xvfb, x11vnc, noVNC |
| **Browser** | Playwright Chromium (arm64 + amd64 native) |
| **Languages** | Node.js 20, Python 3, build-essential |
| **CLI tools** | git, curl, wget, jq, ripgrep, tree, nano, vim |
| **DB clients** | postgresql-client, mariadb-client, redis-tools |
| **Dev tools** | GitHub CLI (gh), yq, httpie |
| **Automation** | xdotool, scrot, imagemagick, xclip |

## Project structure

```
taw-computer/
├── mcp/
│   ├── index.ts          # MCP server (stdio transport, tool handlers)
│   └── browser.ts        # Playwright CDP controller + Set-of-Mark
├── sandbox/
│   ├── SandboxManager.ts # Abstract sandbox interface
│   ├── DockerSandbox.ts  # Docker container implementation
│   ├── FirecrackerSandbox.ts  # Firecracker microVM (optional)
│   ├── NetworkManager.ts # Network isolation
│   ├── config.ts         # Environment-based configuration
│   └── index.ts          # Auto-detect best backend
├── images/
│   └── Dockerfile.taw    # Ubuntu sandbox image definition
├── package.json
└── tsconfig.json
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Some ideas:
- Add new MCP tools (audio, video, clipboard, etc.)
- Improve browser automation reliability
- Add GPU/CUDA support for ML workloads
- Build lighter sandbox images
- Write tutorials and examples
- Support more sandbox backends (Podman, containerd, etc.)

## Hosted version

Don't want to self-host? Try [shipkit.cc](https://shipkit.cc) — managed taw-computer with auth, chat UI, team collaboration, and one-click sharing.

## Related projects

- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol taw-computer speaks
- [Claude Code](https://claude.ai/code) — AI coding assistant that can use MCP servers
- [Playwright](https://playwright.dev) — browser automation library powering our CDP tools

## Star history

If this project is useful to you, please give it a star! It helps others discover it.

[![Star History Chart](https://api.star-history.com/svg?repos=the-agents-work/taw-computer&type=Date)](https://star-history.com/#the-agents-work/taw-computer&Date)

## License

[MIT](LICENSE) — use it however you want.
