export class DynamoDBClient {
  constructor(options = {}) {
    this.region = options.region || 'us-east-1';
  }
}
