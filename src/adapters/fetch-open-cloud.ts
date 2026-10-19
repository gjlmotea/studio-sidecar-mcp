import { resolveUpload } from '../domain/asset-types.js';
import type { AssetRecord, RenameRequest, UpdateRequest, UploadRequest } from '../domain/contracts.js';
import { OpenCloudError, type OpenCloud } from '../ports/open-cloud.js';

const BASE = 'https://apis.roblox.com/assets/v1';

type RawAsset = {
  readonly assetId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly assetType?: string;
  readonly revisionId?: string;
  readonly revisionCreateTime?: string;
  readonly creationContext?: { readonly creator?: { readonly userId?: string } };
  readonly moderationResult?: { readonly moderationState?: string };
  readonly state?: string;
};

type RawOperation = {
  readonly operationId?: string;
  readonly done?: boolean;
  readonly response?: RawAsset;
  readonly error?: { readonly code?: string; readonly message?: string };
};

function toRecord(raw: RawAsset): AssetRecord {
  return {
    assetId: raw.assetId ?? '',
    displayName: raw.displayName,
    description: raw.description,
    assetType: raw.assetType,
    revisionId: raw.revisionId,
    revisionCreateTime: raw.revisionCreateTime,
    creatorUserId: raw.creationContext?.creator?.userId,
    moderationState: raw.moderationResult?.moderationState,
    state: raw.state,
  };
}

export type FetchOpenCloudOptions = {
  readonly apiKey?: string;
  /** 輪詢 operation 的上限；實測建立與更新約 4–8 秒完成。 */
  readonly operationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
};

export class FetchOpenCloud implements OpenCloud {
  readonly configured: boolean;

  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #intervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: FetchOpenCloudOptions = {}) {
    this.#apiKey = options.apiKey;
    this.configured = options.apiKey !== undefined && options.apiKey !== '';
    this.#timeoutMs = options.operationTimeoutMs ?? 120_000;
    this.#intervalMs = options.pollIntervalMs ?? 3_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  #key(): string {
    if (this.#apiKey === undefined || this.#apiKey === '') {
      throw new OpenCloudError(
        'ROBLOX_API_KEY is not set. It needs Asset read + write permission from Creator Dashboard → Open Cloud API Keys.',
      );
    }
    return this.#apiKey;
  }

  async #send(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-api-key': this.#key() },
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new OpenCloudError(`Response is not JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, {
        status: response.status,
      });
    }
    if (!response.ok) {
      const body = parsed as { code?: string; message?: string; errors?: unknown };
      const detail = body.message ?? JSON.stringify(body.errors ?? body).slice(0, 300);
      throw new OpenCloudError(`Open Cloud ${response.status}: ${detail}`, {
        status: response.status,
        ...(body.code === undefined ? {} : { code: body.code }),
      });
    }
    return parsed;
  }

  /** 建立與更新都是非同步作業，一律回 operation；要輪詢到 done 才拿得到資產。 */
  async #await(operation: RawOperation): Promise<AssetRecord> {
    if (operation.done === true) return this.#unwrap(operation);
    const id = operation.operationId;
    if (id === undefined) throw new OpenCloudError('Open Cloud returned no operationId, so the operation cannot be tracked.');

    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      await this.#sleep(this.#intervalMs);
      const next = (await this.#send(`/operations/${encodeURIComponent(id)}`, { method: 'GET' })) as RawOperation;
      if (next.done === true) return this.#unwrap(next);
      if (Date.now() >= deadline) {
        throw new OpenCloudError(`Operation ${id} did not finish within ${this.#timeoutMs}ms; check it again later with the same operationId.`);
      }
    }
  }

  #unwrap(operation: RawOperation): AssetRecord {
    if (operation.error !== undefined) {
      throw new OpenCloudError(
        `Operation failed: ${operation.error.message ?? '(no message)'}`,
        operation.error.code === undefined ? {} : { code: operation.error.code },
      );
    }
    if (operation.response === undefined) {
      throw new OpenCloudError('The operation finished but returned no asset.');
    }
    return toRecord(operation.response);
  }

  /** 內容由呼叫端給：這一層不碰檔案系統，送出去的就是服務層驗過、讀好的那份位元組。 */
  #multipart(fileName: string, content: Uint8Array, contentType: string, request: object): FormData {
    const form = new FormData();
    form.set('request', JSON.stringify(request));
    form.set('fileContent', new Blob([new Uint8Array(content)], { type: contentType }), fileName);
    return form;
  }

  async get(assetId: string): Promise<AssetRecord> {
    const raw = (await this.#send(`/assets/${encodeURIComponent(assetId)}`, { method: 'GET' })) as RawAsset;
    return toRecord(raw);
  }

  async create(request: UploadRequest): Promise<AssetRecord> {
    const { contentType } = resolveUpload(request.assetType, request.fileName);
    const form = this.#multipart(request.fileName, request.content, contentType, {
      assetType: request.assetType,
      displayName: request.displayName,
      description: request.description,
      creationContext: { creator: { userId: request.creatorUserId } },
    });
    const operation = (await this.#send('/assets', { method: 'POST', body: form })) as RawOperation;
    return await this.#await(operation);
  }

  async updateContent(request: UpdateRequest): Promise<AssetRecord> {
    const { contentType } = resolveUpload(request.assetType, request.fileName);
    const form = this.#multipart(request.fileName, request.content, contentType, { assetId: request.assetId });
    // ⚠ 換內容**不要**帶 updateMask：`updateMask=fileContent` 會回
    // `INVALID_ARGUMENT — Unknown field file_content`。
    const operation = (await this.#send(`/assets/${encodeURIComponent(request.assetId)}`, {
      method: 'PATCH',
      body: form,
    })) as RawOperation;
    return await this.#await(operation);
  }

  async updateMetadata(request: RenameRequest): Promise<AssetRecord> {
    const fields: string[] = [];
    const payload: Record<string, unknown> = { assetId: request.assetId };
    if (request.displayName !== undefined) {
      fields.push('displayName');
      payload['displayName'] = request.displayName;
    }
    if (request.description !== undefined) {
      fields.push('description');
      payload['description'] = request.description;
    }
    if (fields.length === 0) {
      throw new OpenCloudError('Provide at least one of displayName and description.');
    }
    const form = new FormData();
    form.set('request', JSON.stringify(payload));
    const operation = (await this.#send(
      `/assets/${encodeURIComponent(request.assetId)}?updateMask=${fields.join(',')}`,
      { method: 'PATCH', body: form },
    )) as RawOperation;
    return await this.#await(operation);
  }

  async archive(assetId: string): Promise<AssetRecord> {
    const raw = (await this.#send(`/assets/${encodeURIComponent(assetId)}:archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })) as RawAsset;
    return toRecord(raw);
  }

  async restore(assetId: string): Promise<AssetRecord> {
    const raw = (await this.#send(`/assets/${encodeURIComponent(assetId)}:restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })) as RawAsset;
    return toRecord(raw);
  }
}
