import AWS from 'aws-sdk';

export interface UserRecord {
  userId: string;
  tenantId: string;
  email: string;
  createdAt: string;
}

export class DynamoService {
  private docClient: AWS.DynamoDB.DocumentClient;

  constructor(client?: AWS.DynamoDB.DocumentClient) {
    this.docClient = client ?? new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  async saveUser(tableName: string, user: UserRecord): Promise<void> {
    await this.docClient.put({
      TableName: tableName,
      Item: user as unknown as Record<string, unknown>,
    }).promise();
  }

  async getUser(tableName: string, userId: string): Promise<UserRecord | null> {
    const res = await this.docClient.get({
      TableName: tableName,
      Key: { userId },
    }).promise();

    return (res.Item as unknown as UserRecord) || null;
  }

  async queryUsersByTenant(tableName: string, tenantId: string): Promise<UserRecord[]> {
    const res = await this.docClient.query({
      TableName: tableName,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenantId },
    }).promise();

    return ((res.Items || []) as unknown as UserRecord[]);
  }
}
