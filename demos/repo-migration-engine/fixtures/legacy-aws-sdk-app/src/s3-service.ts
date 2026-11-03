import AWS from 'aws-sdk';

export interface S3UploadResult {
  location: string;
  key: string;
}

export class S3Service {
  private s3: AWS.S3;

  constructor(client?: AWS.S3) {
    this.s3 = client ?? new AWS.S3({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  async uploadFile(bucket: string, key: string, content: string | Buffer): Promise<S3UploadResult> {
    const res = await this.s3.upload({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: 'text/plain',
    }).promise();

    return {
      location: res.Location,
      key: res.Key,
    };
  }

  async downloadFile(bucket: string, key: string): Promise<string> {
    const res = await this.s3.getObject({
      Bucket: bucket,
      Key: key,
    }).promise();

    return res.Body ? res.Body.toString('utf-8') : '';
  }

  async listFiles(bucket: string, prefix?: string): Promise<string[]> {
    const res = await this.s3.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
    }).promise();

    return (res.Contents || []).map((item) => item.Key || '').filter(Boolean);
  }
}
