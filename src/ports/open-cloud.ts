import type { AssetRecord, RenameRequest, UpdateRequest, UploadRequest } from '../domain/contracts.js';

/**
 * Roblox Open Cloud `assets/v1`。
 *
 * 這一層補的是內建 Studio MCP 完全沒有的能力：Studio 內的
 * `AssetService:CreateAssetAsync` 與 `CreateAssetVersionAsync` 目前一律拋
 * `not available yet`（功能未開放，不是權限問題），所以「用程式上傳與就地更新資產」
 * 只剩 Open Cloud 這一條路。
 */
export interface OpenCloud {
  /** 有沒有設定金鑰。沒有的話所有操作都應該明確拒絕而不是靜默失敗。 */
  readonly configured: boolean;

  get(assetId: string): Promise<AssetRecord>;

  create(request: UploadRequest): Promise<AssetRecord>;

  /** 換內容。⚠ 內容相同時 Roblox 會靜默去重 —— 用 revisionId 判定是否真的生效。 */
  updateContent(request: UpdateRequest): Promise<AssetRecord>;

  /** 只改中繼資料（displayName / description），走 updateMask。 */
  updateMetadata(request: RenameRequest): Promise<AssetRecord>;

  archive(assetId: string): Promise<AssetRecord>;

  restore(assetId: string): Promise<AssetRecord>;
}

export class OpenCloudError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'OpenCloudError';
    this.status = options.status;
    this.code = options.code;
  }
}
