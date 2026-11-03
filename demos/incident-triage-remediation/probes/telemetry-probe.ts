import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelemetryProbeResultSchema } from '../schemas.ts';
import type { TelemetryProbeResult } from '../schemas.ts';
import { analyzeGitHistory } from './git-probe.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TelemetryProbeOptions {
  scenarioName?: string;
  scenarioPath?: string;
  serviceUrl?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface RawTelemetryData {
  serviceName: string;
  http5xxRatePercent: number;
  p99LatencyMs: number;
  activeDbConnections: number;
  maxDbConnections: number;
  recentLogErrors: string[];
  recentCommits?: Array<{
    hash: string;
    author: string;
    message: string;
    timestamp: string;
    filesChanged: string[];
    diff?: string;
  }>;
  cpuUsagePercent?: number;
  memoryUsagePercent?: number;
  cpuUtilizationPercent?: number;
  memoryUtilizationPercent?: number;
}

/**
 * Deterministically derives health status from metric thresholds
 */
export function deriveHealthStatus(
  http5xxRatePercent: number,
  p99LatencyMs: number,
  activeDbConnections: number,
  maxDbConnections: number
): 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' {
  const poolSaturationRatio = maxDbConnections > 0 ? activeDbConnections / maxDbConnections : 0;

  if (http5xxRatePercent >= 5.0 || poolSaturationRatio >= 0.98 || p99LatencyMs >= 2000) {
    return 'UNHEALTHY';
  }
  if (http5xxRatePercent >= 1.0 || poolSaturationRatio >= 0.8 || p99LatencyMs >= 1000) {
    return 'DEGRADED';
  }
  return 'HEALTHY';
}

/**
 * Collects deterministic telemetry metrics and error logs from scenario fixtures or telemetry endpoints.
 */
export async function collectTelemetry(options: TelemetryProbeOptions = {}): Promise<TelemetryProbeResult> {
  const cwd = options.cwd ?? process.cwd();
  const scenarioName = options.scenarioName ?? process.env.SCENARIO ?? 'p1_db_pool_exhaustion';
  
  let rawData: RawTelemetryData | null = null;

  // 1. Attempt live HTTP probe if serviceUrl is provided
  if (options.serviceUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 500);
      const res = await fetch(`${options.serviceUrl}/metrics`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        rawData = (await res.json()) as RawTelemetryData;
      }
    } catch {
      // Graceful fallback to fixture mode
      rawData = null;
    }
  }

  // 2. Load scenario fixture if not retrieved via HTTP
  if (!rawData) {
    const fixtureCandidates = [
      options.scenarioPath,
      path.join(cwd, 'demos', 'incident-triage-remediation', 'scenarios', `${scenarioName}.json`),
      path.join(__dirname, '..', 'scenarios', `${scenarioName}.json`),
      path.join(cwd, 'scenarios', `${scenarioName}.json`),
    ].filter(Boolean) as string[];

    let fixtureFile: string | undefined;
    for (const candidate of fixtureCandidates) {
      if (fs.existsSync(candidate)) {
        fixtureFile = candidate;
        break;
      }
    }

    if (fixtureFile) {
      const content = fs.readFileSync(fixtureFile, 'utf-8');
      const parsed = JSON.parse(content);
      rawData = parsed.telemetry ?? parsed;
    } else {
      // Deterministic emergency default if file missing
      rawData = {
        serviceName: 'order-checkout-api',
        http5xxRatePercent: 38.5,
        p99LatencyMs: 4850,
        activeDbConnections: 100,
        maxDbConnections: 100,
        cpuUtilizationPercent: 46.2,
        memoryUtilizationPercent: 61.8,
        recentLogErrors: [
          '[ERROR] TimeoutError: ResourceRequest timed out after 5000ms. Available: 0, Allocated: 100, Pending: 412',
          '[ERROR] 500 Internal Server Error: POST /api/v1/checkout - Failed to obtain db connection',
          '[WARN] Service degraded: Database ping timed out after 3000ms',
        ],
      };
    }
  }

  // 3. Extract and combine git history
  const recentCommits = rawData && rawData.recentCommits && rawData.recentCommits.length > 0
    ? rawData.recentCommits
    : await analyzeGitHistory({ cwd, maxCommits: 5 });

  // 4. Derive deterministic health check status
  const healthCheckStatus = deriveHealthStatus(
    rawData.http5xxRatePercent,
    rawData.p99LatencyMs,
    rawData.activeDbConnections,
    rawData.maxDbConnections
  );

  const result: TelemetryProbeResult = {
    serviceName: rawData.serviceName || 'order-checkout-api',
    healthCheckStatus,
    http5xxRatePercent: rawData.http5xxRatePercent,
    p99LatencyMs: rawData.p99LatencyMs,
    activeDbConnections: rawData.activeDbConnections,
    maxDbConnections: rawData.maxDbConnections,
    cpuUsagePercent: rawData.cpuUsagePercent ?? rawData.cpuUtilizationPercent,
    memoryUsagePercent: rawData.memoryUsagePercent ?? rawData.memoryUtilizationPercent,
    cpuUtilizationPercent: rawData.cpuUtilizationPercent ?? rawData.cpuUsagePercent,
    memoryUtilizationPercent: rawData.memoryUtilizationPercent ?? rawData.memoryUsagePercent,
    recentCommits,
    recentLogErrors: rawData.recentLogErrors || [],
    timestamp: new Date().toISOString(),
  };

  // 5. Strict schema validation
  return TelemetryProbeResultSchema.parse(result);
}
