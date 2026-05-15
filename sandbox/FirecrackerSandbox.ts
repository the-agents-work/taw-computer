import { exec, spawn, type ChildProcess, type ExecOptions } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SandboxManager, type CreateOptions, type FileEntry, type PTYSpawnArgs, type SandboxType } from './SandboxManager';
import { NetworkManager } from './NetworkManager';
import config from './config';
import { createServer } from 'net';

interface VMRecord {
  socketPath: string;
  rootfsPath: string;
  fcProcess: ChildProcess;
  network: { tapName: string; vmIP: string; gatewayIP: string; macAddress: string; mask: string };
  vmIP: string;
  desktopPort: number | null;
  previewPort: number | null;
  chromePort: number | null;
  extraPorts: Map<number, number>; // hostPort → guestPort
}

function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/** POSIX single-quote escape — safe for any shell string. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function execPromise(cmd: string, opts: ExecOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: config.execTimeout, maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
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

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

// ── Port ranges (shared with DockerSandbox) ─────────────────────────────
let nextDesktopPort = config.desktop.portRangeStart;
const PREVIEW_PORT_RANGE_START = parseInt(process.env.PREVIEW_PORT_RANGE_START || '7100', 10);
const PREVIEW_PORT_RANGE_END = parseInt(process.env.PREVIEW_PORT_RANGE_END || '7200', 10);
let nextPreviewPort = PREVIEW_PORT_RANGE_START;
const CHROME_PORT_RANGE_START = parseInt(process.env.CHROME_PORT_RANGE_START || '9222', 10);
const CHROME_PORT_RANGE_END = parseInt(process.env.CHROME_PORT_RANGE_END || '9322', 10);
let nextChromePort = CHROME_PORT_RANGE_START;
const EXTRA_PORT_RANGE_START = parseInt(process.env.EXTRA_PORT_RANGE_START || '8100', 10);
const EXTRA_PORT_RANGE_END = parseInt(process.env.EXTRA_PORT_RANGE_END || '8200', 10);
let nextExtraPort = EXTRA_PORT_RANGE_START;

const vmRegistry = new Map<string, VMRecord>();
let hostNetworkInitialized = false;

export class FirecrackerSandbox extends SandboxManager {
  private _chromeSpawning = new Map<string, Promise<void>>();
  private _xclipCache = new Map<string, boolean>();

  // ── Port allocation ───────────────────────────────────────────────────

  private async _allocatePort(start: number, end: number, nextRef: { val: number }): Promise<number> {
    const range = end - start + 1;
    for (let i = 0; i < range; i++) {
      const port = nextRef.val++;
      if (nextRef.val > end) nextRef.val = start;
      if (await isPortFree(port)) return port;
    }
    throw new Error(`No free port in ${start}-${end}`);
  }

  private _desktopPortRef = { val: config.desktop.portRangeStart };
  private _previewPortRef = { val: PREVIEW_PORT_RANGE_START };
  private _chromePortRef = { val: CHROME_PORT_RANGE_START };
  private _extraPortRef = { val: EXTRA_PORT_RANGE_START };

  // ── iptables DNAT for port forwarding host → VM ───────────────────────

  private async _addPortForward(hostPort: number, vmIP: string, guestPort: number): Promise<void> {
    const cmds = [
      `sudo iptables -t nat -A PREROUTING -p tcp --dport ${hostPort} -j DNAT --to-destination ${vmIP}:${guestPort}`,
      `sudo iptables -t nat -A OUTPUT -p tcp --dport ${hostPort} -j DNAT --to-destination ${vmIP}:${guestPort}`,
    ];
    for (const cmd of cmds) {
      await execPromise(cmd).catch(() => {});
    }
  }

  private async _removePortForward(hostPort: number, vmIP: string, guestPort: number): Promise<void> {
    const cmds = [
      `sudo iptables -t nat -D PREROUTING -p tcp --dport ${hostPort} -j DNAT --to-destination ${vmIP}:${guestPort}`,
      `sudo iptables -t nat -D OUTPUT -p tcp --dport ${hostPort} -j DNAT --to-destination ${vmIP}:${guestPort}`,
    ];
    for (const cmd of cmds) {
      await execPromise(cmd).catch(() => {});
    }
  }

  // ── Create ────────────────────────────────────────────────────────────

  async create(opts: CreateOptions = {}): Promise<string | null> {
    const vmId = `fc-${genId()}`;
    const socketPath = path.join(config.firecracker.socketDir, `${vmId}.sock`);

    try {
      await execPromise(`sudo mkdir -p ${config.firecracker.socketDir}`);

      if (!hostNetworkInitialized) {
        await NetworkManager.setupHost();
        hostNetworkInitialized = true;
      }

      const network = await NetworkManager.createTAP(vmId);

      // Copy rootfs — each VM gets its own writable copy
      const vmRootfs = path.join(config.firecracker.socketDir, `${vmId}-rootfs.ext4`);
      await execPromise(`cp "${config.firecracker.rootfsPath}" "${vmRootfs}"`);

      const fcProcess = spawn('sudo', [config.firecracker.binaryPath, '--api-sock', socketPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      fcProcess.unref();

      await this._waitForSocket(socketPath);

      const networkBootArgs = NetworkManager.getNetworkBootArgs(network.vmIP, network.gatewayIP, network.mask);

      await this._apiCall(socketPath, 'PUT', '/boot-source', {
        kernel_image_path: config.firecracker.kernelPath,
        boot_args: `${config.firecracker.bootArgs} ${networkBootArgs}`,
      });

      await this._apiCall(socketPath, 'PUT', '/drives/rootfs', {
        drive_id: 'rootfs',
        path_on_host: vmRootfs,
        is_root_device: true,
        is_read_only: false,
      });

      // Bump memory for GUI workload — desktop + Chromium need ≥2GB
      const memSizeMib = Math.max(config.firecracker.memSizeMib, 2048);

      await this._apiCall(socketPath, 'PUT', '/machine-config', {
        vcpu_count: config.firecracker.vcpuCount,
        mem_size_mib: memSizeMib,
      });

      await this._apiCall(socketPath, 'PUT', '/network-interfaces/eth0', {
        iface_id: 'eth0',
        guest_mac: network.macAddress,
        host_dev_name: network.tapName,
      });

      await this._apiCall(socketPath, 'PUT', '/actions', { action_type: 'InstanceStart' });

      // Allocate host ports
      const desktopPort = await this._allocatePort(
        config.desktop.portRangeStart, config.desktop.portRangeEnd, this._desktopPortRef,
      );
      const previewPort = await this._allocatePort(
        PREVIEW_PORT_RANGE_START, PREVIEW_PORT_RANGE_END, this._previewPortRef,
      );
      const chromePort = await this._allocatePort(
        CHROME_PORT_RANGE_START, CHROME_PORT_RANGE_END, this._chromePortRef,
      );

      // Allocate extra ports
      const extraPorts = new Map<number, number>();
      if (opts.extraPorts) {
        for (const guestPort of opts.extraPorts) {
          const hostPort = await this._allocatePort(
            EXTRA_PORT_RANGE_START, EXTRA_PORT_RANGE_END, this._extraPortRef,
          );
          extraPorts.set(hostPort, guestPort);
        }
      }

      vmRegistry.set(vmId, {
        socketPath,
        rootfsPath: vmRootfs,
        fcProcess,
        network,
        vmIP: network.vmIP,
        desktopPort,
        previewPort,
        chromePort,
        extraPorts,
      });

      // Wait for SSH + init script (desktop starts automatically via rc.local)
      await this._waitForSSH(network.vmIP);

      // Inject SSH public key
      const pubKey = fs.readFileSync(config.firecracker.sshPubKeyPath, 'utf-8').trim();
      await this._sshExec(network.vmIP, `mkdir -p /root/.ssh && echo ${shq(pubKey)} >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`);

      // Ensure init script ran (desktop + services)
      await this._sshExec(network.vmIP, '/etc/init.d/taw-computer-init &');
      await sleep(5000); // Wait for desktop to fully start

      // Set up port forwarding: host → VM
      await this._addPortForward(desktopPort, network.vmIP, 6080);  // websockify/noVNC
      await this._addPortForward(previewPort, network.vmIP, 3000);  // preview
      await this._addPortForward(chromePort, network.vmIP, 9223);   // CDP bridge

      for (const [hostPort, guestPort] of extraPorts) {
        await this._addPortForward(hostPort, network.vmIP, guestPort);
      }

      console.log(`Firecracker VM ${vmId} started at ${network.vmIP} (VNC: ${desktopPort}, CDP: ${chromePort})`);
      return vmId;
    } catch (e) {
      console.error(`Firecracker VM creation failed: ${(e as Error).message}`);
      await this._cleanup(vmId);
      return null;
    }
  }

  // ── Network accessor ──────────────────────────────────────────────────

  async getContainerIP(sandboxId: string): Promise<string | null> {
    const vm = vmRegistry.get(sandboxId);
    return vm?.vmIP ?? null;
  }

  // ── Exec via SSH ──────────────────────────────────────────────────────

  async exec(sandboxId: string | null, command: string): Promise<string> {
    if (!sandboxId) return 'Error: VM not found';
    const vm = vmRegistry.get(sandboxId);
    if (!vm) return 'Error: VM not found';
    return this._sshExec(vm.vmIP, command);
  }

  // ── File ops ──────────────────────────────────────────────────────────

  async writeFile(sandboxId: string | null, filePath: string, content: string): Promise<string> {
    if (!sandboxId) return 'Error: VM not found';
    const vm = vmRegistry.get(sandboxId);
    if (!vm) return 'Error: VM not found';
    const dir = path.dirname(filePath);
    await this._sshExec(vm.vmIP, `mkdir -p ${shq(dir)}`);
    // Pipe content via stdin to avoid shell ARG_MAX limit on large files
    const b64 = Buffer.from(content).toString('base64');
    return new Promise((resolve) => {
      const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
        '-i', config.firecracker.sshKeyPath,
        `${config.firecracker.sshUser}@${vm.vmIP}`,
        `base64 -d > ${shq(filePath)}`,
      ], { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', () => resolve(out || 'File written successfully'));
      proc.on('error', (e) => resolve(`Error: ${e.message}`));
      proc.stdin?.write(b64);
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

  // ── Desktop / Screenshot ──────────────────────────────────────────────

  async takeScreenshot(sandboxId: string): Promise<string | null> {
    return this.takeScreenshotWithOpts(sandboxId, 75, 1024);
  }

  async takeScreenshotWithOpts(sandboxId: string, quality = 75, maxWidth = 1024): Promise<string | null> {
    if (!sandboxId) return null;
    const vm = vmRegistry.get(sandboxId);
    if (!vm) return null;
    const cmd =
      `rm -f /tmp/_s.png && ` +
      `DISPLAY=:1 scrot /tmp/_s.png 2>/dev/null && ` +
      `convert /tmp/_s.png -resize ${maxWidth}x\\> -quality ${quality} jpeg:- 2>/dev/null | base64 -w0`;
    const result = await this._sshExec(vm.vmIP, cmd);
    if (!result || result.startsWith('Error')) return null;
    return result.trim().replace(/\s/g, '');
  }

  private async _hasXclip(sandboxId: string): Promise<boolean> {
    const cached = this._xclipCache.get(sandboxId);
    if (cached !== undefined) return cached;
    const r = await this.exec(sandboxId, 'command -v xclip >/dev/null 2>&1 && echo y || echo n');
    const ok = r.trim() === 'y';
    this._xclipCache.set(sandboxId, ok);
    return ok;
  }

  async ensureChrome(sandboxId: string, url?: string): Promise<void> {
    const vm = vmRegistry.get(sandboxId);
    if (!vm) return;

    const profile = '/root/.config/chrome-profile';
    const flags = [
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--password-store=basic',
      '--start-maximized',
      `--user-data-dir=${profile}`,
      '--disable-dev-shm-usage',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=0.0.0.0',
      '--remote-allow-origins=*',
      '--disable-blink-features=AutomationControlled',
    ].join(' ');

    // Ensure CDP bridge is running
    const bridgeUp = await this.exec(sandboxId, "netstat -tln 2>/dev/null | grep -q ':9223 ' && echo yes || echo no");
    if (bridgeUp.trim() !== 'yes') {
      await this.exec(sandboxId, 'nohup /usr/local/bin/cdp-bridge 9223 9222 > /tmp/cdp-bridge.log 2>&1 &');
      await sleep(300);
    }

    // Check if Chrome is alive
    const live = await this.exec(
      sandboxId,
      "curl -sf -m 2 http://localhost:9222/json/version >/dev/null && echo yes || echo no",
    );
    if (live.trim() !== 'yes') {
      // Kill zombie processes + clear profile locks
      await this.exec(
        sandboxId,
        `pkill -9 -f chromium 2>/dev/null; pkill -9 -f chrome_crashpad 2>/dev/null; rm -f ${profile}/SingletonLock ${profile}/SingletonCookie ${profile}/SingletonSocket 2>/dev/null; sleep 1; true`,
      );

      let spawning = this._chromeSpawning.get(sandboxId);
      if (!spawning) {
        const target = url ? JSON.stringify(url) : '"about:blank"';
        spawning = (async () => {
          await this.exec(sandboxId, `DISPLAY=:1 nohup chromium ${flags} ${target} > /tmp/chrome.log 2>&1 &`);
          await sleep(4000);
        })();
        this._chromeSpawning.set(sandboxId, spawning);
        spawning.finally(() => this._chromeSpawning.delete(sandboxId));
      }
      await spawning;
    }

    // Bring Chrome to front
    await this.exec(
      sandboxId,
      `DISPLAY=:1 bash -c 'WID=$(xdotool search --onlyvisible --class chrome 2>/dev/null | head -1); if [ -n "$WID" ]; then xdotool windowmap "$WID" 2>/dev/null; xdotool windowraise "$WID" 2>/dev/null; xdotool windowactivate --sync "$WID" 2>/dev/null; xdotool windowfocus --sync "$WID" 2>/dev/null; fi'`,
    );
    await sleep(400);

    // Navigate if Chrome was already running
    if (live.trim() === 'yes' && url) {
      await this.exec(sandboxId, `DISPLAY=:1 xdotool key --clearmodifiers ctrl+l`);
      await sleep(150);
      await this.exec(sandboxId, `DISPLAY=:1 xdotool key --clearmodifiers ctrl+a`);
      await sleep(100);
      await this.exec(sandboxId, `DISPLAY=:1 xdotool type --clearmodifiers --delay 5 ${JSON.stringify(url)}`);
      await sleep(150);
      await this.exec(sandboxId, `DISPLAY=:1 xdotool key --clearmodifiers Return`);
      await sleep(2500);
    } else {
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
        const hasUnicode = /[^\x00-\x7F]/.test(text);
        if (hasUnicode && (await this._hasXclip(sandboxId))) {
          await this.writeFile(sandboxId, '/tmp/_clip.txt', text);
          return this.exec(
            sandboxId,
            `${display} bash -c 'xclip -selection clipboard < /tmp/_clip.txt && xdotool key --clearmodifiers ctrl+v'`,
          );
        }
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
          x: number; y: number; direction?: 'up' | 'down'; amount?: number;
        };
        const button = direction === 'up' ? 4 : 5;
        return this.exec(sandboxId, `${display} xdotool mousemove ${x} ${y} click --repeat ${amount} ${button}`);
      }
      case 'drag': {
        const { from_x, from_y, to_x, to_y, button = 1, hold_ms = 150 } = params as {
          from_x: number; from_y: number; to_x: number; to_y: number;
          button?: number; hold_ms?: number;
        };
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
        await this.ensureChrome(sandboxId, url);
        const b64 = await this.takeScreenshot(sandboxId);
        return b64 ? `data:image/jpeg;base64,${b64}` : `Chrome opened${url ? ` at ${url}` : ''} (screenshot failed)`;
      }
      case 'close_browser': {
        await this.exec(sandboxId, 'pkill -f "ms-playwright.*chrome|chromium" || true');
        return 'Chromium closed';
      }
      default:
        return `Unknown desktop action: ${op}`;
    }
  }

  // ── VM Status ─────────────────────────────────────────────────────────

  async getVMStatus(sandboxId: string): Promise<Record<string, unknown> | null> {
    const vm = vmRegistry.get(sandboxId);
    if (!vm) return null;

    const [cpuMem, disk, uptime, procs] = await Promise.all([
      this._sshExec(vm.vmIP, "top -bn1 | head -5"),
      this._sshExec(vm.vmIP, "df -h / | tail -1"),
      this._sshExec(vm.vmIP, "uptime -s 2>/dev/null || uptime"),
      this._sshExec(vm.vmIP, "ps aux --sort=-%mem | head -10"),
    ]);

    // Parse CPU/memory from top output
    const cpuMatch = cpuMem.match(/(\d+\.?\d*)[\s,]+id/);
    const cpuIdle = cpuMatch ? parseFloat(cpuMatch[1]) : 0;
    const memMatch = cpuMem.match(/Mem\s*:\s*(\d+)\s+total.*?(\d+)\s+used/i)
      || cpuMem.match(/MiB Mem\s*:\s*([\d.]+)\s+total.*?([\d.]+)\s+used/i);

    // Parse disk
    const diskParts = disk.trim().split(/\s+/);

    return {
      cpu_usage_pct: cpuIdle ? Math.round((100 - cpuIdle) * 10) / 10 : null,
      memory_total: memMatch?.[1] ?? null,
      memory_used: memMatch?.[2] ?? null,
      disk_total: diskParts[1] ?? null,
      disk_used: diskParts[2] ?? null,
      disk_usage_pct: diskParts[4] ?? null,
      uptime: uptime.trim(),
      top_processes: procs,
      vm_ip: vm.vmIP,
      ports: {
        vnc: vm.desktopPort,
        preview: vm.previewPort,
        chrome_cdp: vm.chromePort,
        extra: Object.fromEntries(vm.extraPorts),
      },
    };
  }

  // ── PTY ───────────────────────────────────────────────────────────────

  getPTYSpawnArgs(sandboxId: string | null): PTYSpawnArgs {
    if (!sandboxId) {
      return { command: 'bash', args: [], options: { name: 'xterm-256color', cols: 120, rows: 30 } };
    }
    const vm = vmRegistry.get(sandboxId);
    if (!vm) {
      return { command: 'bash', args: [], options: { name: 'xterm-256color', cols: 120, rows: 30 } };
    }
    return {
      command: 'ssh',
      args: [
        '-tt',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        '-i', config.firecracker.sshKeyPath,
        `${config.firecracker.sshUser}@${vm.vmIP}`,
      ],
      options: { name: 'xterm-256color', cols: 120, rows: 30 },
    };
  }

  getType(): SandboxType {
    return 'firecracker';
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!fs.existsSync('/dev/kvm')) return false;
      if (!fs.existsSync(config.firecracker.binaryPath)) return false;
      if (!fs.existsSync(config.firecracker.kernelPath)) return false;
      if (!fs.existsSync(config.firecracker.rootfsPath)) return false;
      if (!fs.existsSync(config.firecracker.sshKeyPath)) return false;
      return true;
    } catch {
      return false;
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────

  async copyToSandbox(_sandboxId: string, _hostPath: string, _containerPath: string): Promise<string> {
    throw new Error('File transfer not yet implemented for Firecracker VMs');
  }

  async copyFromSandbox(_sandboxId: string, _containerPath: string, _hostPath: string): Promise<string> {
    throw new Error('File transfer not yet implemented for Firecracker VMs');
  }

  async destroy(sandboxId: string): Promise<void> {
    await this._cleanup(sandboxId);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private async _waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(socketPath)) return;
      await sleep(100);
    }
    throw new Error(`Firecracker socket not available after ${timeoutMs}ms`);
  }

  private async _waitForSSH(vmIP: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this._sshExec(vmIP, 'echo ready', 5000);
        if (result.includes('ready')) return;
      } catch {
        // not ready yet
      }
      await sleep(1000);
    }
    throw new Error(`SSH not available on ${vmIP} after ${timeoutMs}ms`);
  }

  private async _sshExec(vmIP: string, command: string, timeout: number | null = null): Promise<string> {
    const fullCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', `ConnectTimeout=${Math.floor((timeout || config.sshTimeout) / 1000)}`,
      '-i', config.firecracker.sshKeyPath,
      `${config.firecracker.sshUser}@${vmIP}`,
      command,
    ];

    return new Promise((resolve) => {
      const proc = spawn(fullCmd[0], fullCmd.slice(1), {
        timeout: timeout || config.execTimeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('close', () => {
        let result = stdout;
        if (stderr) result += (result ? '\n' : '') + stderr;
        if (!result) result = 'Command completed successfully (no output)';
        resolve(result);
      });
      proc.on('error', (err) => {
        resolve(`Error: ${err.message}`);
      });
    });
  }

  private async _apiCall(socketPath: string, method: string, endpoint: string, body: unknown): Promise<string> {
    const data = JSON.stringify(body);
    const cmd = `curl -s --unix-socket "${socketPath}" -X ${method} "http://localhost${endpoint}" -H "Content-Type: application/json" -d '${data.replace(/'/g, "'\\''")}'`;
    const result = await execPromise(cmd);
    if (result.includes('error') || result.includes('Error')) {
      const parsed: { fault_message?: string } | null = (() => {
        try { return JSON.parse(result); } catch { return null; }
      })();
      if (parsed && parsed.fault_message) {
        throw new Error(`Firecracker API error: ${parsed.fault_message}`);
      }
    }
    return result;
  }

  private async _cleanup(vmId: string): Promise<void> {
    const vm = vmRegistry.get(vmId);
    if (!vm) return;

    // Remove port forwarding rules
    if (vm.desktopPort) await this._removePortForward(vm.desktopPort, vm.vmIP, 6080);
    if (vm.previewPort) await this._removePortForward(vm.previewPort, vm.vmIP, 3000);
    if (vm.chromePort) await this._removePortForward(vm.chromePort, vm.vmIP, 9223);
    for (const [hostPort, guestPort] of vm.extraPorts) {
      await this._removePortForward(hostPort, vm.vmIP, guestPort);
    }

    // Kill VM process
    if (vm.fcProcess?.pid) {
      try { process.kill(-vm.fcProcess.pid, 'SIGKILL'); } catch {}
    }

    try { fs.unlinkSync(vm.socketPath); } catch {}
    try { fs.unlinkSync(vm.rootfsPath); } catch {}

    await NetworkManager.destroyTAP(vmId);

    this._chromeSpawning.delete(vmId);
    this._xclipCache.delete(vmId);
    vmRegistry.delete(vmId);
    console.log(`Firecracker VM ${vmId} destroyed`);
  }
}

export default FirecrackerSandbox;
