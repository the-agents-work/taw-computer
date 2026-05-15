import { exec } from 'child_process';

interface VMNetwork {
  tapName: string;
  vmIP: string;
  gatewayIP: string;
  macAddress: string;
  mask: string;
}

interface AllocatedNet {
  tapName: string;
  vmIP: string;
  macAddress: string;
}

function execPromise(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

const SUBNET = '172.16.0';
const GATEWAY = `${SUBNET}.1`;
const MASK = '/24';
const MASK_LONG = '255.255.255.0';

let nextIP = 2;
const allocatedIPs = new Map<string, AllocatedNet>();

export class NetworkManager {
  static async setupHost(): Promise<void> {
    const hostIface = await NetworkManager.getDefaultInterface();
    const commands = [
      'sysctl -w net.ipv4.ip_forward=1',
      `iptables -t nat -A POSTROUTING -o ${hostIface} -j MASQUERADE`,
      'iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
    ];
    for (const cmd of commands) {
      try {
        await execPromise(`sudo ${cmd}`);
      } catch (e) {
        console.warn(`Network setup warning: ${(e as Error).message}`);
      }
    }
    console.log('Host networking configured for Firecracker VMs');
  }

  static async getDefaultInterface(): Promise<string> {
    try {
      const result = await execPromise("ip route | grep default | awk '{print $5}' | head -1");
      return result || 'eth0';
    } catch {
      return 'eth0';
    }
  }

  static async createTAP(vmId: string): Promise<VMNetwork> {
    const ip = nextIP++;
    const vmIP = `${SUBNET}.${ip}`;
    const tapName = `tap-${vmId.substring(0, 8)}`;
    const macAddress = `02:FC:00:00:00:${ip.toString(16).padStart(2, '0')}`;

    const commands = [
      `ip tuntap add dev ${tapName} mode tap`,
      `ip addr add ${GATEWAY}${MASK} dev ${tapName} 2>/dev/null || true`,
      `ip link set dev ${tapName} up`,
      `iptables -A FORWARD -i ${tapName} -o $(ip route | grep default | awk '{print $5}' | head -1) -j ACCEPT`,
    ];

    for (const cmd of commands) {
      await execPromise(`sudo ${cmd}`);
    }

    allocatedIPs.set(vmId, { tapName, vmIP, macAddress });

    return {
      tapName,
      vmIP,
      gatewayIP: GATEWAY,
      macAddress,
      mask: MASK_LONG,
    };
  }

  static async destroyTAP(vmId: string): Promise<void> {
    const info = allocatedIPs.get(vmId);
    if (!info) return;

    try {
      await execPromise(`sudo ip link del ${info.tapName}`);
    } catch (e) {
      console.warn(`TAP cleanup warning for ${info.tapName}: ${(e as Error).message}`);
    }

    allocatedIPs.delete(vmId);
  }

  static getNetworkBootArgs(vmIP: string, gatewayIP: string, mask: string): string {
    return `ip=${vmIP}::${gatewayIP}:${mask}::eth0:off`;
  }
}
