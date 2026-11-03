import { LLMProvider, LLMRequest, LLMResponse } from '../types.js';
import { MockProvider } from './mock-provider.js';

export class BedrockProvider implements LLMProvider {
  readonly id = 'bedrock';
  readonly name = 'AWS Bedrock Claude 3.5 Sonnet';
  private modelId: string;
  private region: string;
  private fallbackMock = new MockProvider();

  constructor(options?: { modelId?: string; region?: string }) {
    this.modelId = options?.modelId ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    this.region = options?.region ?? process.env.AWS_REGION ?? 'us-east-1';
  }

  checkHealth(): { ok: boolean; detail: string } {
    const hasAwsCreds = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
    return hasAwsCreds
      ? { ok: true, detail: `AWS credentials present (region ${this.region}, model ${this.modelId})` }
      : { ok: false, detail: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing — falls back to the offline mock' };
  }

  /**
   * Build the Bedrock InvokeModel payload (Anthropic Claude shape): system
   * prompt lifted to the top-level `system` field, conversation messages as
   * `{ role, content: [{ text }] }`. Extracted verbatim from `generate` so the
   * request shape is unit-testable without the AWS SDK.
   */
  buildInvokeModelPayload(request: LLMRequest): Record<string, unknown> {
    const systemMessage = request.messages.find((m) => m.role === 'system')?.content;
    const conversationMessages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: [{ text: m.content }],
      }));

    return {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.0,
      system: systemMessage,
      messages: conversationMessages,
    };
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    // Check if AWS credentials exist
    const hasAwsCreds = Boolean(
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    );

    if (!hasAwsCreds) {
      // Graceful offline fallback
      return await this.fallbackMock.generate(request);
    }

    const startTime = Date.now();

    const payload = this.buildInvokeModelPayload(request);

    // Lazy load @aws-sdk/client-bedrock-runtime if available
    try {
      // @ts-ignore
      const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = new BedrockRuntimeClient({ region: this.region });

      const command = new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      });

      const response = await client.send(command);
      const decoded = new TextDecoder().decode(response.body);
      const json = JSON.parse(decoded);

      const content = json.content?.[0]?.text ?? '';
      return {
        content,
        model: this.modelId,
        usage: {
          promptTokens: json.usage?.input_tokens ?? 0,
          completionTokens: json.usage?.output_tokens ?? 0,
          totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
        },
        latencyMs: Date.now() - startTime,
      };
    } catch {
      // Degrade safely to mock provider
      return await this.fallbackMock.generate(request);
    }
  }
}
