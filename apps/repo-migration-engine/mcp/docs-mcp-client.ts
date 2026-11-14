import type { ExecutionContext } from 'ai-workflow';

export interface MigrationRule {
  service: string;
  sourcePackage: string;
  targetPackage: string;
  constructorChange: {
    from: string;
    to: string;
  };
  methodMappings: Array<{
    v2Method: string;
    v3Command: string;
    removesPromise: boolean;
    importPath: string;
  }>;
  typeChanges: Record<string, string>;
}

export class DocsMCPClient {
  private ctx?: ExecutionContext;
  private isMock: boolean;

  constructor(options?: { ctx?: ExecutionContext; isMock?: boolean }) {
    this.ctx = options?.ctx;
    this.isMock = options?.isMock ?? options?.ctx?.isMock ?? false;
  }

  public async getMigrationRules(service: 'S3' | 'DynamoDB' | 'SQS' | string): Promise<MigrationRule> {
    if (this.ctx && !this.isMock && this.ctx.mcp?.callTool) {
      try {
        const res: any = await this.ctx.mcp.callTool('docs-mcp-server', 'get_migration_rules', {
          source: 'aws-sdk-v2',
          target: 'aws-sdk-v3',
          service,
        });
        if (res && res.rules) return res.rules;
      } catch {
        // Fall back to internal catalog
      }
    }

    // Embedded High-Precision AWS SDK v2 -> v3 Migration Rules Catalog
    switch (service.toUpperCase()) {
      case 'S3':
        return {
          service: 'S3',
          sourcePackage: 'aws-sdk',
          targetPackage: '@aws-sdk/client-s3',
          constructorChange: {
            from: 'new AWS.S3({ region })',
            to: 'new S3Client({ region })',
          },
          methodMappings: [
            { v2Method: 'upload', v3Command: 'PutObjectCommand', removesPromise: true, importPath: '@aws-sdk/client-s3' },
            { v2Method: 'getObject', v3Command: 'GetObjectCommand', removesPromise: true, importPath: '@aws-sdk/client-s3' },
            { v2Method: 'listObjectsV2', v3Command: 'ListObjectsV2Command', removesPromise: true, importPath: '@aws-sdk/client-s3' },
            { v2Method: 'deleteObject', v3Command: 'DeleteObjectCommand', removesPromise: true, importPath: '@aws-sdk/client-s3' },
          ],
          typeChanges: {
            'AWS.S3.PutObjectRequest': 'PutObjectCommandInput',
            'AWS.S3.GetObjectOutput': 'GetObjectCommandOutput',
          },
        };

      case 'DYNAMODB':
        return {
          service: 'DynamoDB',
          sourcePackage: 'aws-sdk',
          targetPackage: '@aws-sdk/client-dynamodb',
          constructorChange: {
            from: 'new AWS.DynamoDB.DocumentClient()',
            to: 'DynamoDBDocumentClient.from(new DynamoDBClient({}))',
          },
          methodMappings: [
            { v2Method: 'put', v3Command: 'PutCommand', removesPromise: true, importPath: '@aws-sdk/lib-dynamodb' },
            { v2Method: 'get', v3Command: 'GetCommand', removesPromise: true, importPath: '@aws-sdk/lib-dynamodb' },
            { v2Method: 'query', v3Command: 'QueryCommand', removesPromise: true, importPath: '@aws-sdk/lib-dynamodb' },
            { v2Method: 'scan', v3Command: 'ScanCommand', removesPromise: true, importPath: '@aws-sdk/lib-dynamodb' },
          ],
          typeChanges: {
            'AWS.DynamoDB.DocumentClient.PutItemInput': 'PutCommandInput',
            'AWS.DynamoDB.DocumentClient.GetItemOutput': 'GetCommandOutput',
          },
        };

      case 'SQS':
        return {
          service: 'SQS',
          sourcePackage: 'aws-sdk',
          targetPackage: '@aws-sdk/client-sqs',
          constructorChange: {
            from: 'new AWS.SQS({ region })',
            to: 'new SQSClient({ region })',
          },
          methodMappings: [
            { v2Method: 'sendMessage', v3Command: 'SendMessageCommand', removesPromise: true, importPath: '@aws-sdk/client-sqs' },
            { v2Method: 'receiveMessage', v3Command: 'ReceiveMessageCommand', removesPromise: true, importPath: '@aws-sdk/client-sqs' },
            { v2Method: 'deleteMessage', v3Command: 'DeleteMessageCommand', removesPromise: true, importPath: '@aws-sdk/client-sqs' },
          ],
          typeChanges: {
            'AWS.SQS.SendMessageRequest': 'SendMessageCommandInput',
            'AWS.SQS.ReceiveMessageResult': 'ReceiveMessageCommandOutput',
          },
        };

      default:
        throw new Error(`Unsupported migration service: ${service}`);
    }
  }
}
