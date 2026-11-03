import type {
  MigrationPlan,
  CodeTransformResult,
  CodeReviewResult,
  CompilerFixResult,
  MigrationSummaryReport,
} from '../schemas.ts';

// ============================================================================
// 1. MIGRATION ARCHITECT MOCK
// ============================================================================
export const mockMigrationPlan: MigrationPlan = {
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
};

// ============================================================================
// 2. CODE TRANSFORMER MOCKS (Workers 1, 2, 3)
// ============================================================================
export const mockS3TransformResult: CodeTransformResult = {
  filePath: 'src/s3-service.ts',
  serviceName: 's3',
  transformedCode: `import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

export interface S3UploadResult {
  location: string;
  key: string;
}

export class S3Service {
  private client: S3Client;

  constructor(client?: S3Client) {
    this.client = client ?? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  async uploadFile(bucket: string, key: string, content: string | Buffer): Promise<S3UploadResult> {
    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: 'text/plain',
    });
    await this.client.send(cmd);
    return {
      location: \`https://\${bucket}.s3.amazonaws.com/\${key}\`,
      key,
    };
  }

  async downloadFile(bucket: string, key: string): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const res = await this.client.send(cmd);
    return res.Body ? await (res.Body as any).transformToString('utf-8') : '';
  }

  async listFiles(bucket: string, prefix?: string): Promise<string[]> {
    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    });
    const res = await this.client.send(cmd);
    return (res.Contents || []).map((c) => c.Key || '').filter(Boolean);
  }
}
`,
  diffPatch: `--- src/s3-service.ts (v2)
+++ src/s3-service.ts (v3)
@@ -1,9 +1,8 @@
-import AWS from 'aws-sdk';
+import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

 export class S3Service {
-  private s3: AWS.S3;
+  private client: S3Client;

   constructor(client?: AWS.S3) {
-    this.s3 = client ?? new AWS.S3({ region: process.env.AWS_REGION || 'us-east-1' });
+    this.client = client ?? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
   }
`,
  modifiedImports: [
    "- import AWS from 'aws-sdk';",
    "+ import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';",
  ],
  breakingChangesHandled: [
    'Replaced AWS.S3 with S3Client',
    'Upgraded upload/getObject/listObjectsV2 to Command instances',
    'Removed .promise() chaining',
  ],
  status: 'SUCCESS',
  notes: 'Replaced AWS.S3 with S3Client. Upgraded upload/getObject/listObjectsV2 to Command instances. Removed .promise().',
};

export const mockDynamoTransformResult: CodeTransformResult = {
  filePath: 'src/dynamo-service.ts',
  serviceName: 'dynamodb',
  transformedCode: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export interface UserRecord {
  userId: string;
  tenantId: string;
  email: string;
  createdAt: string;
}

export class DynamoService {
  private docClient: DynamoDBDocumentClient;

  constructor(client?: DynamoDBDocumentClient) {
    if (client) {
      this.docClient = client;
    } else {
      const raw = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
      this.docClient = DynamoDBDocumentClient.from(raw);
    }
  }

  async saveUser(tableName: string, user: UserRecord): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: tableName,
      Item: user as unknown as Record<string, unknown>,
    }));
  }

  async getUser(tableName: string, userId: string): Promise<UserRecord | null> {
    const res = await this.docClient.send(new GetCommand({
      TableName: tableName,
      Key: { userId },
    }));
    return (res.Item as unknown as UserRecord) || null;
  }

  async queryUsersByTenant(tableName: string, tenantId: string): Promise<UserRecord[]> {
    const res = await this.docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenantId },
    }));
    return ((res.Items || []) as unknown as UserRecord[]);
  }
}
`,
  diffPatch: `--- src/dynamo-service.ts (v2)
+++ src/dynamo-service.ts (v3)
@@ -1,8 +1,8 @@
-import AWS from 'aws-sdk';
+import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
+import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

 export class DynamoService {
-  private docClient: AWS.DynamoDB.DocumentClient;
+  private docClient: DynamoDBDocumentClient;
`,
  modifiedImports: [
    "- import AWS from 'aws-sdk';",
    "+ import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
    "+ import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';",
  ],
  breakingChangesHandled: [
    'DocumentClient native JS type marshalling preserved via DynamoDBDocumentClient',
    'Converted put/get/query to command objects',
    'Removed .promise() chaining',
  ],
  status: 'SUCCESS',
  notes: 'Wrapped DynamoDBClient in DynamoDBDocumentClient to preserve DocumentClient native JS type marshalling.',
};

export const mockSQSTransformResult: CodeTransformResult = {
  filePath: 'src/sqs-service.ts',
  serviceName: 'sqs',
  transformedCode: `import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

export interface MessagePayload {
  id: string;
  event: string;
  data: unknown;
}

export class SQSService {
  private client: SQSClient;

  constructor(client?: SQSClient) {
    this.client = client ?? new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  async publishEvent(queueUrl: string, payload: MessagePayload): Promise<string> {
    const res = await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageAttributes: {
        EventType: {
          DataType: 'String',
          StringValue: payload.event,
        },
      },
    }));
    return res.MessageId || '';
  }

  async pollMessages(queueUrl: string, maxMessages = 10): Promise<Array<{ id: string; body: string }>> {
    const res = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 2,
    }));
    return (res.Messages || []).map((m) => ({
      id: m.MessageId || '',
      body: m.Body || '',
    }));
  }
}
`,
  diffPatch: `--- src/sqs-service.ts (v2)
+++ src/sqs-service.ts (v3)
@@ -1,8 +1,7 @@
-import AWS from 'aws-sdk';
+import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

 export class SQSService {
-  private sqs: AWS.SQS;
+  private client: SQSClient;
`,
  modifiedImports: [
    "- import AWS from 'aws-sdk';",
    "+ import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
  ],
  breakingChangesHandled: [
    'Upgraded AWS.SQS to SQSClient',
    'Converted sendMessage and receiveMessage to command pattern',
    'Removed .promise() chaining',
  ],
  status: 'SUCCESS',
  notes: 'Upgraded AWS.SQS to SQSClient and converted sendMessage/receiveMessages to command pattern.',
};

// ============================================================================
// 3. PAIRED CODE REVIEWER MOCKS
// ============================================================================
export const mockS3ReviewResult: CodeReviewResult = {
  filePath: 'src/s3-service.ts',
  approved: true,
  reviewScore: 0.98,
  identifiedRisks: [],
  astValidation: 'PASS',
  lintCheck: 'PASS',
  suggestedAdjustments: 'None. S3Client and PutObjectCommand correctly implemented without .promise().',
  signedOffBy: 'CodeReviewerAgent-S3',
};

export const mockDynamoReviewResult: CodeReviewResult = {
  filePath: 'src/dynamo-service.ts',
  approved: true,
  reviewScore: 0.96,
  identifiedRisks: [],
  astValidation: 'PASS',
  lintCheck: 'PASS',
  suggestedAdjustments: 'None. DynamoDBDocumentClient properly configured; unmarshalling semantics preserved.',
  signedOffBy: 'CodeReviewerAgent-DynamoDB',
};

export const mockSQSReviewResult: CodeReviewResult = {
  filePath: 'src/sqs-service.ts',
  approved: true,
  reviewScore: 0.97,
  identifiedRisks: [],
  astValidation: 'PASS',
  lintCheck: 'PASS',
  suggestedAdjustments: 'None. SQS message attributes and command execution are type-safe.',
  signedOffBy: 'CodeReviewerAgent-SQS',
};

// ============================================================================
// 4. TYPE FIXER MOCK (Phase 4 Diagnostic Fix)
// ============================================================================
export const mockCompilerFixResult: CompilerFixResult = {
  filePath: 'src/s3-service.ts',
  compilerErrorFixed: "TS2339: Property 'promise' does not exist on type 'Promise<PutObjectCommandOutput>'",
  errorCode: 'TS2339',
  correctedCode: mockS3TransformResult.transformedCode,
  fixExplanation: 'Removed legacy v2 .promise() call. In AWS SDK v3, client.send() already returns a native Promise.',
  resolved: true,
};

// ============================================================================
// 5. MIGRATION SUMMARY MOCK (Phase 5 Release Summary)
// ============================================================================
export const mockMigrationSummaryReport: MigrationSummaryReport = {
  summaryTitle: 'AWS SDK v2 to v3 Modernization: Automated Multi-Agent Migration Complete',
  filesMigratedCount: 3,
  totalLinesModified: 138,
  compilerPassStatus: true,
  testsPassStatus: true,
  breakingChangesResolved: [
    'Replaced monolithic aws-sdk package with modular @aws-sdk/client-s3, @aws-sdk/client-dynamodb, @aws-sdk/client-sqs',
    'Upgraded legacy constructor instantiations to modular client instances',
    'Migrated imperative method calls to typed Command classes (PutObjectCommand, PutCommand, SendMessageCommand)',
    'Eliminated deprecated .promise() invocations across all async call paths',
    'Introduced DynamoDBDocumentClient to preserve zero-friction JavaScript document mapping',
  ],
  pullRequestMarkdown: `# feat(migration): Automated Upgrade from AWS SDK v2 to AWS SDK v3

> **Automated Pull Request synthesized by AI-Workflow**  
> *Engine*: AI-Workflow Dynamic Workflow Engine (\`demos/repo-migration-engine\`)  
> *Architecture*: "Code, not conversation" Multi-Agent Execution Pipeline  
> *Verification*: Deterministic Shell Gates (\`tsc --noEmit\` & \`npm test\`)

---

## 1. Executive Summary & Impact Analysis
This automated migration converts legacy monolithic \`aws-sdk\` v2 clients to modular AWS SDK v3 clients (\`@aws-sdk/client-s3\`, \`@aws-sdk/client-dynamodb\`, \`@aws-sdk/client-sqs\`), significantly reducing bundle size and improving tree-shaking performance.

## 2. Breaking Changes Resolved
- ✅ Replaced monolithic aws-sdk package with modular @aws-sdk/client-s3, @aws-sdk/client-dynamodb, @aws-sdk/client-sqs
- ✅ Upgraded legacy constructor instantiations to modular client instances
- ✅ Migrated imperative method calls to typed Command classes (PutObjectCommand, PutCommand, SendMessageCommand)
- ✅ Eliminated deprecated .promise() invocations across all async call paths
- ✅ Introduced DynamoDBDocumentClient to preserve zero-friction JavaScript document mapping

## 3. Transformed Services & Paired Review Audits
| Service | File | Modular Package | Review Score | AST Invariant |
| :--- | :--- | :--- | :---: | :---: |
| **Amazon S3** | \`src/s3-service.ts\` | \`@aws-sdk/client-s3\` | 0.98 | PASS |
| **Amazon DynamoDB** | \`src/dynamo-service.ts\` | \`@aws-sdk/lib-dynamodb\` | 0.96 | PASS |
| **Amazon SQS** | \`src/sqs-service.ts\` | \`@aws-sdk/client-sqs\` | 0.97 | PASS |

## 4. Verification & Gates
- **Baseline Gate**: Unit tests passed before migration initiation.
- **Post-Merge Gate**: tsc --noEmit && npm test passed successfully.
- **Durable Event Journal**: All step transitions recorded to \`.workflow/journal.jsonl\`.
`,
  kanbanState: 'completed',
  durationSeconds: 1.85,
};

// ============================================================================
// HELPER DISPATCHER
// ============================================================================
export function getMockResponseForRole(role: string, targetFileOrService?: string): unknown {
  const normRole = role.toLowerCase().replace(/_/g, '-');
  const target = (targetFileOrService || '').toLowerCase();

  if (normRole.includes('architect')) {
    return mockMigrationPlan;
  }

  if (normRole.includes('transformer') || normRole.includes('worker') || normRole.includes('transform')) {
    if (target.includes('s3')) return mockS3TransformResult;
    if (target.includes('dynamo') || target.includes('ddb')) return mockDynamoTransformResult;
    if (target.includes('sqs')) return mockSQSTransformResult;
    return mockS3TransformResult;
  }

  if (normRole.includes('reviewer') || normRole.includes('review')) {
    if (target.includes('s3')) return mockS3ReviewResult;
    if (target.includes('dynamo') || target.includes('ddb')) return mockDynamoReviewResult;
    if (target.includes('sqs')) return mockSQSReviewResult;
    return mockS3ReviewResult;
  }

  if (normRole.includes('fixer') || normRole.includes('type')) {
    return mockCompilerFixResult;
  }

  if (normRole.includes('summary') || normRole.includes('coordinator')) {
    return mockMigrationSummaryReport;
  }

  throw new Error(`No mock response defined for role: ${role}`);
}
