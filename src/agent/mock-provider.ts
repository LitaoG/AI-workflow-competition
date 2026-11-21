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
    } else if (/migration[-_]?worker|code[-_]?transformer/i.test(systemMessage)) {
      content = this.migrationTransformJson(lastUserMessage);
    } else if (/code[-_\s]*reviewer?|code[-_\s]*review/i.test(systemMessage)) {
      content = this.codeReviewJson();
    } else if (/safety|auditor/i.test(systemMessage)) {
      content = this.safetyJson();
    } else if (/architect|planner/i.test(systemMessage)) {
      content = this.planJson();
    } else if (/decision/i.test(systemMessage)) {
      content = this.decisionJson();
    } else if (/analyst|assess/i.test(systemMessage)) {
      content = this.verdictJson();
    } else if (/triage/i.test(systemMessage)) {
      content = this.triageJson();
    } else if (/reviewer/i.test(systemMessage)) {
      if (/dynamo|sqs|s3|transform|patch|sdk|migrat/i.test(systemMessage + ' ' + lastUserMessage)) {
        content = this.codeReviewJson();
      } else {
        content = this.safetyJson();
      }
    }
    // 1. Code Reviewer user-message pattern (Demo 2) — checked before generic reviewer/safety
    else if (
      /code[-_\s]*review/i.test(lastUserMessage) ||
      /^review\b/i.test(lastUserMessage) ||
      /review.*(?:code|diff|patch|service)/i.test(lastUserMessage) ||
      /(?:diff|patch).*review/i.test(lastUserMessage)
    ) {
      content = this.codeReviewJson();
    }
    // 2. Safety Reviewer user-message pattern (Demo 1) — triage-result JSON
    //    embedded in a safety prompt contains "P1"/"incident", which would wrongly
    //    match the triage pattern.
    else if (/safety|review|audit|blast/i.test(lastUserMessage)) {
      content = this.safetyJson();
    }
    // 3. Post-mortem synthesizer — also before triage: its prompt embeds the incident data.
    else if (/post-mortem|postmortem/i.test(lastUserMessage)) {
      content = this.postMortemJson();
    }
    // 4. Remediation planner — also before triage for the same reason.
    else if (/remediation plan|runbook/i.test(lastUserMessage)) {
      content = this.planJson();
    }
    // 5. Incident Triage pattern
    else if (/triage|incident|telemetry|p1|healthz/i.test(lastUserMessage)) {
      content = this.triageJson();
    }
    // 6. Demo 2: AWS SDK v2->v3 Migration pattern (service-specific)
    else if (/migration|sdk|aws-sdk|transform/i.test(lastUserMessage)) {
      content = this.migrationTransformJson(lastUserMessage);
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

  private codeReviewJson(): string {
    return JSON.stringify({
      isApproved: true,
      riskLevel: 'LOW',
      safetyViolations: [],
      rollbackCommand: 'git checkout -- .',
      signedOffBy: 'CodeReviewerAgent',
    });
  }

  private migrationTransformJson(message: string): string {
    if (/dynamo/i.test(message)) {
      return JSON.stringify({
        file: 'src/dynamo-service.ts',
        originalPackage: 'aws-sdk',
        targetPackage: '@aws-sdk/client-dynamodb',
        transformedCode:
          'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nimport { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";\n\nexport interface UserRecord {\n  userId: string;\n  tenantId: string;\n  email: string;\n  createdAt: string;\n}\n\nexport class DynamoService {\n  private docClient: DynamoDBDocumentClient;\n\n  constructor(client?: DynamoDBDocumentClient) {\n    if (client) {\n      this.docClient = client;\n    } else {\n      const raw = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });\n      this.docClient = DynamoDBDocumentClient.from(raw);\n    }\n  }\n\n  async saveUser(tableName: string, user: UserRecord): Promise<void> {\n    await this.docClient.send(new PutCommand({\n      TableName: tableName,\n      Item: user as unknown as Record<string, unknown>,\n    }));\n  }\n\n  async getUser(tableName: string, userId: string): Promise<UserRecord | null> {\n    const res = await this.docClient.send(new GetCommand({\n      TableName: tableName,\n      [\'Key\']: { userId },\n    }));\n    return (res.Item as unknown as UserRecord) || null;\n  }\n\n  async queryUsersByTenant(tableName: string, tenantId: string): Promise<UserRecord[]> {\n    const res = await this.docClient.send(new QueryCommand({\n      TableName: tableName,\n      [\'KeyConditionExpression\']: "tenantId = :tid",\n      ExpressionAttributeValues: { ":tid": tenantId },\n    }));\n    return ((res.Items || []) as unknown as UserRecord[]);\n  }\n}\n',
        breakingChangesResolved: [
          'new AWS.DynamoDB.DocumentClient() -> DynamoDBDocumentClient.from(new DynamoDBClient())',
          'docClient.put(...).promise() -> docClient.send(new PutCommand(...))',
          'docClient.get(...).promise() -> docClient.send(new GetCommand(...))',
          'docClient.query(...).promise() -> docClient.send(new QueryCommand(...))',
        ],
        status: 'SUCCESS',
      });
    }

    if (/sqs/i.test(message)) {
      return JSON.stringify({
        file: 'src/sqs-service.ts',
        originalPackage: 'aws-sdk',
        targetPackage: '@aws-sdk/client-sqs',
        transformedCode:
          'import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";\n\nexport interface MessagePayload {\n  id: string;\n  event: string;\n  data: unknown;\n}\n\nexport class SQSService {\n  private sqs: SQSClient;\n\n  constructor(client?: SQSClient) {\n    this.sqs = client ?? new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });\n  }\n\n  async publishEvent(queueUrl: string, payload: MessagePayload): Promise<string> {\n    const res = await this.sqs.send(new SendMessageCommand({\n      QueueUrl: queueUrl,\n      MessageBody: JSON.stringify(payload),\n      MessageAttributes: {\n        EventType: {\n          DataType: "String",\n          StringValue: payload.event,\n        },\n      },\n    }));\n    return res.MessageId || "";\n  }\n\n  async pollMessages(queueUrl: string, maxMessages = 10): Promise<Array<{ id: string; body: string }>> {\n    const res = await this.sqs.send(new ReceiveMessageCommand({\n      QueueUrl: queueUrl,\n      MaxNumberOfMessages: maxMessages,\n      WaitTimeSeconds: 2,\n    }));\n    return (res.Messages || []).map((m) => ({\n      id: m.MessageId || "",\n      body: m.Body || "",\n    }));\n  }\n}\n',
        breakingChangesResolved: [
          'new AWS.SQS() -> new SQSClient()',
          'sqs.sendMessage(...).promise() -> sqs.send(new SendMessageCommand(...))',
          'sqs.receiveMessage(...).promise() -> sqs.send(new ReceiveMessageCommand(...))',
        ],
        status: 'SUCCESS',
      });
    }

    return JSON.stringify({
      file: 'src/s3-service.ts',
      originalPackage: 'aws-sdk',
      targetPackage: '@aws-sdk/client-s3',
      transformedCode:
        'import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";\n\nexport interface S3UploadResult {\n  location: string;\n  [\'key\']: string;\n}\n\nexport class S3Service {\n  private client: S3Client;\n\n  constructor(client?: S3Client) {\n    this.client = client ?? new S3Client({ region: process.env.AWS_REGION || "us-east-1" });\n  }\n\n  async uploadFile(bucket: string, targetPath: string, content: string | Buffer): Promise<S3UploadResult> {\n    const cmd = new PutObjectCommand({\n      Bucket: bucket,\n      [\'Key\']: targetPath,\n      Body: content,\n      ContentType: "text/plain",\n    });\n    await this.client.send(cmd);\n    return {\n      location: `https://${bucket}.s3.amazonaws.com/${targetPath}`,\n      [\'key\']: targetPath,\n    };\n  }\n\n  async downloadFile(bucket: string, targetPath: string): Promise<string> {\n    const cmd = new GetObjectCommand({\n      Bucket: bucket,\n      [\'Key\']: targetPath,\n    });\n    const res = await this.client.send(cmd);\n    return res.Body ? await (res.Body as any).transformToString("utf-8") : "";\n  }\n\n  async listFiles(bucket: string, prefix?: string): Promise<string[]> {\n    const cmd = new ListObjectsV2Command({\n      Bucket: bucket,\n      Prefix: prefix,\n    });\n    const res = await this.client.send(cmd);\n    return (res.Contents || []).map((c) => c.Key || "").filter(Boolean);\n  }\n}\n',
      breakingChangesResolved: [
        'new AWS.S3() -> new S3Client()',
        's3.upload(...).promise() -> s3.send(new PutObjectCommand(...))',
        's3.getObject(...).promise() -> s3.send(new GetObjectCommand(...))',
        's3.listObjectsV2(...).promise() -> s3.send(new ListObjectsV2Command(...))',
      ],
      status: 'SUCCESS',
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
