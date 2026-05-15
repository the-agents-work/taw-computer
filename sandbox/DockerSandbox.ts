import { exec, type ExecOptions } from 'child_process';
import path from 'path';
import fs from 'fs';
import { SandboxManager, type CreateOptions, type FileEntry, type PTYSpawnArgs, type SandboxType } from './SandboxManager';
import config from './config';

function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/** POSIX single-quote escape — safe for any shell string. Use for every
 *  user-supplied path/value embedded into a bash command. JSON.stringify
 *  produces double-quoted strings, which still expand $vars and backticks. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Deterministic, Docker-valid image name for a user+label snapshot. */
function snapshotImageName(userId: number, label: string): string {
  const sanitized = label.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  return `taw-snapshot-${userId}-${sanitized}`;
}

function execPromise(cmd: string, opts: ExecOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      let result = '';
      if (stdout) result += stdout.toString();
      if (stderr) result += (result ? '\n' : '') + stderr.toString();
      if (error && !stdout && !stderr) result = `Error: ${error.message}`;
      if (!result) result = 'Command completed successfully (no output)';
      resolve(result);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DockerSandbox extends SandboxManager {
  // Single-flight cache of an in-progress Chrome spawn per sandbox.
  private _chromeSpawning = new Map<string, Promise<void>>();
  private _xclipCache = new Map<string, boolean>();

  async create(opts: CreateOptions = {}): Promise<string | null> {
    const name = `taw-computer-${genId()}`;
    const netName = `taw-net-${name}`;

    try {
      const dc = config.docker;
      const platform = process.env.DOCKER_PLATFORM ?? '';
      const platformFlag = platform ? `--platform=${platform}` : '';
      const limits = `--memory ${dc.memoryMb}m --cpus ${dc.cpus} --pids-limit ${dc.pidsLimit} --shm-size=${dc.shmSize}`;
      // Create an isolated bridge network per container so containers
      // cannot reach each other. The host can still reach all container IPs.
      await execPromise(`docker network create ${netName}`);
      let mounts = '';
      if (opts.profileDir) {
        const abs = path.resolve(opts.profileDir);
        fs.mkdirSync(abs, { recursive: true });
        mounts = `-v ${JSON.stringify(abs)}:/home/taw/.config/chrome-profile`;
      }
      const image = opts.image || dc.image;
      await execPromise(
        `docker run -d --init ${platformFlag} --name ${name} --network ${netName} ${limits} -w /workspace ${mounts} ${image} tail -f /dev/null`,
      );

      // Block abuse-prone outbound ports from the container.
      // SMTP (25, 465, 587): prevent spam/phishing email
      // IRC (6667, 6697): common C2 channel
      // Runs as iptables rules on the host, applied per-container IP.
      this._blockAbusePorts(name).catch(e =>
        console.error(`Failed to apply egress rules for ${name}:`, e),
      );

      this.setupDesktop(name);

      return name;
    } catch (e) {
      console.error('Docker container creation failed:', (e as Error).message);
      // Clean up network on failure
      await execPromise(`docker network rm ${netName} 2>/dev/null`);
      return null;
    }
  }

  /** Block outbound connections to abuse-prone ports from a container. */
  private async _blockAbusePorts(sandboxId: string): Promise<void> {
    const ip = await this.getContainerIP(sandboxId);
    if (!ip) return;
    // Ports to block: SMTP (spam), IRC (C2/botnets)
    const blockedPorts = [25, 465, 587, 6667, 6697];
    for (const port of blockedPorts) {
      await execPromise(
        `sudo iptables -I DOCKER-USER -s ${ip} -p tcp --dport ${port} -j DROP 2>/dev/null || true`,
      );
    }
    console.log(`Egress rules applied for ${sandboxId} (${ip}): blocked ports ${blockedPorts.join(',')}`);
  }

  /** Remove iptables rules for a container on destroy. */
  private async _unblockAbusePorts(sandboxId: string): Promise<void> {
    const ip = await this.getContainerIP(sandboxId);
    if (!ip) return;
    const blockedPorts = [25, 465, 587, 6667, 6697];
    for (const port of blockedPorts) {
      await execPromise(
        `sudo iptables -D DOCKER-USER -s ${ip} -p tcp --dport ${port} -j DROP 2>/dev/null || true`,
      );
    }
  }

  async ensureChrome(sandboxId: string, url?: string): Promise<void> {
    return this._ensureChrome(sandboxId, url);
  }

  async setupDesktop(name: string): Promise<void> {
    const resolution = config.desktop.resolution;
    const depth = config.desktop.colorDepth;

    // Xvfb (real X server with virtual framebuffer) replaces Xvnc here.
    // Xvnc bundles its own X server with a custom framebuffer that
    // chromium's compositor doesn't paint into reliably (window mapped
    // but pixels never reach the framebuffer). Xvfb is a vanilla X
    // server — chromium paints normally — and x11vnc layered on top
    // streams its framebuffer over RFB. websockify+noVNC unchanged.
    console.log(`Desktop: Starting Xvfb in ${name}...`);
    await execPromise(
      `docker exec -d ${name} bash -c "Xvfb :1 -screen 0 ${resolution}x${depth} -ac -nolisten tcp +extension RANDR > /tmp/xvfb.log 2>&1 &"`,
    );
    await sleep(1500);

    console.log(`Desktop: Starting XFCE4 in ${name}...`);
    await execPromise(
      `docker exec -d ${name} bash -c "export DISPLAY=:1 && dbus-launch --exit-with-session startxfce4 > /tmp/xfce.log 2>&1 &"`,
    );
    await sleep(2500);

    console.log(`Desktop: Starting x11vnc in ${name}...`);
    // -forever: keep running after first client disconnects.
    // -shared: allow multiple viewers.
    // -nopw + -listen 127.0.0.1: no auth, only reachable through websockify.
    // -noxdamage: more reliable redraw with chromium's compositor.
    await execPromise(
      `docker exec -d ${name} bash -c "x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -noxdamage > /tmp/x11vnc.log 2>&1 &"`,
    );
    await sleep(800);

    console.log(`Desktop: Starting websockify in ${name}...`);
    // --web serves the noVNC HTML/JS viewer alongside the WebSocket proxy.
    await execPromise(
      `docker exec -d ${name} bash -c "websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 > /tmp/wsk.log 2>&1 &"`,
    );
    await sleep(500);

    console.log(`Desktop: Ready for ${name} (access via container IP:6080)`);
  }

  async copyToSandbox(sandboxId: string, hostPath: string, containerPath: string): Promise<string> {
    return execPromise(`docker cp ${shq(hostPath)} ${sandboxId}:${shq(containerPath)}`);
  }

  async getContainerIP(sandboxId: string): Promise<string | null> {
    // With user-defined networks, IP is under .Networks.{name}, not .IPAddress
    const result = await execPromise(
      `docker inspect ${sandboxId} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
    );
    const ip = result.trim();
    return ip && ip !== '' ? ip : null;
  }

  async copyFromSandbox(sandboxId: string, containerPath: string, hostPath: string): Promise<string> {
    return execPromise(`docker cp ${sandboxId}:${shq(containerPath)} ${shq(hostPath)}`);
  }

  async destroy(sandboxId: string): Promise<void> {
    if (sandboxId) {
      this._chromeSpawning.delete(sandboxId);
      this._xclipCache.delete(sandboxId);
      // Remove iptables rules before destroying (need container IP)
      await this._unblockAbusePorts(sandboxId).catch(() => {});
      await execPromise(`docker rm -f ${sandboxId}`);
      await execPromise(`docker network rm taw-net-${sandboxId} 2>/dev/null`);
    }
  }

  async commitSnapshot(sandboxId: string, userId: number, label: string): Promise<boolean> {
    const imageName = snapshotImageName(userId, label);
    try {
      const result = await execPromise(`docker commit ${sandboxId} ${imageName}`, { timeout: 120000 });
      console.log(`Snapshot saved: ${imageName}`);
      return !result.startsWith('Error');
    } catch (e) {
      console.error(`Snapshot commit failed for ${sandboxId}:`, (e as Error).message);
      return false;
    }
  }

  async snapshotExists(userId: number, label: string): Promise<boolean> {
    const imageName = snapshotImageName(userId, label);
    const result = await execPromise(`docker image inspect ${imageName} 2>/dev/null`);
    return !result.startsWith('Error');
  }

  async deleteSnapshot(userId: number, label: string): Promise<void> {
    const imageName = snapshotImageName(userId, label);
    await execPromise(`docker rmi ${imageName} 2>/dev/null`);
  }

  async listSnapshots(userId: number): Promise<string[]> {
    const prefix = `taw-snapshot-${userId}-`;
    const result = await execPromise(`docker images --format '{{.Repository}}' | grep '^${prefix}' 2>/dev/null`);
    if (!result || result.startsWith('Error')) return [];
    return result.trim().split('\n').filter(Boolean).map(img => img.replace(prefix, ''));
  }

  /** stdio mode: find any snapshot image matching a label (any user). */
  async findSnapshot(label: string): Promise<string | null> {
    const suffix = `-${label.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 80)}`;
    const result = await execPromise(`docker images --format '{{.Repository}}' | grep '^taw-snapshot-' | grep '${suffix}$' 2>/dev/null`);
    if (!result || result.startsWith('Error')) return null;
    const matches = result.trim().split('\n').filter(Boolean);
    return matches[0] ?? null;
  }

  /** List all snapshots across all users (for stdio mode). */
  async listAllSnapshots(): Promise<string[]> {
    const result = await execPromise(`docker images --format '{{.Repository}}' | grep '^taw-snapshot-' 2>/dev/null`);
    if (!result || result.startsWith('Error')) return [];
    return result.trim().split('\n').filter(Boolean).map(img => {
      // Extract label from "taw-snapshot-{userId}-{label}"
      const m = img.match(/^taw-snapshot-\d+-(.+)$/);
      return m ? m[1] : img;
    });
  }

  private async _hasXclip(sandboxId: string): Promise<boolean> {
    const cached = this._xclipCache.get(sandboxId);
    if (cached !== undefined) return cached;
    const r = await this.exec(sandboxId, 'command -v xclip >/dev/null 2>&1 && echo y || echo n');
    const ok = r.trim() === 'y';
    this._xclipCache.set(sandboxId, ok);
    return ok;
  }

  async exec(sandboxId: string | null, command: string): Promise<string> {
    if (!sandboxId) {
      throw new Error('Sandbox not ready: cannot execute commands until the container is created');
    }
    // shq → single-quoted POSIX literal. JSON.stringify produces double quotes,
    // which let the HOST shell expand $vars/backticks before docker even sees
    // the command — so any multi-statement script using WID=$(…) then $WID
    // would lose the variable. shq() is opaque to the host shell.
    return execPromise(`docker exec -e DISPLAY=:1 ${sandboxId} bash -c ${shq(command)}`);
  }

  async writeFile(sandboxId: string | null, filePath: string, content: string): Promise<string> {
    if (!sandboxId) throw new Error('Sandbox not ready');
    const dir = path.dirname(filePath);
    await this.exec(sandboxId, `mkdir -p ${shq(dir)}`);
    // Pipe content via stdin to avoid shell ARG_MAX limit on large files
    return new Promise((resolve) => {
      const proc = exec(
        `docker exec -i ${sandboxId} bash -c ${shq(`base64 -d > ${shq(filePath)}`)}`,
        { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) resolve(`Error: ${error.message}`);
          else resolve(stdout?.toString() || stderr?.toString() || 'File written successfully');
        },
      );
      proc.stdin?.write(Buffer.from(content).toString('base64'));
      proc.stdin?.end();
    });
  }

  async listFiles(sandboxId: string | null, directory: string, recursive = false): Promise<string> {
    const dir = shq(directory);
    const cmd = recursive
      ? `find ${dir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -200`
      : `ls -la ${dir} 2>/dev/null`;
    return this.exec(sandboxId, cmd);
  }

  async editFile(sandboxId: string | null, filePath: string, oldString: string, newString: string, replaceAll = false): Promise<string> {
    const content = await this.exec(sandboxId, `cat ${shq(filePath)}`);
    if (!content.includes(oldString)) {
      return `Error: Could not find the specified string in ${filePath}`;
    }
    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    await this.writeFile(sandboxId, filePath, newContent);
    return `File edited: ${filePath}`;
  }

  async search(sandboxId: string | null, pattern: string, directory = '/workspace', filePattern = ''): Promise<string> {
    const fpFlag = filePattern ? `--include=${shq(filePattern)}` : '';
    const cmd = `grep -rn ${fpFlag} ${shq(pattern)} ${shq(directory)} 2>/dev/null | head -50`;
    return this.exec(sandboxId, cmd);
  }

  async getFileList(sandboxId: string | null, dirPath: string): Promise<FileEntry[]> {
    const cmd = `ls -la ${shq(dirPath)} 2>/dev/null | tail -n +2`;
    const result = await this.exec(sandboxId, cmd);
    const entries: FileEntry[] = [];
    const lines = result.split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      const name = parts.slice(8).join(' ');
      if (name === '.' || name === '..') continue;
      const isDir = line.startsWith('d');
      entries.push({
        name,
        type: isDir ? 'directory' : 'file',
        path: path.join(dirPath, name),
        size: parseInt(parts[4]) || 0,
      });
    }
    return entries;
  }

  async takeScreenshot(sandboxId: string): Promise<string | null> {
    return this.takeScreenshotWithOpts(sandboxId, 75, 1024);
  }

  async takeScreenshotWithOpts(sandboxId: string, quality = 75, maxWidth = 1024): Promise<string | null> {
    if (!sandboxId) return null;
    console.error(`[DockerSandbox.screenshot] container=${sandboxId} quality=${quality} maxWidth=${maxWidth}`);
    const cmd =
      `rm -f /tmp/_s.png && ` +
      `DISPLAY=:1 scrot /tmp/_s.png 2>/dev/null && ` +
      `convert /tmp/_s.png -resize ${maxWidth}x\\> -quality ${quality} jpeg:- 2>/dev/null | base64 -w0`;
    const dockerCmd = `docker exec ${sandboxId} bash -c ${JSON.stringify(cmd)}`;
    console.error(`[DockerSandbox.screenshot] exec: docker exec ${sandboxId} bash -c ...`);
    const result = await execPromise(dockerCmd);
    console.error(`[DockerSandbox.screenshot] result: ${result ? `${result.length} chars` : 'empty/null'}`);
    if (!result || result.startsWith('Error')) return null;
    return result.trim().replace(/\s/g, '');
  }

  private async _ensureChrome(sandboxId: string, url?: string): Promise<void> {
    const profile = '/home/taw/.config/chrome-profile';
    const flags = [
      '--no-sandbox',
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--password-store=basic',
      '--start-maximized',
      `--user-data-dir=${profile}`,
      // /dev/shm in containers is only 64MB by default — chromium uses it for
      // shared memory between renderer/GPU processes and OOM-crashes the tab
      // on heavy SPAs (Bing, GMail, etc). Routing through /tmp avoids this
      // class of "Target crashed" errors entirely.
      '--disable-dev-shm-usage',
      // CDP: Playwright on the host attaches via http://localhost:<chromePort>.
      // Playwright's bundled Chromium honors --remote-debugging-address=0.0.0.0
      // (Google Chrome 148+ silently drops it). --remote-allow-origins=* avoids
      // host-header rejection over docker NAT. --disable-blink-features
      // hides the navigator.webdriver fingerprint.
      '--remote-debugging-port=9222',
      '--remote-debugging-address=0.0.0.0',
      '--remote-allow-origins=*',
      '--disable-blink-features=AutomationControlled',
    ].join(' ');
    // CDP bridge: ensure 0.0.0.0:9223 → 127.0.0.1:9222 forwarder is up before
    // launching chromium. We check by port listener (not pgrep) because pgrep
    // -f matches the bash wrapper's own cmdline — it contains the search
    // string and always reports a false positive.
    const bridgeUp = await this.exec(sandboxId, "netstat -tln 2>/dev/null | grep -q ':9223 ' && echo yes || echo no");
    if (bridgeUp.trim() !== 'yes') {
      await this.exec(sandboxId, 'nohup /usr/local/bin/cdp-bridge 9223 9222 > /tmp/cdp-bridge.log 2>&1 &');
      await sleep(300);
    }
    // Liveness check: don't trust the listener alone — chromium can leave a
    // dead socket or crashpad handler bound to 9222 after a renderer crash.
    // curl /json/version verifies the actual CDP HTTP server is responding.
    const live = await this.exec(
      sandboxId,
      "curl -sf -m 2 http://localhost:9222/json/version >/dev/null && echo yes || echo no",
    );
    if (live.trim() !== 'yes') {
      // Clean up any half-dead processes + profile lock so respawn doesn't
      // collide with a zombie that owns user-data-dir.
      await this.exec(
        sandboxId,
        `pkill -9 -f chromium 2>/dev/null; pkill -9 -f 'chrome-linux64/chrome' 2>/dev/null; pkill -9 -f chrome_crashpad 2>/dev/null; rm -f ${profile}/SingletonLock ${profile}/SingletonCookie ${profile}/SingletonSocket 2>/dev/null; sleep 1; true`,
      );
      // Single-flight: if another caller is already spawning Chrome for this
      // sandbox, wait on that promise instead of racing to spawn a second
      // process (which would die on the profile lock).
      let spawning = this._chromeSpawning.get(sandboxId);
      if (!spawning) {
        const target = url ? JSON.stringify(url) : '"about:blank"';
        spawning = (async () => {
          await this.exec(sandboxId, `DISPLAY=:1 nohup chromium ${flags} ${target} > /tmp/chrome.log 2>&1 &`);
          // First launch needs longer for the browser to paint.
          await sleep(4000);
        })();
        this._chromeSpawning.set(sandboxId, spawning);
        spawning.finally(() => this._chromeSpawning.delete(sandboxId));
      }
      await spawning;
    }

    // Bring Chrome to the front so subsequent xdotool type/click hit the right window.
    // Without this, keystrokes can land on the (currently focused) xfce4 desktop instead.
    await this.exec(
      sandboxId,
      `DISPLAY=:1 bash -c 'WID=$(xdotool search --onlyvisible --class chrome 2>/dev/null | head -1); if [ -n "$WID" ]; then xdotool windowmap "$WID" 2>/dev/null; xdotool windowraise "$WID" 2>/dev/null; xdotool windowactivate --sync "$WID" 2>/dev/null; xdotool windowfocus --sync "$WID" 2>/dev/null; fi'`,
    );
    await sleep(400);

    // If Chrome was already running and we have a URL, navigate via the address bar
    // (ctrl+l selects the URL bar; type URL; Return). Re-launching Chrome with a URL
    // tries to open a new window/tab but on a single-instance --user-data-dir lock the
    // visible tab often doesn't update, so subsequent screenshots stay stale.
    if (live.trim() === 'yes' && url) {
      await this.exec(sandboxId, `DISPLAY=:1 xdotool key --clearmodifiers ctrl+l`);
      await sleep(150);
      await this.exec(sandboxId, `DISPLAY=:1 xdotool key --clearmodifiers ctrl+a`);
      await sleep(100);
      await this.exec(sandboxId, `DISPLAY=:1 xdotool type --clearmodifiers --delay 5 ${JSON.stringify(url)}`);
      await sleep(150);
      await this.exec(sandboxId, `DISPLAY=:1 xdotool key --clearmodifiers Return`);
      // Wait for navigation + paint.
      await sleep(2500);
    } else {
      // Cold start: Chrome already opened the URL via argv, just give it a paint pause.
      await sleep(800);
    }
  }

  async desktopAction(sandboxId: string | null, op: string, params: Record<string, unknown> = {}): Promise<string> {
    if (!sandboxId) return 'No sandbox available';
    const display = 'DISPLAY=:1';

    switch (op) {
      case 'click': {
        const { x, y, button = 1 } = params as { x: number; y: number; button?: number };
        return this.exec(sandboxId, `${display} xdotool mousemove ${x} ${y} click ${button}`);
      }
      case 'double_click': {
        const { x, y } = params as { x: number; y: number };
        return this.exec(sandboxId, `${display} xdotool mousemove ${x} ${y} click --repeat 2 1`);
      }
      case 'type': {
        const { text } = params as { text: string };
        // For ASCII, xdotool type is fast and reliable. For Unicode (Vietnamese
        // diacritics, emoji, CJK), xdotool type drops chars without keysyms, so
        // route through the X clipboard: write file via base64 (safe for any
        // bytes), xclip into CLIPBOARD, paste with ctrl+v. App must accept
        // ctrl+v — for terminals the AI should fall back to ctrl+shift+v.
        const hasUnicode = /[^\x00-\x7F]/.test(text);
        if (hasUnicode && (await this._hasXclip(sandboxId))) {
          await this.writeFile(sandboxId, '/tmp/_clip.txt', text);
          return this.exec(
            sandboxId,
            `${display} bash -c 'xclip -selection clipboard < /tmp/_clip.txt && xdotool key --clearmodifiers ctrl+v'`,
          );
        }
        // No xclip in image (pre-rebuild) → fall back to xdotool type. ASCII
        // works fine; Unicode keysyms missing from the X server are silently
        // dropped, but the call won't crash.
        return this.exec(sandboxId, `${display} xdotool type --clearmodifiers --delay 8 ${JSON.stringify(text)}`);
      }
      case 'key': {
        const { key } = params as { key: string };
        return this.exec(sandboxId, `${display} xdotool key ${key}`);
      }
      case 'screenshot': {
        const b64 = await this.takeScreenshot(sandboxId);
        return b64 ? `data:image/jpeg;base64,${b64}` : 'Screenshot failed';
      }
      case 'mouse_move': {
        const { x, y } = params as { x: number; y: number };
        return this.exec(sandboxId, `${display} xdotool mousemove ${x} ${y}`);
      }
      case 'scroll': {
        const { x, y, direction = 'down', amount = 3 } = params as {
          x: number;
          y: number;
          direction?: 'up' | 'down';
          amount?: number;
        };
        // Move mouse to target, click to focus, then use key-based scrolling.
        // xdotool mouse button 4/5 often fails in Chrome (XInput2 vs legacy).
        // Page_Down/Page_Up is more reliable; for fine scrolling we repeat
        // arrow keys instead.
        const key = direction === 'up' ? 'Page_Up' : 'Page_Down';
        const repeats = Math.max(1, Math.ceil(amount / 3));
        return this.exec(sandboxId, `${display} xdotool mousemove ${x} ${y} click 1 && sleep 0.1 && ${display} xdotool key --repeat ${repeats} --delay 100 ${key}`);
      }
      case 'drag': {
        const { from_x, from_y, to_x, to_y, button = 1, hold_ms = 150 } = params as {
          from_x: number;
          from_y: number;
          to_x: number;
          to_y: number;
          button?: number;
          hold_ms?: number;
        };
        // Sleeps between phases matter — some apps (file managers, canvas
        // drawing, Trello-style boards) only register a drag when the
        // button-down lingers before motion. 150ms is conservative.
        const holdSec = (hold_ms / 1000).toFixed(3);
        const cmd =
          `${display} bash -c 'xdotool mousemove ${from_x} ${from_y} && ` +
          `xdotool mousedown ${button} && sleep ${holdSec} && ` +
          `xdotool mousemove ${to_x} ${to_y} && sleep 0.1 && ` +
          `xdotool mouseup ${button}'`;
        return this.exec(sandboxId, cmd);
      }
      case 'open_browser': {
        const { url } = params as { url?: string };
        await this._ensureChrome(sandboxId, url);
        const b64 = await this.takeScreenshot(sandboxId);
        return b64 ? `data:image/jpeg;base64,${b64}` : `Chrome opened${url ? ` at ${url}` : ''} (screenshot failed)`;
      }
      case 'close_browser': {
        await this.exec(sandboxId, 'pkill -9 -f "chrome-linux64/chrome|chromium|chrome_crashpad" 2>/dev/null || true');
        return 'Chromium closed';
      }
      default:
        return `Unknown desktop action: ${op}`;
    }
  }

  async getVMStatus(sandboxId: string): Promise<Record<string, unknown> | null> {
    if (!sandboxId) return null;
    const [cpuMem, disk, uptime, procs] = await Promise.all([
      execPromise(`docker exec ${sandboxId} bash -c "top -bn1 | head -5"`),
      execPromise(`docker exec ${sandboxId} bash -c "df -h / | tail -1"`),
      execPromise(`docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' ${sandboxId}`),
      execPromise(`docker exec ${sandboxId} bash -c "ps aux --sort=-%mem | head -10"`),
    ]);
    const statsParts = uptime.trim().split(/\s+/);
    const diskParts = disk.trim().split(/\s+/);
    return {
      cpu_usage_pct: statsParts[0] ?? null,
      memory_usage: statsParts.slice(1).join(' ') || null,
      disk_total: diskParts[1] ?? null,
      disk_used: diskParts[2] ?? null,
      disk_usage_pct: diskParts[4] ?? null,
      top_processes: procs,
      container_ip: await this.getContainerIP(sandboxId),
    };
  }

  getPTYSpawnArgs(sandboxId: string | null): PTYSpawnArgs {
    if (sandboxId) {
      return {
        command: 'docker',
        args: ['exec', '-it', '-e', 'DISPLAY=:1', sandboxId, 'bash'],
        options: { name: 'xterm-256color', cols: 120, rows: 30 },
      };
    }
    const workDir = '/tmp/taw-computer-workspace';
    exec(`mkdir -p ${workDir}`);
    return {
      command: 'bash',
      args: [],
      options: { name: 'xterm-256color', cols: 120, rows: 30, cwd: workDir, env: process.env },
    };
  }

  getType(): SandboxType {
    return 'docker';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await execPromise('docker info 2>/dev/null');
      return !result.includes('Error');
    } catch {
      return false;
    }
  }
}

export default DockerSandbox;
