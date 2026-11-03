declare module 'aws-sdk' {
  export namespace S3 {
    export interface PutObjectRequest {
      Bucket: string;
      Key: string;
      Body: string | Buffer | Uint8Array;
      ContentType?: string;
    }
    export interface GetObjectRequest {
      Bucket: string;
      Key: string;
    }
    export interface GetObjectOutput {
      Body?: { toString(encoding?: string): string };
      ContentType?: string;
    }
    export interface ListObjectsV2Request {
      Bucket: string;
      Prefix?: string;
    }
    export interface ListObjectsV2Output {
      Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
      KeyCount?: number;
    }
    export namespace ManagedUpload {
      export interface SendData {
        Location: string;
        ETag: string;
        Bucket: string;
        Key: string;
      }
    }
  }

  export class S3 {
    constructor(options?: { region?: string; endpoint?: string });
    upload(params: S3.PutObjectRequest): { promise(): Promise<S3.ManagedUpload.SendData> };
    getObject(params: S3.GetObjectRequest): { promise(): Promise<S3.GetObjectOutput> };
    listObjectsV2(params: S3.ListObjectsV2Request): { promise(): Promise<S3.ListObjectsV2Output> };
  }

  export namespace DynamoDB {
    export namespace DocumentClient {
      export interface PutItemInput {
        TableName: string;
        Item: Record<string, unknown>;
      }
      export interface PutItemOutput {}
      export interface GetItemInput {
        TableName: string;
        Key: Record<string, unknown>;
      }
      export interface GetItemOutput {
        Item?: Record<string, unknown>;
      }
      export interface QueryInput {
        TableName: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      }
      export interface QueryOutput {
        Items?: Array<Record<string, unknown>>;
        Count?: number;
      }
    }

    export class DocumentClient {
      constructor(options?: { region?: string; endpoint?: string });
      put(params: DocumentClient.PutItemInput): { promise(): Promise<DocumentClient.PutItemOutput> };
      get(params: DocumentClient.GetItemInput): { promise(): Promise<DocumentClient.GetItemOutput> };
      query(params: DocumentClient.QueryInput): { promise(): Promise<DocumentClient.QueryOutput> };
    }
  }

  export namespace SQS {
    export interface SendMessageRequest {
      QueueUrl: string;
      MessageBody: string;
      MessageAttributes?: Record<string, { DataType: string; StringValue?: string }>;
    }
    export interface SendMessageResult {
      MessageId?: string;
      MD5OfMessageBody?: string;
    }
    export interface ReceiveMessageRequest {
      QueueUrl: string;
      MaxNumberOfMessages?: number;
      WaitTimeSeconds?: number;
    }
    export interface ReceiveMessageResult {
      Messages?: Array<{ MessageId?: string; Body?: string; ReceiptHandle?: string }>;
    }
  }

  export class SQS {
    constructor(options?: { region?: string; endpoint?: string });
    sendMessage(params: SQS.SendMessageRequest): { promise(): Promise<SQS.SendMessageResult> };
    receiveMessage(params: SQS.ReceiveMessageRequest): { promise(): Promise<SQS.ReceiveMessageResult> };
  }

  const AWS: {
    S3: typeof S3;
    DynamoDB: {
      DocumentClient: typeof DynamoDB.DocumentClient;
    };
    SQS: typeof SQS;
  };

  export default AWS;
}
