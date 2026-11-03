import os from 'node:os';
import { SystemProbe } from '../types.js';

export function probeSystem(): SystemProbe {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: cpus.length,
    cpuModel: cpus[0]?.model ?? 'Unknown CPU',
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
    uptimeSeconds: Math.round(os.uptime()),
    hostname: os.hostname(),
    nodeVersion: process.version,
  };
}
