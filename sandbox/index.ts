import { DockerSandbox } from './DockerSandbox';
import { FirecrackerSandbox } from './FirecrackerSandbox';
import config from './config';
import type { SandboxManager } from './SandboxManager';

export async function createSandboxManager(): Promise<SandboxManager> {
  const requestedType = config.type;

  if (requestedType === 'firecracker') {
    const fc = new FirecrackerSandbox();
    if (await fc.isAvailable()) {
      console.log('Sandbox: Using Firecracker microVM');
      return fc;
    }
    console.warn('Sandbox: Firecracker requested but not available, falling back to Docker');
  }

  if (requestedType === 'docker') {
    console.log('Sandbox: Using Docker container');
    return new DockerSandbox();
  }

  if (requestedType === 'auto') {
    const fc = new FirecrackerSandbox();
    if (await fc.isAvailable()) {
      console.log('Sandbox: Auto-detected Firecracker microVM (KVM available)');
      return fc;
    }

    const docker = new DockerSandbox();
    if (await docker.isAvailable()) {
      console.log('Sandbox: Auto-detected Docker (KVM not available, using Docker fallback)');
      return docker;
    }

    console.log('Sandbox: No container runtime available, using Docker sandbox (will fall back to local shell)');
    return docker;
  }

  return new DockerSandbox();
}

export { DockerSandbox, FirecrackerSandbox };
export type { SandboxManager } from './SandboxManager';
