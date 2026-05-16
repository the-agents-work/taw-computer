<p align="center">
  <img src="https://img.shields.io/badge/🖥️_taw--computer-Give_any_AI_a_real_computer-blue?style=for-the-badge&labelColor=000" alt="taw-computer" height="40">
</p>

<p align="center">
  <strong>Your AI writes code. This lets it <em>use</em> a computer.</strong>
</p>

<p align="center">
  <a href="https://github.com/the-agents-work/taw-computer/stargazers"><img src="https://img.shields.io/github/stars/the-agents-work/taw-computer?style=flat-square&logo=github&color=yellow" alt="Stars"></a>&nbsp;
  <a href="https://github.com/the-agents-work/taw-computer/blob/main/LICENSE"><img src="https://img.shields.io/github/license/the-agents-work/taw-computer?style=flat-square&color=green" alt="MIT License"></a>&nbsp;
  <a href="https://github.com/the-agents-work/taw-computer/issues"><img src="https://img.shields.io/github/issues/the-agents-work/taw-computer?style=flat-square" alt="Issues"></a>&nbsp;
  <a href="#quick-start"><img src="https://img.shields.io/badge/get_started-5_minutes-brightgreen?style=flat-square" alt="Get Started"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#demo">Demo</a> · <a href="https://shipkit.cc">Hosted Version</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="https://github.com/the-agents-work/taw-computer/issues">Report Bug</a>
</p>

---

## What if your AI could do everything you do on a computer?

Not just write code — but **open a browser**, **click buttons**, **fill forms**, **run servers**, **test in real browsers**, **install anything**, and **see the screen**?

**taw-computer** is an open-source [MCP server](https://modelcontextprotocol.io) that gives AI agents a full Ubuntu desktop inside Docker. Your AI connects, gets a real computer, and works like a human would.

> **No internal LLM. No chat UI. Your AI is the brain. This is the body.**

<br>

## Demo

<!-- 🎬 Replace with your actual demo GIF/video -->
<!-- Record: start Claude Code → "build me a landing page" → AI creates VM, codes, opens browser, shows result -->
<!-- Recommended: use asciinema for terminal, or screen record VNC + terminal side by side -->

<p align="center">
  <em>📹 Demo coming soon — <a href="https://github.com/the-agents-work/taw-computer/stargazers">star this repo</a> to get notified!</em>
</p>

<!-- When ready, uncomment:
<p align="center">
  <img src="docs/demo.gif" alt="taw-computer demo — AI builds a website from scratch" width="800">
  <br>
  <sub>AI builds a full website from a single prompt — writing code, installing packages, and testing in a real browser.</sub>
</p>
-->

<br>

## Why taw-computer?

Other tools let AI **write** code. taw-computer lets AI **use a computer**.

| | ChatGPT / Claude | Cursor / Copilot | Lovable / Bolt | **taw-computer** |
|---|:---:|:---:|:---:|:---:|
| Write code | ✅ | ✅ | ✅ | ✅ |
| Run shell commands | ❌ | Limited | Sandboxed | **Full Ubuntu** |
| Browse the web | ❌ | ❌ | ❌ | **Real Chromium** |
| See & click the screen | ❌ | ❌ | ❌ | **Desktop + VNC** |
| Install any software | ❌ | ❌ | ❌ | **apt/npm/pip** |
| Test in real browser | ❌ | ❌ | Preview only | **Playwright + CDP** |
| Persist across sessions | ❌ | ❌ | ✅ | **Snapshots** |
| Self-hostable | ❌ | ❌ | ❌ | **100% yours** |

<br>

## Quick start

Get running in under 5 minutes:

```bash
# 1. Clone & build
git clone https://github.com/the-agents-work/taw-computer.git
cd taw-computer
docker build -f images/Dockerfile.taw -t taw-computer-base .

# 2. Install & start
npm install && npm start
```

Then add to your AI client:

<details open>
<summary><strong>Claude Code</strong> (~/.claude/mcp.json)</summary>

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

Add to Cursor MCP settings (Settings → MCP Servers) — same JSON format as above.

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json` — same JSON format as above.

</details>

<details>
<summary><strong>Any MCP client</strong></summary>

taw-computer speaks standard MCP over stdio. Any client that supports MCP can connect.

</details>

<details>
<summary><strong>Remote server (SSH)</strong> — run on a beefy machine, use from your laptop</summary>

Got a powerful server / Mac Mini / VPS? Run taw-computer there and connect from anywhere:

```json
{
  "mcpServers": {
    "taw-computer": {
      "command": "ssh",
      "args": ["user@your-server", "cd /path/to/taw-computer && npx tsx mcp/index.ts"]
    }
  }
}
```

```
Your laptop (Claude Code)
    ↕ SSH (stdin/stdout piped over network)
Remote server (taw-computer + Docker)
    ↕ Docker
Ubuntu sandbox
```

Setup:
1. On the server: install Docker, clone repo, build image, `npm install`
2. On the server: enable SSH (`sudo systemctl enable ssh`)  
3. On your laptop: `ssh-copy-id user@your-server` (passwordless login)
4. Add the MCP config above — done!

Watch via VNC: open `http://your-server:6080` in your browser.

</details>

**That's it.** Now tell your AI: *"Create a VM and build me a website"* — and watch it work.

<br>

## What can it do?

### 🖥️ "Build me a landing page"
AI creates a VM → scaffolds Next.js → writes components → starts dev server → opens browser to check → iterates until it looks right

### 🌐 "Go to Amazon and find the best laptop under $1000"  
AI opens Chromium → navigates to Amazon → searches → scrolls → extracts prices → compares → reports back

### 🧪 "Run E2E tests on my deployed app"
AI launches Playwright → navigates to your URL → fills forms → clicks buttons → asserts results → reports failures

### 🔧 "Set up a PostgreSQL database with sample data"
AI runs `apt install postgresql` → creates database → writes seed script → runs it → verifies with queries

### 📸 "What does my app look like on mobile?"
AI takes desktop screenshot → resizes viewport → screenshots again → compares → suggests CSS fixes

<br>

## How it works

```
┌─────────────────────────────────────────────────────┐
│  Your AI Client                                     │
│  Claude Code · Cursor · Claude Desktop · any MCP    │
└───────────────────────┬─────────────────────────────┘
                        │ MCP protocol (stdio)
┌───────────────────────▼─────────────────────────────┐
│  taw-computer MCP server          30+ tools         │
│  vm · shell · files · browser · desktop · search    │
└───────────────────────┬─────────────────────────────┘
                        │ Docker API
┌───────────────────────▼─────────────────────────────┐
│  Ubuntu 22.04 Sandbox              isolated container│
│                                                      │
│   bash    Chromium + CDP    xfce4 Desktop + VNC     │
│     git npm pip curl          Playwright              │
│       python node              xdotool scrot          │
│                                                      │
│   /workspace ← your project files live here          │
└──────────────────────────────────────────────────────┘
```

<br>

## 30+ tools

<details open>
<summary><strong>VM Management</strong> — create, destroy, snapshot, resume</summary>

| Tool | What it does |
|------|-------------|
| `vm_create` | Spin up a new sandbox. Returns VNC URL to watch live |
| `vm_destroy` | Destroy (auto-saves snapshot for later) |
| `vm_reset` | Destroy + delete snapshot (fresh start) |
| `vm_restart` | Restart container, keep all files |
| `vm_status` | CPU, RAM, disk, uptime, top processes |
| `vm_list` | List running sandboxes |
| `vm_rename` | Rename a VM |
| `snapshot_list` | List saved snapshots |
| `snapshot_delete` | Delete a snapshot |

</details>

<details>
<summary><strong>Shell & Files</strong> — full Ubuntu command line + file ops</summary>

| Tool | What it does |
|------|-------------|
| `exec` | Run any command: git, npm, pip, curl, docker, anything |
| `fs_read` | Read a file |
| `fs_write` | Write a file (creates parent dirs) |
| `fs_edit` | Find-and-replace in a file |
| `fs_list` | ls / recursive find |
| `fs_search` | grep for patterns |
| `code_search` | ripgrep with regex, file types, context |
| `file_upload` | Upload file into VM (base64, max 50MB) |

</details>

<details>
<summary><strong>Browser (CDP/Playwright)</strong> — real browser, not a simulator</summary>

| Tool | What it does |
|------|-------------|
| `browser_navigate` | Go to URL, wait for load |
| `browser_snapshot` | Screenshot + numbered overlays on every clickable element |
| `browser_click_ref` | Click element #N from snapshot |
| `browser_type_ref` | Type into element #N |
| `browser_extract` | Read page text (CSS selector or full page) |
| `browser_eval` | Run JavaScript in page |
| `browser_wait_for` | Wait for selector / text / network idle |
| `browser_console_logs` | Read console.log, console.error, etc. |
| `browser_network_errors` | Catch 404s, CORS errors, failed requests |
| `browser_run_test` | Run a Playwright test script |
| `browser_open` | Open Chrome via desktop (fallback) |
| `browser_close` | Kill Chrome |
| `web_search` | Google search → top 8 results |

</details>

<details>
<summary><strong>Desktop</strong> — see and control the GUI</summary>

| Tool | What it does |
|------|-------------|
| `desktop_screenshot` | JPEG screenshot of the whole desktop |
| `desktop_click` | Click at (x, y) |
| `desktop_type` | Type text into focused window |
| `desktop_key` | Key combos: ctrl+c, alt+tab, Return, etc. |
| `desktop_scroll` | Scroll up/down |
| `desktop_drag` | Drag from A to B |

</details>

<br>

## Set-of-Mark: how browser automation actually works

Most "computer use" tools guess pixel coordinates. We use **Set-of-Mark prompting** — the AI sees numbered badges on every interactive element:

```
Step 1: browser_snapshot
        → AI sees screenshot with [1] Login  [2] Search  [3] Cart  ...

Step 2: browser_click_ref(ref=2)
        → clicks the Search box precisely

Step 3: browser_type_ref(ref=2, text="laptop", submit=true)  
        → types and presses Enter

Step 4: browser_snapshot
        → sees new page with results [4] [5] [6] ...
```

No coordinate guessing. No CSS selector fragility. The AI **sees** what it's clicking.

<br>

## VNC — watch your AI work in real time

Every sandbox comes with a **noVNC web viewer**. Open the URL in your browser and watch:

- 🖱️ AI navigating websites and clicking buttons
- ⌨️ AI writing code in the terminal  
- 🏗️ AI building and testing applications
- 🐛 AI debugging by inspecting the screen

Perfect for demos, debugging, and building trust in AI agents.

<br>

## What's inside each sandbox

| | Included |
|---|---|
| **OS** | Ubuntu 22.04 |
| **Desktop** | xfce4 + Xvfb + x11vnc + noVNC |
| **Browser** | Playwright Chromium (native arm64 + amd64) |
| **Languages** | Node.js 20, Python 3, build-essential |
| **CLI** | git, curl, wget, jq, ripgrep, tree, nano, vim |
| **DB clients** | PostgreSQL, MariaDB, Redis |
| **Dev tools** | GitHub CLI, yq, httpie |
| **Automation** | xdotool, scrot, imagemagick, xclip |

<br>

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_SANDBOXES` | `3` | Max concurrent VMs |
| `SANDBOX_TYPE` | `auto` | `auto` / `docker` / `firecracker` |
| `DOCKER_IMAGE` | `taw-computer-base` | Base image |
| `DOCKER_MEMORY_MB` | `4096` | RAM per container |
| `DOCKER_CPUS` | `2` | CPUs per container |
| `DESKTOP_RESOLUTION` | `1280x720` | Screen resolution |

<br>

## Requirements

| | Minimum |
|---|---|
| **Docker** | Docker Desktop or Docker Engine |
| **Node.js** | 20+ |
| **RAM** | ~4GB per sandbox |
| **Disk** | ~5GB for base image |

<br>

## Project structure

```
taw-computer/
├── mcp/
│   ├── index.ts            # MCP server — stdio, 30+ tool handlers
│   └── browser.ts          # Playwright CDP + Set-of-Mark engine
├── sandbox/
│   ├── SandboxManager.ts   # Abstract interface
│   ├── DockerSandbox.ts    # Docker implementation
│   ├── FirecrackerSandbox.ts # Firecracker microVM (optional)
│   ├── NetworkManager.ts   # Network isolation
│   ├── config.ts           # Env-based config
│   └── index.ts            # Auto-detect backend
├── images/
│   └── Dockerfile.taw      # Ubuntu sandbox image
├── .github/
│   ├── workflows/ci.yml    # CI: typecheck + Docker build
│   └── ISSUE_TEMPLATE/     # Bug report + feature request
├── package.json
├── CONTRIBUTING.md
└── LICENSE (MIT)
```

<br>

## Contributing

We'd love your help! See [CONTRIBUTING.md](CONTRIBUTING.md).

**Ideas for first contributions:**
- 🎨 Record a demo GIF for this README
- 📝 Write a tutorial ("Build X with taw-computer")
- 🔧 Add a new MCP tool (audio? clipboard? multi-tab?)
- 🐳 Build a slimmer Docker image
- 🧪 Add automated tests
- 📦 Support Podman / containerd

<br>

## Hosted version

Don't want to self-host? **[shipkit.cc](https://shipkit.cc)** — managed taw-computer with:
- Chat UI (just type what you want)
- Auth & team collaboration
- One-click app sharing
- No Docker setup needed

<br>

## FAQ

<details>
<summary><strong>How is this different from Lovable / Bolt / v0?</strong></summary>

Those are closed-source, hosted-only products that generate code. taw-computer gives AI a **real computer** — it can run servers, browse the web, install anything, and interact with any desktop app. It's also open source and self-hostable.

</details>

<details>
<summary><strong>How is this different from OpenInterpreter / Open Hands?</strong></summary>

OpenInterpreter runs code on your local machine (risky). Open Hands uses its own LLM orchestration. taw-computer is **just the computer** — no built-in LLM, no opinions about orchestration. Your existing AI client (Claude Code, Cursor, etc.) is the brain. taw-computer is a pure MCP server.

</details>

<details>
<summary><strong>Is it safe? Can the AI break my system?</strong></summary>

Each sandbox is an **isolated Docker container** with its own filesystem, network, and process space. Nothing inside can touch your host system. Containers have memory/CPU/PID limits. When you're done, destroy the VM.

</details>

<details>
<summary><strong>Can I use it with GPT-4 / Gemini / local models?</strong></summary>

Yes — any AI client that supports MCP can connect. The server doesn't care which LLM is behind the client.

</details>

<details>
<summary><strong>Does it work on Mac / Windows / Linux?</strong></summary>

Yes. Anywhere Docker runs, taw-computer runs. The sandbox image supports both arm64 (Apple Silicon) and amd64 (Intel/AMD).

</details>

<br>

## Star History

<p align="center">
  <a href="https://star-history.com/#the-agents-work/taw-computer&Date">
    <img src="https://api.star-history.com/svg?repos=the-agents-work/taw-computer&type=Date" alt="Star History" width="600">
  </a>
</p>

<p align="center">
  If taw-computer is useful to you, <a href="https://github.com/the-agents-work/taw-computer/stargazers"><strong>give it a ⭐</strong></a> — it helps others find it.
</p>

<br>

## Related

- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol taw-computer speaks
- [Claude Code](https://claude.ai/code) — AI coding CLI that supports MCP
- [Playwright](https://playwright.dev) — browser automation powering CDP tools

## License

[MIT](LICENSE) — do whatever you want with it.
