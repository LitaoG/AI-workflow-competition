class S3 {
  constructor(options = {}) {}
  upload(params) {
    return {
      promise: async () => ({
        Location: `https://${params.Bucket}.s3.amazonaws.com/${params.Key}`,
        ETag: '"etag-123"',
        Bucket: params.Bucket,
        Key: params.Key,
      }),
    };
  }
  getObject(params) {
    return {
      promise: async () => ({
        Body: {
          toString: (encoding = 'utf-8') => `Mock content for ${params.Key}`,
        },
      }),
    };
  }
  listObjectsV2(params) {
    return {
      promise: async () => ({
        Contents: [
          { Key: `${params.Prefix || ''}file1.txt` },
          { Key: `${params.Prefix || ''}file2.txt` },
        ],
      }),
    };
  }
}

class DocumentClient {
  constructor(options = {}) {}
  put(params) {
    return { promise: async () => ({}) };
  }
  get(params) {
    return { promise: async () => ({ Item: { id: 'item-1' } }) };
  }
  query(params) {
    return { promise: async () => ({ Items: [{ id: 'item-1' }] }) };
  }
}

class SQS {
  constructor(options = {}) {}
  sendMessage(params) {
    return { promise: async () => ({ MessageId: 'msg-mock-123' }) };
  }
  receiveMessage(params) {
    return { promise: async () => ({ Messages: [{ MessageId: 'msg-mock-123', Body: 'mock body' }] }) };
  }
}

const AWS = {
  S3,
  DynamoDB: {
    DocumentClient,
  },
  SQS,
};

export default AWS;
export { S3, DocumentClient, SQS };
