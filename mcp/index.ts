#!/usr/bin/env tsx
/**
 * taw-computer MCP server
 *
 * Exposes a Docker sandbox ("mini computer") as MCP tools so any AI client
 * (Claude Code, Cursor, Claude Desktop, ChatGPT) can drive shell, files,
 * browser, and desktop on demand. No internal LLM, no chat UI.
 *
 * Transport: stdio (JSON-RPC over stdin/stdout).
 */

// Stdio mode: stdout is reserved for the JSON-RPC stream. Redirect console
// to stderr globally before importing anything else.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createSandboxManager } from '../sandbox/index.js';
import type { SandboxManager } from '../sandbox/SandboxManager.js';
import { BrowserController } from './browser.js';

const browser = new BrowserController();

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

// Lazy singleton — sandbox is created on first use, reused across tool calls.
let sandboxPromise: Promise<SandboxManager> | null = null;
const sandboxes = new Map<string, { id: string; createdAt: number; label: string | null }>();

// Cap how many sandboxes can run at once. Each takes ~1-2GB RAM; without
// a cap, an AI that forgets to vm_destroy can leak the host into swap.
const MAX_SANDBOXES = parseInt(process.env.MAX_SANDBOXES || '3', 10);

function getSandbox(): Promise<SandboxManager> {
  if (!sandboxPromise) sandboxPromise = createSandboxManager();
  return sandboxPromise;
}

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

function err(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }], isError: true };
}

/** POSIX single-quote escape — safe for any shell string. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const server = new Server(
  { name: 'taw-computer', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

const tools = [
  {
    name: 'vm_create',
    description:
      'Create a new sandbox (isolated Ubuntu mini-computer with shell, Chrome + CDP, VNC, xfce4). IMPORTANT: Before creating, check if the user has saved snapshots by looking at the `available_snapshots` field in the response. If snapshots exist, ask the user whether they want to resume from a snapshot or start fresh. Set `use_snapshot: true` to resume. Backend is auto-detected: Firecracker microVM if KVM available, Docker otherwise. Returns the sandbox id used by all other tools, plus a noVNC URL the human can open to watch what the AI is doing. IMPORTANT: Always present vnc_url exactly as returned — never modify the URL path, filename, or query parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'A descriptive name for this VM chosen by the user. IMPORTANT: Always ask the user what they want to name their VM before creating it. Do not auto-generate names.',
        },
        use_snapshot: {
          type: 'boolean',
          description: 'Set to true to resume from a previously saved snapshot with the same label. If false or omitted, creates a fresh VM from the base image.',
        },
        profile_dir: {
          type: 'string',
          description:
            'Optional host path to mount as the Chrome profile dir (e.g. ~/.taw-computer/profile). Persists cookies, logged-in Gmail, etc. across containers.',
        },
        extra_ports: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Additional guest ports to expose on the host (e.g. [3000, 8080]). Each gets a unique host port.',
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'vm_list',
    description: 'List active sandboxes created in this MCP session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vm_destroy',
    description: 'Destroy a sandbox and free its ports. By default the VM filesystem is saved as a snapshot so recreating with the same label resumes where you left off. Set save_snapshot to false to destroy without saving (e.g. when the VM contains sensitive data the user does not want persisted). Use vm_reset to also delete any previously saved snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sandbox id from vm_create' },
        save_snapshot: { type: 'boolean', description: 'Whether to save a snapshot before destroying. Defaults to true.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vm_reset',
    description: 'Reset a VM to a clean state. Destroys the current VM AND deletes its saved snapshot, so the next vm_create with the same label starts fresh from the base image.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Sandbox id to reset' } },
      required: ['id'],
    },
  },
  {
    name: 'vm_restart',
    description: 'Restart a sandbox. Stops and starts the container — all files, databases, and installed packages are preserved. Only processes are restarted.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Sandbox id to restart' } },
      required: ['id'],
    },
  },
  {
    name: 'vm_status',
    description:
      'Get resource usage (CPU, memory, disk, uptime, top processes) and port mappings for a sandbox. Use to diagnose OOM, high CPU, or check available disk space.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Sandbox id' } },
      required: ['id'],
    },
  },
  {
    name: 'vm_rename',
    description: 'Rename a running VM by changing its label. The label is used for snapshot naming — renaming does NOT migrate existing snapshots (they stay under the old label).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sandbox id' },
        label: { type: 'string', description: 'New label for the VM' },
      },
      required: ['id', 'label'],
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot_list',
    description: 'List all saved snapshots. Each snapshot can be resumed by calling vm_create with the same label and use_snapshot=true.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snapshot_delete',
    description: 'Delete a saved snapshot by label. This frees disk space and means the next vm_create with this label will start fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Snapshot label to delete' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'exec',
    description:
      'Run a shell command inside the sandbox. Returns combined stdout+stderr. Use for any CLI work: git, npm, pip, apt, curl, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sandbox id' },
        command: { type: 'string', description: 'Shell command to run (executed via bash -c)' },
      },
      required: ['id', 'command'],
    },
  },
  {
    name: 'fs_write',
    description: 'Write content to a file inside the sandbox (creates parent dirs as needed).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        path: { type: 'string', description: 'Absolute path inside the sandbox' },
        content: { type: 'string' },
      },
      required: ['id', 'path', 'content'],
    },
  },
  {
    name: 'fs_read',
    description: 'Read a file inside the sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        path: { type: 'string', description: 'Absolute path inside the sandbox' },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'fs_edit',
    description: 'Replace a string in a file. Fails if old_string is not found. Set replace_all=true to replace every occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences (default: first only)' },
      },
      required: ['id', 'path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'fs_list',
    description: 'List files in a directory (ls -la, or recursive find with depth 3).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        path: { type: 'string', description: 'Directory path' },
        recursive: { type: 'boolean', default: false },
      },
      required: ['id', 'path'],
    },
  },
  {
    name: 'fs_search',
    description: 'grep -rn for a pattern in a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        pattern: { type: 'string' },
        path: { type: 'string', default: '/workspace' },
        file_pattern: { type: 'string', description: 'e.g. *.ts' },
      },
      required: ['id', 'pattern'],
    },
  },
  {
    name: 'code_search',
    description:
      'Search codebase content using ripgrep. Much faster and smarter than fs_search — supports regex, file type filters, context lines, and higher result limits.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        pattern: { type: 'string', description: 'Search pattern (regex supported).' },
        path: { type: 'string', default: '/workspace', description: 'Directory to search in' },
        file_type: { type: 'string', description: 'File type filter: ts, tsx, js, py, rust, go, css, html, json, yaml, etc.' },
        glob: { type: 'string', description: 'Glob pattern to filter files. E.g. "*.test.ts", "src/**/*.tsx"' },
        context: { type: 'number', default: 0, description: 'Lines of context before and after each match (0-5)' },
        max_results: { type: 'number', default: 50, description: 'Max result lines (default 50, max 200)' },
        ignore_case: { type: 'boolean', default: false, description: 'Case-insensitive search' },
        word: { type: 'boolean', default: false, description: 'Match whole words only' },
        files_only: { type: 'boolean', default: false, description: 'Only list matching file paths, not content' },
      },
      required: ['id', 'pattern'],
    },
  },
  {
    name: 'desktop_screenshot',
    description: 'Take a JPEG screenshot of the sandbox desktop (xfce4) and return as image content.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        quality: { type: 'number', default: 75, description: 'JPEG quality 1-100 (default 75).' },
        max_width: { type: 'number', default: 1024, description: 'Max width in pixels (default 1024).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'desktop_click',
    description: 'Click at (x,y) on the sandbox desktop. button=1 left, 2 middle, 3 right.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'number', default: 1 },
      },
      required: ['id', 'x', 'y'],
    },
  },
  {
    name: 'desktop_type',
    description: 'Type text into the focused window via xdotool.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'desktop_key',
    description: 'Press a key combo via xdotool, e.g. "Return", "ctrl+l", "alt+Tab".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['id', 'key'],
    },
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll at (x,y).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
        amount: { type: 'number', default: 3 },
      },
      required: ['id', 'x', 'y'],
    },
  },
  {
    name: 'desktop_drag',
    description: 'Drag from (from_x, from_y) to (to_x, to_y) on the sandbox desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        from_x: { type: 'number' },
        from_y: { type: 'number' },
        to_x: { type: 'number' },
        to_y: { type: 'number' },
        button: { type: 'number', default: 1 },
        hold_ms: { type: 'number', default: 150 },
      },
      required: ['id', 'from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open Chrome inside the sandbox (or navigate the existing tab) at the given URL, then return a JPEG screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_close',
    description: 'Kill all Chrome processes inside the sandbox.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the sandbox Chrome to a URL via CDP (Playwright). Returns final URL and page title.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['id', 'url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Inject numbered overlays on every visible interactive element (Set-of-Mark prompting), screenshot the page, return both the screenshot and element refs. Use browser_click_ref / browser_type_ref to interact.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        quality: { type: 'number', default: 75 },
        max_width: { type: 'number', default: 1024 },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_click_ref',
    description: 'Click an element by its ref number from the most recent browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ref: { type: 'number' },
      },
      required: ['id', 'ref'],
    },
  },
  {
    name: 'browser_type_ref',
    description: 'Focus an element by ref and type text into it. Set submit=true to press Enter after.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ref: { type: 'number' },
        text: { type: 'string' },
        submit: { type: 'boolean', default: false },
      },
      required: ['id', 'ref', 'text'],
    },
  },
  {
    name: 'browser_extract',
    description: 'Read text content from the page. With selector: returns innerText of matching elements. Without: full page text.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        selector: { type: 'string', description: 'CSS selector. Omit for whole-page text.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_eval',
    description: 'Run a JavaScript expression in the page context and return the result.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expression: { type: 'string' },
      },
      required: ['id', 'expression'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until a condition holds (selector visible, text appears, or network idle).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        networkidle: { type: 'boolean' },
        timeout_ms: { type: 'number', default: 15000 },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_console_logs',
    description: 'Return captured browser console logs (errors, warnings, info) from the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        level: { type: 'string', description: 'Filter by level: error, warning, info, log, etc.' },
        clear: { type: 'boolean', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_network_errors',
    description: 'Return captured network request failures (404s, CORS errors, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        clear: { type: 'boolean', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'browser_run_test',
    description: 'Run a Playwright test script against the browser inside a VM. Has `page`, `browser`, `context`, and `chromium` available.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        script: { type: 'string', description: 'Playwright script body (async context)' },
        timeout_ms: { type: 'number', default: 120000 },
      },
      required: ['id', 'script'],
    },
  },
  {
    name: 'web_search',
    description: 'Search Google and return up to 8 organic results as {title, url, snippet}.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['id', 'query'],
    },
  },
  {
    name: 'file_upload',
    description: 'Upload a file into a VM. Pass content as base64 string (max 50MB).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        path: { type: 'string', description: 'Destination path inside VM' },
        content_base64: { type: 'string', description: 'File content encoded as base64' },
      },
      required: ['id', 'path', 'content_base64'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

async function handleToolCall(req: { params: { name: string; arguments?: Record<string, unknown> } }) {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const sb = await getSandbox();

  try {
    switch (name) {
      case 'vm_create': {
        if (sandboxes.size >= MAX_SANDBOXES) {
          return err(
            `Already at the sandbox cap (${sandboxes.size}/${MAX_SANDBOXES}). ` +
              `Call vm_destroy on one you no longer need, or raise the cap with the ` +
              `MAX_SANDBOXES env var on the MCP server.`,
          );
        }
        const label = (args.label as string) || null;
        let snapshotImage: string | undefined;
        if (args.use_snapshot && label && sb.findSnapshot) {
          snapshotImage = await sb.findSnapshot(label) ?? undefined;
        }
        const availableSnapshots = sb.listAllSnapshots ? await sb.listAllSnapshots() : [];
        const id = await sb.create({
          profileDir: args.profile_dir as string | undefined,
          extraPorts: args.extra_ports as number[] | undefined,
          image: snapshotImage,
        });
        if (!id) return err('Failed to create sandbox. Is Docker/Firecracker running?');
        sandboxes.set(id, { id, createdAt: Date.now(), label });
        // Get the container IP to build VNC URL
        const ip = await sb.getContainerIP?.(id);
        const vncUrl = ip ? `http://${ip}:6080/vnc_lite.html?autoconnect=true&resize=scale` : null;
        return text(
          JSON.stringify(
            {
              id,
              type: sb.getType(),
              vnc_url: vncUrl,
              persistent_profile: !!args.profile_dir,
              restored_from_snapshot: !!snapshotImage,
              available_snapshots: availableSnapshots.length ? availableSnapshots : undefined,
              note: `Sandbox created.${vncUrl ? ' Open vnc_url in a browser to watch what the AI is doing.' : ''}${snapshotImage ? ' VM restored from snapshot.' : ''}`,
            },
            null,
            2,
          ),
        );
      }
      case 'vm_list': {
        const list = [...sandboxes.values()].map(s => ({
          id: s.id,
          label: s.label,
          createdAt: s.createdAt,
        }));
        return text(JSON.stringify(list, null, 2));
      }
      case 'vm_destroy': {
        const id = args.id as string;
        const entry = sandboxes.get(id);
        const saveSnapshot = args.save_snapshot !== false;
        let snapshotSaved = false;
        if (saveSnapshot && entry?.label && sb.commitSnapshot) {
          snapshotSaved = await sb.commitSnapshot(id, 0, entry.label).catch(e => {
            console.error('Snapshot failed (continuing destroy):', e);
            return false;
          });
        }
        await browser.detach(id).catch(() => {});
        await sb.destroy(id);
        sandboxes.delete(id);
        if (snapshotSaved) {
          return text(`destroyed ${id} (snapshot saved — recreate with same label to resume)`);
        }
        return text(`destroyed ${id}${!saveSnapshot ? ' (no snapshot saved)' : ''}`);
      }
      case 'vm_reset': {
        const id = args.id as string;
        const entry = sandboxes.get(id);
        if (entry?.label && sb.deleteSnapshot) {
          await sb.deleteSnapshot(0, entry.label);
        }
        await browser.detach(id).catch(() => {});
        await sb.destroy(id);
        sandboxes.delete(id);
        return text(`reset ${id} — snapshot deleted, next create with same label starts fresh`);
      }
      case 'vm_restart': {
        const id = args.id as string;
        await browser.detach(id).catch(() => {});
        const { exec: execCb } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          execCb(`docker restart ${id}`, { timeout: 30000 }, (e: Error | null) => e ? reject(e) : resolve());
        });
        await sb.setupDesktop?.(id);
        return text(`restarted ${id} — all files and data preserved, processes restarted`);
      }
      case 'vm_status': {
        const id = args.id as string;
        const status = await sb.getVMStatus?.(id);
        if (!status) return err(`vm_status not available for sandbox ${id}`);
        return text(JSON.stringify(status, null, 2));
      }
      case 'vm_rename': {
        const id = args.id as string;
        const newLabel = args.label as string;
        const entry = sandboxes.get(id);
        if (!entry) return err(`VM ${id} not found`);
        const oldLabel = entry.label;
        entry.label = newLabel;
        sandboxes.set(id, entry);
        return text(`renamed ${id}: "${oldLabel || '(none)'}" → "${newLabel}"`);
      }
      case 'snapshot_list': {
        const snapshots = sb.listAllSnapshots ? await sb.listAllSnapshots() : [];
        if (!snapshots.length) return text('No saved snapshots.');
        return text(`Saved snapshots:\n${snapshots.map(s => `  • ${s}`).join('\n')}`);
      }
      case 'snapshot_delete': {
        const label = args.label as string;
        if (!sb.deleteSnapshot) return err('Snapshots not supported by this sandbox backend');
        const imageName = sb.findSnapshot ? await sb.findSnapshot(label) : null;
        if (!imageName) return err(`No snapshot found with label "${label}"`);
        const m = imageName.match(/^taw-snapshot-(\d+)-/);
        if (m) await sb.deleteSnapshot(parseInt(m[1]), label);
        return text(`Snapshot "${label}" deleted.`);
      }
      case 'exec': {
        return text(await sb.exec(args.id as string, args.command as string));
      }
      case 'fs_write': {
        return text(
          await sb.writeFile(args.id as string, args.path as string, args.content as string),
        );
      }
      case 'fs_read': {
        return text(
          await sb.exec(args.id as string, `cat ${JSON.stringify(args.path as string)}`),
        );
      }
      case 'fs_edit': {
        return text(
          await sb.editFile(
            args.id as string,
            args.path as string,
            args.old_string as string,
            args.new_string as string,
            (args.replace_all as boolean) ?? false,
          ),
        );
      }
      case 'fs_list': {
        return text(
          await sb.listFiles(
            args.id as string,
            args.path as string,
            (args.recursive as boolean) ?? false,
          ),
        );
      }
      case 'fs_search': {
        return text(
          await sb.search(
            args.id as string,
            args.pattern as string,
            (args.path as string) ?? '/workspace',
            (args.file_pattern as string) ?? '',
          ),
        );
      }
      case 'code_search': {
        const id = args.id as string;
        const pattern = args.pattern as string;
        const searchPath = (args.path as string) || '/workspace';
        const maxResults = Math.min((args.max_results as number) || 50, 200);
        const ctx = Math.min(Math.max((args.context as number) || 0, 0), 5);
        const flags: string[] = ['-n', '--color=never', '--no-heading'];
        if (args.ignore_case) flags.push('-i');
        if (args.word) flags.push('-w');
        if (args.files_only) flags.push('-l');
        if (args.file_type) flags.push(`-t ${args.file_type as string}`);
        if (args.glob) flags.push(`-g ${JSON.stringify(args.glob as string)}`);
        if (ctx > 0) flags.push(`-C ${ctx}`);
        const cmd = `(command -v rg > /dev/null && rg ${flags.join(' ')} ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null || grep -rn ${args.ignore_case ? '-i' : ''} ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null) | head -${maxResults}`;
        const result = await sb.exec(id, cmd);
        if (!result.trim()) return text('No matches found.');
        return text(result);
      }
      case 'desktop_screenshot': {
        const quality = (args.quality as number) ?? 75;
        const maxWidth = (args.max_width as number) ?? 1024;
        const b64 = await sb.takeScreenshotWithOpts?.(args.id as string, quality, maxWidth)
          ?? await sb.takeScreenshot?.(args.id as string);
        if (!b64) return err('Screenshot failed (is the desktop running?)');
        return { content: [{ type: 'image', data: b64, mimeType: 'image/jpeg' }] };
      }
      case 'desktop_click':
      case 'desktop_type':
      case 'desktop_key':
      case 'desktop_scroll':
      case 'desktop_drag': {
        const op = name.replace(/^desktop_/, '');
        const id = args.id as string;
        const status = (await sb.desktopAction?.(id, op, args)) ?? 'ok';
        const settleMs =
          op === 'type' && typeof args.text === 'string'
            ? Math.min(800, 250 + (args.text as string).length * 6)
            : op === 'drag'
              ? 400
              : 250;
        await new Promise((r) => setTimeout(r, settleMs));
        const b64 = await sb.takeScreenshot?.(id);
        const summary = String(status).split('\n')[0].slice(0, 200) || 'ok';
        if (!b64) return text(summary);
        return {
          content: [
            { type: 'text', text: summary },
            { type: 'image', data: b64, mimeType: 'image/jpeg' },
          ],
        };
      }
      case 'browser_open': {
        const out = await sb.desktopAction?.(args.id as string, 'open_browser', {
          url: args.url,
        });
        if (out && out.startsWith('data:image/jpeg;base64,')) {
          return {
            content: [
              { type: 'image', data: out.slice('data:image/jpeg;base64,'.length), mimeType: 'image/jpeg' },
            ],
          };
        }
        return text(out ?? 'no response');
      }
      case 'browser_close': {
        const id = args.id as string;
        await browser.detach(id).catch(() => {});
        const out = await sb.desktopAction?.(id, 'close_browser', {});
        return text(out ?? 'no response');
      }
      case 'browser_navigate': {
        const id = args.id as string;
        const port = await getCdp(sb, id, args.url as string);
        const r = await browser.navigate(id, port, args.url as string);
        return text(JSON.stringify(r));
      }
      case 'browser_snapshot': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const snap = await browser.snapshot(id, port);
        const meta = JSON.stringify(
          { url: snap.url, title: snap.title, elements: snap.elements },
          null,
          2,
        );
        return {
          content: [
            { type: 'text', text: meta },
            { type: 'image', data: snap.screenshot, mimeType: 'image/jpeg' },
          ],
        };
      }
      case 'browser_click_ref': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const clickResult = await browser.clickRef(id, port, args.ref as number);
        await new Promise((r) => setTimeout(r, 300));
        try {
          const snap = await browser.snapshot(id, port);
          const meta = JSON.stringify(
            { url: snap.url, title: snap.title, elements: snap.elements, click_result: clickResult },
            null, 2,
          );
          return {
            content: [
              { type: 'text', text: meta },
              { type: 'image', data: snap.screenshot, mimeType: 'image/jpeg' },
            ],
          };
        } catch {
          return text(clickResult);
        }
      }
      case 'browser_type_ref': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const typeResult = await browser.typeRef(
          id,
          port,
          args.ref as number,
          args.text as string,
          (args.submit as boolean) ?? false,
        );
        const settleMs = (args.submit as boolean) ? 800 : 300;
        await new Promise((r) => setTimeout(r, settleMs));
        try {
          const snap = await browser.snapshot(id, port);
          const meta = JSON.stringify(
            { url: snap.url, title: snap.title, elements: snap.elements, type_result: typeResult },
            null, 2,
          );
          return {
            content: [
              { type: 'text', text: meta },
              { type: 'image', data: snap.screenshot, mimeType: 'image/jpeg' },
            ],
          };
        } catch {
          return text(typeResult);
        }
      }
      case 'browser_extract': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        return text(await browser.extract(id, port, args.selector as string | undefined));
      }
      case 'browser_eval': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const v = await browser.evaluate(id, port, args.expression as string);
        return text(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      }
      case 'browser_wait_for': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        return text(
          await browser.waitFor(id, port, {
            selector: args.selector as string | undefined,
            text: args.text as string | undefined,
            networkidle: args.networkidle as boolean | undefined,
            timeout: args.timeout_ms as number | undefined,
          }),
        );
      }
      case 'browser_console_logs': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const logs = await browser.consoleLogs(id, port, {
          level: args.level as string | undefined,
          clear: args.clear as boolean | undefined,
        });
        if (logs.length === 0) return text('No console logs captured.');
        return text(JSON.stringify(logs, null, 2));
      }
      case 'browser_network_errors': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const errors = await browser.networkErrors(id, port, {
          clear: args.clear as boolean | undefined,
        });
        if (errors.length === 0) return text('No network errors captured.');
        return text(JSON.stringify(errors, null, 2));
      }
      case 'browser_run_test': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const result = await browser.runTest(id, port, args.script as string, {
          timeout: args.timeout_ms as number | undefined,
        });
        return text(JSON.stringify(result, null, 2));
      }
      case 'web_search': {
        const id = args.id as string;
        const port = await getCdp(sb, id);
        const results = await browser.webSearch(id, port, args.query as string);
        return text(JSON.stringify(results, null, 2));
      }
      case 'file_upload': {
        const id = args.id as string;
        const destPath = args.path as string;
        const b64 = args.content_base64 as string;
        if (!b64) return err('content_base64 is required');
        const buf = Buffer.from(b64, 'base64');
        const sizeMB = buf.length / 1024 / 1024;
        if (sizeMB > 50) return err(`File too large (${sizeMB.toFixed(1)}MB). Max 50MB.`);
        const tmpPath = `/tmp/taw-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { writeFileSync, unlinkSync } = await import('fs');
        try {
          writeFileSync(tmpPath, buf);
          const result = await sb.copyToSandbox(id, tmpPath, destPath);
          return text(`Uploaded ${sizeMB.toFixed(1)}MB to ${destPath}\n${result}`);
        } finally {
          try { unlinkSync(tmpPath); } catch {}
        }
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(`Error in ${name}: ${(e as Error).message}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, handleToolCall);

async function getCdp(sb: SandboxManager, id: string, url?: string): Promise<string> {
  const ip = await sb.getContainerIP?.(id);
  if (!ip) throw new Error(`sandbox ${id} has no container IP — is the container running?`);
  await sb.ensureChrome?.(id, url);
  return ip;
}

// Graceful shutdown
async function shutdown() {
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('taw-computer MCP server running on stdio');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
