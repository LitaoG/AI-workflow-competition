import { LLMProvider, LLMRequest, LLMResponse } from '../types.js';

export class MockProvider implements LLMProvider {
  readonly id = 'mock';
  readonly name = 'Deterministic Offline Mock Provider (<4s)';

  checkHealth(): { ok: boolean; detail: string } {
    return { ok: true, detail: 'built-in deterministic mock — always available, offline, 0 tokens' };
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    if (request.signal?.aborted) {
      throw this.abortError();
    }
    const lastUserMessage = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // Actor-name routing: the system prompt names the agent ("You are specialized
    // agent \"safety-reviewer\""), and role identity is immune to the embedded
    // typed-result JSON in user prompts (whose field names poison keyword matching).
    const systemMessage = request.messages.find((m) => m.role === 'system')?.content ?? '';

    let content = '{}';

    // 0. Actor-identity routing (most specific wins; immune to embedded data)
    if (/postmortem|post-mortem/i.test(systemMessage)) {
      content = this.postMortemJson();
    } else if (/safety|reviewer|auditor/i.test(systemMessage)) {
      content = this.safetyJson();
    } else if (/planner/i.test(systemMessage)) {
      content = this.planJson();
    } else if (/decision/i.test(systemMessage)) {
      content = this.decisionJson();
    } else if (/analyst|assess/i.test(systemMessage)) {
      content = this.verdictJson();
    } else if (/triage/i.test(systemMessage)) {
      content = this.triageJson();
    }
    // 1. Safety Reviewer user-message pattern — checked FIRST: triage-result JSON
    //    embedded in a safety prompt contains "P1"/"incident", which would wrongly
    //    match the triage pattern.
    else if (/safety|review|audit|blast/i.test(lastUserMessage)) {
      content = this.safetyJson();
    }
    // 2. Post-mortem synthesizer — also before triage: its prompt embeds the incident data.
    else if (/post-mortem|postmortem/i.test(lastUserMessage)) {
      content = this.postMortemJson();
    }
    // 3. Remediation planner — also before triage for the same reason.
    else if (/remediation plan|runbook/i.test(lastUserMessage)) {
      content = this.planJson();
    }
    // 4. Incident Triage pattern
    else if (/triage|incident|telemetry|p1|healthz/i.test(lastUserMessage)) {
      content = this.triageJson();
    }
    // 5. Demo 2: AWS SDK v2->v3 Migration pattern
    else if (/migration|sdk|aws-sdk|transform/i.test(lastUserMessage)) {
      content = JSON.stringify({
        file: 'src/services/s3.ts',
        originalPackage: 'aws-sdk',
        targetPackage: '@aws-sdk/client-s3',
        transformedCode:
          'import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";\nconst s3 = new S3Client({ region: "us-east-1" });',
        breakingChangesResolved: ['new AWS.S3() -> new S3Client()', 's3.getObject() -> s3.send(new GetObjectCommand())'],
        status: 'SUCCESS',
      });
    }
    // 6. Basic inspection report template pattern
    else if (/inspect|health.*report|healthstatus/i.test(lastUserMessage)) {
      content = JSON.stringify({
        healthStatus: 'HEALTHY',
        scannedFiles: 42,
        summary: 'Environment verified. All runtimes and toolchains conform to requirements.',
        recommendations: ['Enable TypeScript strict mode', 'Verify git working tree status'],
      });
    }
    // 7. Default fallback: generic valid object
    else {
      content = JSON.stringify({
        status: 'SUCCESS',
        message: 'Mock deterministic response completed',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      content,
      model: 'mock-claude-3-5-sonnet',
      usage: {
        promptTokens: 42,
        completionTokens: 88,
        totalTokens: 130,
      },
      latencyMs: Date.now() - startTime,
    };
  }

  private abortError(): Error {
    const e = new Error('ask cancelled');
    e.name = 'AbortError';
    return e;
  }

  // Typed payloads matching the facade demo's ask<T> contracts.

  private triageJson(): string {
    return JSON.stringify({
      incidentId: 'INC-20261031-01',
      severity: 'P1',
      failureDomain: 'DATABASE',
      suspectedCommit: 'a1b2c3d4',
      rootCause: 'Connection pool exhaustion under burst traffic; idle connections not pruned.',
      recommendedAction: 'Apply hotfix to connection pool configuration and restart pool worker.',
      confidence: 0.95,
    });
  }

  private safetyJson(): string {
    return JSON.stringify({
      isApproved: true,
      riskLevel: 'LOW',
      safetyViolations: [],
      rollbackCommand: 'npm run rollback:pool-config',
      signedOffBy: 'SafetyReviewerAgent',
    });
  }

  private planJson(): string {
    return JSON.stringify({
      strategy: 'EXPAND_CONNECTION_POOL',
      steps: [
        'Apply hotfix to connection pool configuration',
        'Restart pool workers one at a time',
        'Verify healthz returns 200 for 5 consecutive probes',
      ],
      estimatedMinutes: 12,
    });
  }

  private postMortemJson(): string {
    return JSON.stringify({
      summary:
        'Connection pool exhaustion under burst traffic caused healthz 500s; hotfix applied and verified by the deterministic gate.',
      preventiveActions: [
        'Add pool saturation alerts at 70% utilization',
        'Load-test pool limits before traffic events',
        'Automate idle-connection pruning',
      ],
    });
  }

  private decisionJson(): string {
    return JSON.stringify({
      action: 'RESTART_POOL_WORKERS',
      owner: 'on-call-sre',
    });
  }

  private verdictJson(): string {
    return JSON.stringify({
      assessment: 'Pool saturation is load-driven, not a code regression; expand limits and prune idle connections.',
      confidence: 0.93,
    });
  }
}
