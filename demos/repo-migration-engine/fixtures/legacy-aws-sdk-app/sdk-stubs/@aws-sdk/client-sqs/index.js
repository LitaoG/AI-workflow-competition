export class SQSClient {
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

export class SendMessageCommand {
  constructor(params) {
    this.params = params;
  }
  async execute() {
    return {
      MessageId: 'msg-sqs-v3-001',
    };
  }
}

export class ReceiveMessageCommand {
  constructor(params) {
    this.params = params;
  }
  async execute() {
    return {
      Messages: [
        {
          MessageId: 'msg-sqs-v3-001',
          Body: JSON.stringify({ id: 'evt-01', event: 'OrderCreated', data: {} }),
        },
      ],
    };
  }
}

export class DeleteMessageCommand {
  constructor(params) {
    this.params = params;
  }
  async execute() {
    return {};
  }
}
