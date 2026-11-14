import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  TelemetryProbeResult,
  TriageAssessment,
  RemediationPlan,
  SafetyReview,
} from '../schemas.ts';

export interface IncidentScenario {
  id: string;
  name: string;
  description: string;
  severity: 'P1' | 'P2' | 'P3';
  serviceName: string;
  alert: {
    alertId: string;
    source: string;
    timestamp: string;
    summary: string;
    details: string;
  };
  telemetry: TelemetryProbeResult;
  expectedDiagnosis: TriageAssessment;
  remediationPlan: RemediationPlan;
  safetyReview: SafetyReview;
  postRemediationTelemetry: {
    healthCheckStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
    http5xxRatePercent: number;
    p99LatencyMs: number;
    activeDbConnections: number;
    maxDbConnections: number;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadScenario(scenarioIdOrFile: string): IncidentScenario {
  let fileName = scenarioIdOrFile;
  if (!fileName.endsWith('.json')) {
    fileName = `${fileName}.json`;
  }
  const filePath = path.isAbsolute(fileName)
    ? fileName
    : path.resolve(__dirname, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Incident scenario file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as IncidentScenario;
}

export function getAvailableScenarios(): string[] {
  return [
    'p1_db_pool_exhaustion',
    'p1_bad_deploy_regression',
    'p2_high_latency_leak',
  ];
}
