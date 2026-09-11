import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

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
        '未設定 ROBLOX_API_KEY。需要 Creator Dashboard → Open Cloud API Keys 的 Asset read + write 權限。',
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
      throw new OpenCloudError(`回應不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, {
        status: response.status,
      });
    }
    if (!response.ok) {
      const body = parsed as { code?: string; message?: string; errors?: unknown };
      const detail = body.message ?? JSON.stringify(body.errors ?? body).slice(0, 300);
      throw new OpenCloudError(`Open Cloud ${response.status}：${detail}`, {
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
    if (id === undefined) throw new OpenCloudError('Open Cloud 沒有回 operationId，無法追蹤作業。');

    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      await this.#sleep(this.#intervalMs);
      const next = (await this.#send(`/operations/${encodeURIComponent(id)}`, { method: 'GET' })) as RawOperation;
      if (next.done === true) return this.#unwrap(next);
      if (Date.now() >= deadline) {
        throw new OpenCloudError(`作業 ${id} 在 ${this.#timeoutMs}ms 內未完成；稍後可用同一個 operationId 複查。`);
      }
    }
  }

  #unwrap(operation: RawOperation): AssetRecord {
    if (operation.error !== undefined) {
      throw new OpenCloudError(
        `作業失敗：${operation.error.message ?? '（無訊息）'}`,
        operation.error.code === undefined ? {} : { code: operation.error.code },
      );
    }
    if (operation.response === undefined) {
      throw new OpenCloudError('作業已完成但沒有回傳資產內容。');
    }
    return toRecord(operation.response);
  }

  async #multipart(filePath: string, contentType: string, request: object): Promise<FormData> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.set('request', JSON.stringify(request));
    form.set('fileContent', new Blob([new Uint8Array(bytes)], { type: contentType }), basename(filePath));
    return form;
  }

  async get(assetId: string): Promise<AssetRecord> {
    const raw = (await this.#send(`/assets/${encodeURIComponent(assetId)}`, { method: 'GET' })) as RawAsset;
    return toRecord(raw);
  }

  async create(request: UploadRequest): Promise<AssetRecord> {
    const { contentType } = resolveUpload(request.assetType, request.filePath);
    const form = await this.#multipart(request.filePath, contentType, {
      assetType: request.assetType,
      displayName: request.displayName,
      description: request.description,
      creationContext: { creator: { userId: request.creatorUserId } },
    });
    const operation = (await this.#send('/assets', { method: 'POST', body: form })) as RawOperation;
    return await this.#await(operation);
  }

  async updateContent(request: UpdateRequest): Promise<AssetRecord> {
    const { contentType } = resolveUpload(request.assetType, request.filePath);
    const form = await this.#multipart(request.filePath, contentType, { assetId: request.assetId });
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
      throw new OpenCloudError('displayName 與 description 至少要給一個。');
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
