import AWS from 'aws-sdk';

export interface MessagePayload {
  id: string;
  event: string;
  data: unknown;
}

export class SQSService {
  private sqs: AWS.SQS;

  constructor(client?: AWS.SQS) {
    this.sqs = client ?? new AWS.SQS({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  async publishEvent(queueUrl: string, payload: MessagePayload): Promise<string> {
    const res = await this.sqs.sendMessage({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
      MessageAttributes: {
        EventType: {
          DataType: 'String',
          StringValue: payload.event,
        },
      },
    }).promise();

    return res.MessageId || '';
  }

  async pollMessages(queueUrl: string, maxMessages = 10): Promise<Array<{ id: string; body: string }>> {
    const res = await this.sqs.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 2,
    }).promise();

    return (res.Messages || []).map((m) => ({
      id: m.MessageId || '',
      body: m.Body || '',
    }));
  }
}
