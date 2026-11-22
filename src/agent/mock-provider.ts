import { LLMProvider, LLMRequest, LLMResponse } from '../types.js';

/**
 * Extracts a JSON Schema string from a formatted prompt if present.
 */
function extractSchemaFromPrompt(prompt: string): Record<string, unknown> | undefined {
  const marker = 'Respond with a single JSON object matching exactly this schema:\n';
  const idx = prompt.lastIndexOf(marker);
  if (idx !== -1) {
    const jsonStr = prompt.slice(idx + marker.length).trim();
    try {
      return JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      // not valid json
    }
  }
  return undefined;
}

/**
 * Synthesizes a valid, structurally conforming mock object from a JSON Schema
 * extracted from an ask prompt. This decouples MockProvider from canned demo
 * templates and provides dynamic schema synthesis for arbitrary typed asks.
 */
export function synthesizeMockFromSchema(
  schema: Record<string, unknown>,
  defs?: Record<string, unknown>,
): unknown {
  return synthesizeMockNode('', schema, defs ?? (schema['definitions'] as Record<string, unknown> | undefined));
}

function synthesizeMockNode(
  key: string,
  schema: Record<string, unknown>,
  defs?: Record<string, unknown>,
): unknown {
  if (!schema || typeof schema !== 'object') return 'mock-value';

  if (typeof schema['$ref'] === 'string' && defs) {
    const refKey = schema['$ref'].replace(/^#\/definitions\//, '');
    const target = defs[refKey] as Record<string, unknown> | undefined;
    if (target) return synthesizeMockNode(key, target, defs);
  }

  if (Array.isArray(schema['anyOf']) && schema['anyOf'].length > 0) {
    return synthesizeMockNode(key, schema['anyOf'][0] as Record<string, unknown>, defs);
  }
  if (Array.isArray(schema['oneOf']) && schema['oneOf'].length > 0) {
    return synthesizeMockNode(key, schema['oneOf'][0] as Record<string, unknown>, defs);
  }
  if (Array.isArray(schema['allOf']) && schema['allOf'].length > 0) {
    const merged: Record<string, unknown> = {};
    for (const sub of schema['allOf']) {
      const res = synthesizeMockNode(key, sub as Record<string, unknown>, defs);
      if (typeof res === 'object' && res !== null) Object.assign(merged, res);
    }
    return merged;
  }

  const rawType = schema['type'];
  const type = Array.isArray(rawType) ? rawType[0] : rawType;

  if (type === 'string') {
    if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
      return schema['enum'][0];
    }
    if (schema['format'] === 'date-time' || /timestamp|date|time/i.test(key)) {
      return new Date().toISOString();
    }
    if (/status/i.test(key)) return 'SUCCESS';
    if (/severity/i.test(key)) return 'P1';
    if (/email/i.test(key)) return 'test@example.com';
    if (/url|endpoint|link/i.test(key)) return 'https://example.com/api';
    if (/message|summary|notes|description|rationale|title/i.test(key)) {
      return `Mock deterministic ${key || 'response'} completed`;
    }
    if (/id/i.test(key)) return `mock-${key || 'id'}-01`;
    return `mock-${key || 'value'}`;
  }

  if (type === 'number' || type === 'integer') {
    if (typeof schema['minimum'] === 'number') return schema['minimum'];
    if (/score|confidence|ratio|rate/i.test(key)) return 0.95;
    if (/count|total|duration|minutes|seconds|files|attempts/i.test(key)) return 10;
    return 42;
  }

  if (type === 'boolean') {
    return true;
  }

  if (type === 'array') {
    const items = schema['items'];
    if (Array.isArray(items)) {
      return items.map((sub, i) => synthesizeMockNode(`${key}_${i}`, sub as Record<string, unknown>, defs));
    }
    if (items && typeof items === 'object') {
      const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 1;
      const count = Math.max(1, Math.min(minItems, 3));
      const res = [];
      for (let i = 0; i < count; i++) {
        res.push(synthesizeMockNode(key.replace(/s$/, ''), items as Record<string, unknown>, defs));
      }
      return res;
    }
    return [];
  }

  if (type === 'object' || schema['properties']) {
    const obj: Record<string, unknown> = {};
    const props = (schema['properties'] as Record<string, Record<string, unknown>>) || {};
    const subDefs = (schema['definitions'] as Record<string, unknown>) || defs;
    for (const [propKey, propSchema] of Object.entries(props)) {
      obj[propKey] = synthesizeMockNode(propKey, propSchema, subDefs);
    }
    return obj;
  }

  return 'mock-value';
}

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
    const extractedSchema = extractSchemaFromPrompt(lastUserMessage);
    // Actor-name routing: the system prompt names the agent ("You are specialized
    // agent \"safety-reviewer\""), and role identity is immune to the embedded
    // typed-result JSON in user prompts (whose field names poison keyword matching).
    const systemMessage = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const hasAstScan = request.messages.some((m) => m.role === 'user' && /ast codebase scan/i.test(m.content));

    let content = '{}';

    // 0. Actor-identity routing (most specific wins; immune to embedded data)
    if (/postmortem|post-mortem/i.test(systemMessage)) {
      content = this.postMortemJson();
    } else if (/migration[-_]?worker|code[-_]?transformer/i.test(systemMessage)) {
      content = this.migrationTransformJson(lastUserMessage);
    } else if (/migration[-_\s]*architect/i.test(systemMessage)) {
      // In live mode without --mock, live AST codebase scan prompts must engage authentic auto-repair
      // and fail schema validation rather than bypassing with canned mock data (Adversarial Challenge 3.1).
      if (hasAstScan) {
        content = this.planJson();
      } else {
        content = this.migrationPlanJson();
      }
    } else if (/code[-_\s]*reviewer?|code[-_\s]*review/i.test(systemMessage)) {
      content = this.codeReviewJson(lastUserMessage);
    } else if (/safety|auditor/i.test(systemMessage)) {
      content = this.safetyJson();
    } else if (/release[-_]?recorder|release[-_]?synthesizer/i.test(systemMessage)) {
      content = this.releaseRecorderJson();
    } else if (/architect/i.test(systemMessage)) {
      if (hasAstScan) {
        content = this.planJson();
      } else if (
        extractedSchema &&
        typeof extractedSchema.properties === 'object' &&
        extractedSchema.properties !== null &&
        !('strategy' in extractedSchema.properties) &&
        !('topologicalOrder' in extractedSchema.properties)
      ) {
        content = JSON.stringify(synthesizeMockFromSchema(extractedSchema));
      } else if (/dynamo|sqs|s3|transform|patch|sdk|migrat|aws/i.test(systemMessage + ' ' + lastUserMessage)) {
        content = this.migrationPlanJson();
      } else {
        content = this.planJson();
      }
    } else if (/planner/i.test(systemMessage)) {
      if (hasAstScan) {
        content = this.planJson();
      } else if (
        extractedSchema &&
        typeof extractedSchema.properties === 'object' &&
        extractedSchema.properties !== null &&
        !('strategy' in extractedSchema.properties) &&
        !('topologicalOrder' in extractedSchema.properties)
      ) {
        content = JSON.stringify(synthesizeMockFromSchema(extractedSchema));
      } else if (/dynamo|sqs|s3|transform|patch|sdk|migrat|aws/i.test(systemMessage + ' ' + lastUserMessage)) {
        content = this.migrationPlanJson();
      } else {
        content = this.planJson();
      }
    } else if (/decision/i.test(systemMessage)) {
      content = this.decisionJson();
    } else if (/analyst|assess/i.test(systemMessage)) {
      content = this.verdictJson();
    } else if (/triage/i.test(systemMessage)) {
      content = this.triageJson();
    } else if (/inspector/i.test(systemMessage)) {
      if (/triage|incident|telemetry|root.*cause/i.test(lastUserMessage)) {
        content = this.triageJson();
      } else {
        content = JSON.stringify({
          healthStatus: 'HEALTHY',
          scannedFiles: 42,
          summary: 'Environment verified. All runtimes and toolchains conform to requirements.',
          recommendations: ['Enable TypeScript strict mode', 'Verify git working tree status'],
        });
      }
    } else if (/reviewer/i.test(systemMessage)) {
      if (/dynamo|sqs|s3|transform|patch|sdk|migrat|code/i.test(systemMessage + ' ' + lastUserMessage)) {
        content = this.codeReviewJson(lastUserMessage);
      } else {
        content = this.safetyJson();
      }
    }
    // 1. Incident Triage user-message pattern (Demo 1)
    else if (/triage/i.test(lastUserMessage) || (/incident|telemetry|healthz/i.test(lastUserMessage) && !/review|audit|plan|runbook/i.test(lastUserMessage))) {
      content = this.triageJson();
    }
    // 2. Explicit Safety / Audit context (Demo 1)
    else if (
      /safety|blast|policy|pool-config/i.test(lastUserMessage) &&
      !/dynamo|sqs|s3|aws-sdk|sdk.*v3/i.test(lastUserMessage)
    ) {
      content = this.safetyJson();
    }
    // 3. Code Reviewer user-message pattern (Demo 2) with word boundary protection (preventing 'ast' matching 'blast')
    else if (
      /code[-_\s]*review/i.test(lastUserMessage) ||
      /review.*\b(?:code|diff|patch|service|ast|dynamo|sqs|s3|migrat\w*|transform\w*|sdk)\b/i.test(lastUserMessage) ||
      /\b(?:code|diff|patch|service|ast|dynamo|sqs|s3|migrat\w*|transform\w*|sdk)\b.*review/i.test(lastUserMessage)
    ) {
      content = this.codeReviewJson(lastUserMessage);
    }
    // 4. Generic Safety Reviewer / auditor user-message pattern (Demo 1)
    else if (/safety|review|audit|blast|policy/i.test(lastUserMessage)) {
      content = this.safetyJson();
    }
    // 3. Post-mortem synthesizer — also before triage: its prompt embeds the incident data.
    else if (/post-mortem|postmortem/i.test(lastUserMessage)) {
      content = this.postMortemJson();
    }
    // 4. Migration Architect user-message pattern (Demo 2)
    else if (
      /(?:migration|sdk|aws-sdk).*(?:plan|architect|topolog)/i.test(lastUserMessage) ||
      /(?:plan|architect).*(?:migration|sdk|aws-sdk)/i.test(lastUserMessage)
    ) {
      content = this.migrationPlanJson();
    }
    // 5. Remediation planner — also before triage for the same reason.
    else if (/remediation plan|runbook/i.test(lastUserMessage)) {
      content = this.planJson();
    }
    // 6. Release recorder pattern (Demo 2)
    else if (/release note|pr description|release summary/i.test(lastUserMessage)) {
      content = this.releaseRecorderJson();
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
      approved: true,
      isApproved: true,
      safetyScore: 0.98,
      riskLevel: 'LOW',
      safetyViolations: [],
      prohibitedCommandsDetected: [],
      policyCompliance: 'PASS',
      riskMitigationNotes: 'Blast radius is contained to connection pool parameters; rollback command is verified.',
      rollbackCommand: 'npm run rollback:pool-config',
      signedOffBy: 'SafetyReviewerAgent',
    });
  }

  private codeReviewJson(message: string = ''): string {
    const file = /dynamo/i.test(message)
      ? 'src/dynamo-service.ts'
      : /sqs/i.test(message)
      ? 'src/sqs-service.ts'
      : 'src/s3-service.ts';
    return JSON.stringify({
      filePath: file,
      approved: true,
      isApproved: true,
      reviewScore: 0.98,
      riskLevel: 'LOW',
      identifiedRisks: [],
      safetyViolations: [],
      astValidation: 'PASS',
      lintCheck: 'PASS',
      suggestedAdjustments: 'None. Migration follows SDK v3 best practices.',
      rollbackCommand: 'git checkout -- .',
      signedOffBy: 'CodeReviewerAgent',
    });
  }

  private migrationTransformJson(message: string): string {
    if (/dynamo/i.test(message)) {
      return JSON.stringify({
        file: 'src/dynamo-service.ts',
        filePath: 'src/dynamo-service.ts',
        serviceName: 'dynamodb',
        originalPackage: 'aws-sdk',
        targetPackage: '@aws-sdk/client-dynamodb',
        transformedCode:
          'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nimport { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";\n\nexport interface UserRecord {\n  userId: string;\n  tenantId: string;\n  email: string;\n  createdAt: string;\n}\n\nexport class DynamoService {\n  private docClient: DynamoDBDocumentClient;\n\n  constructor(client?: DynamoDBDocumentClient) {\n    if (client) {\n      this.docClient = client;\n    } else {\n      const raw = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });\n      this.docClient = DynamoDBDocumentClient.from(raw);\n    }\n  }\n\n  async saveUser(tableName: string, user: UserRecord): Promise<void> {\n    await this.docClient.send(new PutCommand({\n      TableName: tableName,\n      Item: user as unknown as Record<string, unknown>,\n    }));\n  }\n\n  async getUser(tableName: string, userId: string): Promise<UserRecord | null> {\n    const res = await this.docClient.send(new GetCommand({\n      TableName: tableName,\n      [\'Key\']: { userId },\n    }));\n    return (res.Item as unknown as UserRecord) || null;\n  }\n\n  async queryUsersByTenant(tableName: string, tenantId: string): Promise<UserRecord[]> {\n    const res = await this.docClient.send(new QueryCommand({\n      TableName: tableName,\n      [\'KeyConditionExpression\']: "tenantId = :tid",\n      ExpressionAttributeValues: { ":tid": tenantId },\n    }));\n    return ((res.Items || []) as unknown as UserRecord[]);\n  }\n}\n',
        diffPatch:
          '@@ -1,15 +1,18 @@\n-import AWS from "aws-sdk";\n+import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\n+import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";',
        modifiedImports: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
        breakingChangesResolved: [
          'new AWS.DynamoDB.DocumentClient() -> DynamoDBDocumentClient.from(new DynamoDBClient())',
          'docClient.put(...).promise() -> docClient.send(new PutCommand(...))',
          'docClient.get(...).promise() -> docClient.send(new GetCommand(...))',
          'docClient.query(...).promise() -> docClient.send(new QueryCommand(...))',
        ],
        breakingChangesHandled: [
          'new AWS.DynamoDB.DocumentClient() -> DynamoDBDocumentClient.from(new DynamoDBClient())',
          'docClient.put(...).promise() -> docClient.send(new PutCommand(...))',
          'docClient.get(...).promise() -> docClient.send(new GetCommand(...))',
          'docClient.query(...).promise() -> docClient.send(new QueryCommand(...))',
        ],
        status: 'SUCCESS',
        notes: 'Migrated from aws-sdk DocumentClient to @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb with command pattern.',
      });
    }

    if (/sqs/i.test(message)) {
      return JSON.stringify({
        file: 'src/sqs-service.ts',
        filePath: 'src/sqs-service.ts',
        serviceName: 'sqs',
        originalPackage: 'aws-sdk',
        targetPackage: '@aws-sdk/client-sqs',
        transformedCode:
          'import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";\n\nexport interface MessagePayload {\n  id: string;\n  event: string;\n  data: unknown;\n}\n\nexport class SQSService {\n  private sqs: SQSClient;\n\n  constructor(client?: SQSClient) {\n    this.sqs = client ?? new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });\n  }\n\n  async publishEvent(queueUrl: string, payload: MessagePayload): Promise<string> {\n    const res = await this.sqs.send(new SendMessageCommand({\n      QueueUrl: queueUrl,\n      MessageBody: JSON.stringify(payload),\n      MessageAttributes: {\n        EventType: {\n          DataType: "String",\n          StringValue: payload.event,\n        },\n      },\n    }));\n    return res.MessageId || "";\n  }\n\n  async pollMessages(queueUrl: string, maxMessages = 10): Promise<Array<{ id: string; body: string }>> {\n    const res = await this.sqs.send(new ReceiveMessageCommand({\n      QueueUrl: queueUrl,\n      MaxNumberOfMessages: maxMessages,\n      WaitTimeSeconds: 2,\n    }));\n    return (res.Messages || []).map((m) => ({\n      id: m.MessageId || "",\n      body: m.Body || "",\n    }));\n  }\n}\n',
        diffPatch:
          '@@ -1,12 +1,15 @@\n-import AWS from "aws-sdk";\n+import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";',
        modifiedImports: ['@aws-sdk/client-sqs'],
        breakingChangesResolved: [
          'new AWS.SQS() -> new SQSClient()',
          'sqs.sendMessage(...).promise() -> sqs.send(new SendMessageCommand(...))',
          'sqs.receiveMessage(...).promise() -> sqs.send(new ReceiveMessageCommand(...))',
        ],
        breakingChangesHandled: [
          'new AWS.SQS() -> new SQSClient()',
          'sqs.sendMessage(...).promise() -> sqs.send(new SendMessageCommand(...))',
          'sqs.receiveMessage(...).promise() -> sqs.send(new ReceiveMessageCommand(...))',
        ],
        status: 'SUCCESS',
        notes: 'Migrated from aws-sdk SQS to @aws-sdk/client-sqs with command pattern.',
      });
    }

    return JSON.stringify({
      file: 'src/s3-service.ts',
      filePath: 'src/s3-service.ts',
      serviceName: 's3',
      originalPackage: 'aws-sdk',
      targetPackage: '@aws-sdk/client-s3',
      transformedCode:
        'import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";\n\nexport interface S3UploadResult {\n  location: string;\n  [\'key\']: string;\n}\n\nexport class S3Service {\n  private client: S3Client;\n\n  constructor(client?: S3Client) {\n    this.client = client ?? new S3Client({ region: process.env.AWS_REGION || "us-east-1" });\n  }\n\n  async uploadFile(bucket: string, targetPath: string, content: string | Buffer): Promise<S3UploadResult> {\n    const cmd = new PutObjectCommand({\n      Bucket: bucket,\n      [\'Key\']: targetPath,\n      Body: content,\n      ContentType: "text/plain",\n    });\n    await this.client.send(cmd);\n    return {\n      location: `https://${bucket}.s3.amazonaws.com/${targetPath}`,\n      [\'key\']: targetPath,\n    };\n  }\n\n  async downloadFile(bucket: string, targetPath: string): Promise<string> {\n    const cmd = new GetObjectCommand({\n      Bucket: bucket,\n      [\'Key\']: targetPath,\n    });\n    const res = await this.client.send(cmd);\n    return res.Body ? await (res.Body as any).transformToString("utf-8") : "";\n  }\n\n  async listFiles(bucket: string, prefix?: string): Promise<string[]> {\n    const cmd = new ListObjectsV2Command({\n      Bucket: bucket,\n      Prefix: prefix,\n    });\n    const res = await this.client.send(cmd);\n    return (res.Contents || []).map((c) => c.Key || "").filter(Boolean);\n  }\n}\n',
      diffPatch:
        '@@ -1,15 +1,18 @@\n-import AWS from "aws-sdk";\n+import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";',
      modifiedImports: ['@aws-sdk/client-s3'],
      breakingChangesResolved: [
        'new AWS.S3() -> new S3Client()',
        's3.upload(...).promise() -> s3.send(new PutObjectCommand(...))',
        's3.getObject(...).promise() -> s3.send(new GetObjectCommand(...))',
        's3.listObjectsV2(...).promise() -> s3.send(new ListObjectsV2Command(...))',
      ],
      breakingChangesHandled: [
        'new AWS.S3() -> new S3Client()',
        's3.upload(...).promise() -> s3.send(new PutObjectCommand(...))',
        's3.getObject(...).promise() -> s3.send(new GetObjectCommand(...))',
        's3.listObjectsV2(...).promise() -> s3.send(new ListObjectsV2Command(...))',
      ],
      status: 'SUCCESS',
      notes: 'Migrated from aws-sdk S3 to @aws-sdk/client-s3 with command pattern.',
    });
  }

  private planJson(): string {
    return JSON.stringify({
      strategy: 'EXPAND_CONNECTION_POOL',
      rationale: 'Connection pool saturation under burst traffic; expanding pool capacity resolves queuing and 5xx errors.',
      actions: [
        {
          order: 1,
          command: 'node -e "const fs = require(\'fs\'); const p = \'.workflow/pool-config.json\'; const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, \'utf8\')) : { maxConnections: 50 }; c.maxConnections = 250; c.status = \'healthy\'; fs.writeFileSync(p, JSON.stringify(c, null, 2));"',
          description: 'Expand connection pool capacity from 50 to 250 and mark status healthy',
          isDestructive: false,
          rollbackCommand: 'npm run rollback:pool-config',
        },
      ],
      estimatedRecoveryTimeSeconds: 120,
      riskLevel: 'LOW',
      steps: [
        'Apply hotfix to connection pool configuration',
        'Restart pool workers one at a time',
        'Verify healthz returns 200 for 5 consecutive probes',
      ],
      estimatedMinutes: 12,
    });
  }

  private migrationPlanJson(): string {
    return JSON.stringify({
      planId: 'plan-aws-sdk-v3-migration',
      topologicalOrder: [
        'src/s3-service.ts',
        'src/dynamo-service.ts',
        'src/sqs-service.ts',
      ],
      transformationRulesApplied: [
        'RULE-01: Replace aws-sdk with modular @aws-sdk/client-* packages',
        'RULE-02: Convert client constructors to S3Client, DynamoDBClient, SQSClient',
        'RULE-03: Convert imperative .upload/.putItem/.sendMessage to command objects',
        'RULE-04: Strip obsolete .promise() invocations (v3 returns native Promises)',
        'RULE-05: Wrap DynamoDBClient with DynamoDBDocumentClient for DocumentClient parity',
      ],
      estimatedComplexity: 'MEDIUM',
      backupBranchName: 'backup/pre-aws-sdk-v3-migration',
      parallelBatches: [
        ['src/s3-service.ts', 'src/dynamo-service.ts', 'src/sqs-service.ts'],
      ],
      mcpRulesConsulted: ['AWS-SDK-V3-S3', 'AWS-SDK-V3-DDB', 'AWS-SDK-V3-SQS'],
      plan: 'Phased migration plan: baseline check -> parallel S3/Dynamo/SQS transformation -> compiler gate.',
      orderedFiles: [
        'src/s3-service.ts',
        'src/dynamo-service.ts',
        'src/sqs-service.ts',
      ],
    });
  }

  private releaseRecorderJson(): string {
    return JSON.stringify({
      status: 'SUCCESS',
      title: 'chore(sdk): migrate codebase from aws-sdk v2 to modular SDK v3',
      summary: 'All 3 legacy AWS SDK services (S3, DynamoDB, SQS) migrated to v3 with compiler checks and tests passing.',
      migratedFiles: ['src/s3-service.ts', 'src/dynamo-service.ts', 'src/sqs-service.ts'],
      targetPackage: '@aws-sdk/client-*',
      rollbackCommand: 'git checkout -- .',
      message: 'Release notes and PR description successfully generated.',
      timestamp: new Date().toISOString(),
    });
  }

  private postMortemJson(): string {
    const summary =
      'Connection pool exhaustion under burst traffic caused healthz 500s; hotfix applied and verified by the deterministic gate.';
    const preventiveActions = [
      'Add pool saturation alerts at 70% utilization',
      'Load-test pool limits before traffic events',
      'Automate idle-connection pruning',
    ];
    return JSON.stringify({
      title: 'Post-Mortem: Connection Pool Saturation Incident INC-20261031-01',
      incidentDurationMinutes: 14,
      impactSummary: 'Burst traffic caused connection pool exhaustion and intermittent healthz 500 responses.',
      rootCause: 'Connection pool exhaustion under burst traffic; idle connections not pruned.',
      triggerEvent: 'Traffic burst exceeding default connection pool limit of 50.',
      remediationSummary: 'Automated remediation expanded connection pool capacity to 250 and restored health.',
      actionItems: [
        { priority: 'HIGH', description: 'Add pool saturation alerts at 70% utilization', ownerRole: 'on-call-sre' },
        { priority: 'MEDIUM', description: 'Load-test pool limits before traffic events', ownerRole: 'qa-engineer' },
        { priority: 'LOW', description: 'Automate idle-connection pruning', ownerRole: 'backend-team' },
      ],
      summary,
      preventiveActions,
      status: 'SUCCESS',
      message: 'Post-mortem successfully synthesized and recorded',
      timestamp: new Date().toISOString(),
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
