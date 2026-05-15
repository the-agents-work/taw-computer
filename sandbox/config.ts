import path from 'path';

export interface FirecrackerConfig {
  binaryPath: string;
  kernelPath: string;
  rootfsPath: string;
  socketDir: string;
  vcpuCount: number;
  memSizeMib: number;
  sshUser: string;
  sshKeyPath: string;
  sshPubKeyPath: string;
  bootArgs: string;
}

export interface DockerConfig {
  image: string;
  workDir: string;
  installPackages: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  shmSize: string;
}

export interface DesktopConfig {
  enabled: boolean;
  vncPort: number;
  websockifyPort: number;
  resolution: string;
  colorDepth: number;
  portRangeStart: number;
  portRangeEnd: number;
}

export interface SandboxConfig {
  type: 'auto' | 'firecracker' | 'docker';
  firecracker: FirecrackerConfig;
  docker: DockerConfig;
  desktop: DesktopConfig;
  workDir: string;
  sshTimeout: number;
  execTimeout: number;
}

const SANDBOX_CONFIG: SandboxConfig = {
  type: (process.env.SANDBOX_TYPE as SandboxConfig['type']) || 'auto',
  firecracker: {
    binaryPath: process.env.FC_BINARY || '/usr/local/bin/firecracker',
    kernelPath: process.env.FC_KERNEL || path.join(process.cwd(), 'images', 'vmlinux'),
    rootfsPath: process.env.FC_ROOTFS || path.join(process.cwd(), 'images', 'rootfs.ext4'),
    socketDir: process.env.FC_SOCKET_DIR || '/tmp/firecracker',
    vcpuCount: parseInt(process.env.FC_VCPU || '2', 10),
    memSizeMib: parseInt(process.env.FC_MEM || '512', 10),
    sshUser: process.env.FC_SSH_USER || 'root',
    sshKeyPath: process.env.FC_SSH_KEY || path.join(process.cwd(), 'images', 'id_rsa'),
    sshPubKeyPath: process.env.FC_SSH_PUB_KEY || path.join(process.cwd(), 'images', 'id_rsa.pub'),
    bootArgs: 'console=ttyS0 reboot=k panic=1 pci=off',
  },
  docker: {
    image: process.env.DOCKER_IMAGE || 'taw-computer-base',
    workDir: '/workspace',
    installPackages: 'curl git python3 python3-pip build-essential nano vim wget',
    // Bumped from 2048 → 4096 because Chromium + xfce + Xvfb together easily
    // breach 2GB during heavy SPA navigation (we observed renderer crashes).
    memoryMb: parseInt(process.env.DOCKER_MEMORY_MB || '4096', 10),
    cpus: parseFloat(process.env.DOCKER_CPUS || '2'),
    pidsLimit: parseInt(process.env.DOCKER_PIDS_LIMIT || '512', 10),
    // Docker default /dev/shm is 64MB which is too small for Chromium's
    // shared GPU/IPC buffers — we still pass --disable-dev-shm-usage as
    // a belt-and-braces fix, but giving it 2GB removes the OOM ceiling.
    shmSize: process.env.DOCKER_SHM_SIZE || '2g',
  },
  desktop: {
    enabled: process.env.DESKTOP_ENABLED !== 'false',
    vncPort: parseInt(process.env.VNC_PORT || '5900', 10),
    websockifyPort: parseInt(process.env.WEBSOCKIFY_PORT || '6080', 10),
    resolution: process.env.DESKTOP_RESOLUTION || '1280x720',
    colorDepth: parseInt(process.env.DESKTOP_DEPTH || '24', 10),
    portRangeStart: parseInt(process.env.VNC_PORT_RANGE_START || '6100', 10),
    portRangeEnd: parseInt(process.env.VNC_PORT_RANGE_END || '6200', 10),
  },
  workDir: '/workspace',
  sshTimeout: 30000,
  execTimeout: 120000,
};

export default SANDBOX_CONFIG;
