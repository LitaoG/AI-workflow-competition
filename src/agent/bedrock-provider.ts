import * as crypto from 'node:crypto';
import { LLMMessage, LLMProvider, LLMRequest, LLMResponse, ProviderHealth } from '../types.js';
import { MockProvider } from './mock-provider.js';
import { AgentProviderError, ChatOptions, ChatResult, ProviderContract, redactServerText } from './provider-contract.js';
import { providerRegistry } from './provider.js';

export interface BedrockProviderOptions {
  modelId?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  fetchImpl?: typeof fetch;
}

export interface SigV4SignParams {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  datetime?: Date | string;
}

export interface SigV4SignResult {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  authorization: string;
  headers: Record<string, string>;
}

export function hmacSha256(key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

export function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Derives the AWS Signature Version 4 signing key.
 * kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, dateStamp), region), service), "aws4_request")
 */
export function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256('AWS4' + key, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

/**
 * Pure Node.js native AWS SigV4 request signer (zero external SDK dependencies).
 */
export function signSigV4(params: SigV4SignParams): SigV4SignResult {
  const urlObj = typeof params.url === 'string' ? new URL(params.url) : params.url;
  const amzDate = typeof params.datetime === 'string'
    ? params.datetime.replace(/[:-]|\.\d{3}/g, '')
    : (params.datetime ? params.datetime.toISOString().replace(/[:-]|\.\d{3}/g, '') : new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''));
  const dateStamp = amzDate.slice(0, 8);
  const payload = params.body ?? '';
  const payloadHash = sha256Hex(payload);

  const headersMap = new Map<string, string>();
  if (params.headers) {
    for (const [k, v] of Object.entries(params.headers)) {
      headersMap.set(k.toLowerCase().trim(), v.trim().replace(/\s+/g, ' '));
    }
  }

  if (!headersMap.has('host')) {
    headersMap.set('host', urlObj.host);
  }
  if (!headersMap.has('x-amz-date')) {
    headersMap.set('x-amz-date', amzDate);
  }
  if (params.service === 'bedrock' && !headersMap.has('x-amz-content-sha256')) {
    headersMap.set('x-amz-content-sha256', payloadHash);
  }
  if (params.sessionToken) {
    headersMap.set('x-amz-security-token', params.sessionToken);
  }

  const sortedHeaderKeys = Array.from(headersMap.keys()).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${headersMap.get(k)}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  // Canonical query string sorted by key and value
  const queryParams: [string, string][] = [];
  urlObj.searchParams.forEach((val, key) => {
    queryParams.push([encodeURIComponent(key), encodeURIComponent(val)]);
  });
  queryParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const canonicalQueryString = queryParams.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalUri = urlObj.pathname || '/';

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashedCanonicalRequest,
  ].join('\n');

  const signingKey = getSignatureKey(params.secretAccessKey, dateStamp, params.region, params.service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const finalHeaders: Record<string, string> = {};
  for (const [k, v] of headersMap.entries()) {
    finalHeaders[k] = v;
  }
  finalHeaders['authorization'] = authorization;

  return {
    canonicalRequest,
    stringToSign,
    signature,
    authorization,
    headers: finalHeaders,
  };
}

export class BedrockProvider implements LLMProvider, ProviderContract {
  readonly id = 'bedrock';
  readonly name = 'AWS Bedrock Claude 3.5 Sonnet';
  private modelId: string;
  private region: string;
  private accessKeyId?: string;
  private secretAccessKey?: string;
  private sessionToken?: string;
  private fetchImpl: typeof fetch;
  private fallbackMock = new MockProvider();

  constructor(options?: BedrockProviderOptions) {
    this.modelId = options?.modelId ?? process.env.BEDROCK_MODEL_ID ?? process.env.AWS_BEDROCK_MODEL ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    this.region = options?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    this.accessKeyId = options?.accessKeyId;
    this.secretAccessKey = options?.secretAccessKey;
    this.sessionToken = options?.sessionToken;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  private getCredentials(): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
    const accessKeyId = (this.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID)?.trim();
    const secretAccessKey = (this.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY)?.trim();
    const sessionToken = (this.sessionToken ?? process.env.AWS_SESSION_TOKEN)?.trim();

    if (!accessKeyId || !secretAccessKey) return undefined;
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
  }

  checkHealth(): ProviderHealth {
    const creds = this.getCredentials();
    return creds
      ? { ok: true, detail: `AWS credentials present (region ${this.region}, model ${this.modelId})` }
      : { ok: false, detail: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing — falls back to the offline mock' };
  }

  /**
   * Build the Bedrock InvokeModel payload (Anthropic Claude shape): system
   * prompt lifted to the top-level `system` field, conversation messages as
   * `{ role, content: [{ text }] }`. Extracted verbatim from `generate` so the
   * request shape is unit-testable without live credentials.
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
    const creds = this.getCredentials();

    if (!creds) {
      // Graceful offline fallback
      return await this.fallbackMock.generate(request);
    }

    if (request.signal?.aborted) {
      const err = new Error('ask cancelled');
      err.name = 'AbortError';
      throw err;
    }

    const startTime = Date.now();
    const payload = this.buildInvokeModelPayload(request);
    const bodyString = JSON.stringify(payload);

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const url = `https://${host}/model/${this.modelId}/invoke`;

    const signed = signSigV4({
      method: 'POST',
      url,
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-amz-content-sha256': sha256Hex(bodyString),
      },
      body: bodyString,
      service: 'bedrock',
      region: this.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: signed.headers,
        body: bodyString,
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      throw new AgentProviderError(
        this.id,
        `AWS Bedrock network/transport error: ${redactServerText(String(err), [creds.secretAccessKey, creds.accessKeyId, ...(creds.sessionToken ? [creds.sessionToken] : [])])}`,
        { retryable: true },
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const excerpt = redactServerText(errText, [
        creds.secretAccessKey,
        creds.accessKeyId,
        ...(creds.sessionToken ? [creds.sessionToken] : []),
      ]).slice(0, 300);
      throw new AgentProviderError(
        this.id,
        `AWS Bedrock InvokeModel error (HTTP ${response.status})${excerpt ? `: ${excerpt}` : ''}`,
        {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        },
      );
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new AgentProviderError(this.id, 'AWS Bedrock returned a non-JSON success response', { retryable: true });
    }

    const blocks = Array.isArray(json.content) ? json.content : [];
    const content = blocks
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('') || (typeof json.content?.[0]?.text === 'string' ? json.content[0].text : (typeof json.completion === 'string' ? json.completion : ''));

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;

    return {
      content,
      model: typeof json.model === 'string' ? json.model : this.modelId,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: Date.now() - startTime,
    };
  }

  async chat(messages: readonly LLMMessage[], options?: ChatOptions): Promise<ChatResult> {
    return await this.generate({
      messages: [...messages],
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      signal: options?.signal,
    });
  }

  async complete(prompt: string, options?: ChatOptions): Promise<string> {
    const res = await this.chat([{ role: 'user', content: prompt }], options);
    return res.content;
  }
}

/**
 * Detects AWS credentials and registers the `bedrock` provider in `providerRegistry`.
 */
export function configureBedrockFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return undefined;

  const provider = new BedrockProvider({
    region: env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || undefined,
    modelId: env.BEDROCK_MODEL_ID?.trim() || env.AWS_BEDROCK_MODEL?.trim() || undefined,
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
  });
  providerRegistry.register(provider);
  return provider.id;
}
