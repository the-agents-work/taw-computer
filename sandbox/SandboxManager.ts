export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size: number;
}

export interface PTYSpawnArgs {
  command: string;
  args: string[];
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  };
}

export type SandboxType = 'docker' | 'firecracker';

export interface CreateOptions {
  /** Host path to mount as the Chrome profile dir. Persists cookies/login
   *  across container lifecycles. If omitted, profile is ephemeral. */
  profileDir?: string;
  /** Additional guest ports to map to the host (e.g. [3000, 8080]). */
  extraPorts?: number[];
  /** Override the Docker image (e.g. a snapshot image from a previous session). */
  image?: string;
}

export abstract class SandboxManager {
  abstract create(opts?: CreateOptions): Promise<string | null>;
  abstract getContainerIP(sandboxId: string): Promise<string | null>;
  abstract copyToSandbox(sandboxId: string, hostPath: string, containerPath: string): Promise<string>;
  abstract copyFromSandbox(sandboxId: string, containerPath: string, hostPath: string): Promise<string>;
  abstract destroy(sandboxId: string): Promise<void>;
  abstract exec(sandboxId: string | null, command: string): Promise<string>;
  abstract writeFile(sandboxId: string | null, filePath: string, content: string): Promise<string>;
  abstract listFiles(sandboxId: string | null, directory: string, recursive?: boolean): Promise<string>;
  abstract editFile(sandboxId: string | null, filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<string>;
  abstract search(sandboxId: string | null, pattern: string, directory?: string, filePattern?: string): Promise<string>;
  abstract getFileList(sandboxId: string | null, dirPath: string): Promise<FileEntry[]>;
  abstract getPTYSpawnArgs(sandboxId: string | null): PTYSpawnArgs;
  abstract getType(): SandboxType;
  abstract isAvailable(): Promise<boolean>;

  ensureChrome?(sandboxId: string, url?: string): Promise<void>;
  desktopAction?(sandboxId: string | null, op: string, params: Record<string, unknown>): Promise<string>;
  takeScreenshot?(sandboxId: string): Promise<string | null>;
  takeScreenshotWithOpts?(sandboxId: string, quality: number, maxWidth: number): Promise<string | null>;
  getVMStatus?(sandboxId: string): Promise<Record<string, unknown> | null>;
  setupDesktop?(sandboxId: string): Promise<void>;
  commitSnapshot?(sandboxId: string, userId: number, label: string): Promise<boolean>;
  snapshotExists?(userId: number, label: string): Promise<boolean>;
  deleteSnapshot?(userId: number, label: string): Promise<void>;
  listSnapshots?(userId: number): Promise<string[]>;
  findSnapshot?(label: string): Promise<string | null>;
  listAllSnapshots?(): Promise<string[]>;
}
