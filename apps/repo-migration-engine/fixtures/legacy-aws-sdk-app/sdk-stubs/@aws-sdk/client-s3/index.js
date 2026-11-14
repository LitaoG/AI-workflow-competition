export class S3Client {
  constructor(options = {}) {
    this.region = options.region || 'us-east-1';
  }
  async send(command) {
    if (typeof command.execute === 'function') {
      return command.execute();
    }
    return {};
  }
}

export class PutObjectCommand {
  constructor(params) {
    this.params = params;
  }
  async execute() {
    return {
      Location: `https://${this.params.Bucket}.s3.amazonaws.com/${this.params.Key}`,
      Key: this.params.Key,
      ETag: '"etag-v3-123"',
    };
  }
}

export class GetObjectCommand {
  constructor(params) {
    this.params = params;
  }
  async execute() {
    return {
      Body: {
        transformToString: async (encoding = 'utf-8') => `Mock content for ${this.params.Key}`,
      },
    };
  }
}

export class ListObjectsV2Command {
  constructor(params) {
    this.params = params;
  }
  async execute() {
    return {
      Contents: [
        { Key: `${this.params.Prefix || ''}file1.txt` },
        { Key: `${this.params.Prefix || ''}file2.txt` },
      ],
    };
  }
}
