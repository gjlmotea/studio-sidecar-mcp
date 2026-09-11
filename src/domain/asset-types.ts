/**
 * Open Cloud `assets/v1` 接受的資產型別與檔案格式。
 *
 * 這一層之所以存在，是因為 Open Cloud 對格式的限制比一般認知窄很多，
 * 而錯誤格式要等到輪詢 operation 才會知道 —— 先在本機擋掉比較省事。
 */

export const ASSET_TYPES = ['Model', 'Decal', 'Audio'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export type AssetTypeRule = {
  /** 可接受的副檔名（小寫，含點）。 */
  readonly extensions: readonly string[];
  /** multipart 的 `fileContent` 用的 Content-Type。 */
  readonly contentType: string;
  /** 能不能用 `:archive` / `:restore`。 */
  readonly archivable: boolean;
  /** 能不能用 PATCH 換內容。 */
  readonly contentUpdatable: boolean;
  /** 需要讓呼叫端知道的額外限制。 */
  readonly caveat?: string;
};

export const ASSET_TYPE_RULES: Readonly<Record<AssetType, AssetTypeRule>> = {
  // 2026-08-30 實測：上傳來的 Model 在 Studio 裡自帶 PackageLink，本身就是 Package。
  Model: {
    extensions: ['.fbx'],
    contentType: 'model/fbx',
    // `:archive` 對 Model 回 INVALID_ARGUMENT「not an archivable asset type」。
    archivable: false,
    contentUpdatable: true,
    caveat:
      'Model 只吃 .fbx。上傳後無法封存也無法從平台刪除（只能從自己的物品欄移除），'
      + '所以請更新既有 assetId 而不是每次建立新的。',
  },
  Decal: {
    extensions: ['.bmp', '.jpeg', '.jpg', '.png', '.tga'],
    contentType: 'image/png',
    archivable: false,
    contentUpdatable: true,
  },
  Audio: {
    extensions: ['.mp3', '.ogg'],
    contentType: 'audio/mpeg',
    archivable: true,
    // 官方文件明列 Audio「not available for updating」。
    contentUpdatable: false,
    caveat:
      'Audio 有配額：長度上限 7 分鐘，ID 驗證帳號每月 100 次、未驗證每月 10 次，且只能新建不能更新。',
  },
};

export class AssetTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetTypeError';
  }
}

function extensionOf(filePath: string): string {
  const index = filePath.lastIndexOf('.');
  return index === -1 ? '' : filePath.slice(index).toLowerCase();
}

/** 依副檔名推斷資產型別；推不出來回 undefined，由呼叫端決定要不要報錯。 */
export function inferAssetType(filePath: string): AssetType | undefined {
  const extension = extensionOf(filePath);
  return ASSET_TYPES.find((type) => ASSET_TYPE_RULES[type].extensions.includes(extension));
}

/** 檢查檔案副檔名合不合這個資產型別，並回傳該用的 Content-Type。 */
export function resolveUpload(assetType: AssetType, filePath: string): { readonly contentType: string } {
  const rule = ASSET_TYPE_RULES[assetType];
  const extension = extensionOf(filePath);
  if (!rule.extensions.includes(extension)) {
    throw new AssetTypeError(
      `${assetType} 只接受 ${rule.extensions.join(' / ')}，收到 ${extension === '' ? '（無副檔名）' : extension}。`,
    );
  }
  // Decal 涵蓋數種影像格式，Content-Type 要跟著副檔名走。
  if (assetType === 'Decal') {
    const map: Readonly<Record<string, string>> = {
      '.bmp': 'image/bmp',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.png': 'image/png',
      '.tga': 'image/tga',
    };
    return { contentType: map[extension] ?? rule.contentType };
  }
  if (assetType === 'Audio' && extension === '.ogg') {
    return { contentType: 'audio/ogg' };
  }
  return { contentType: rule.contentType };
}

/** 這個型別能不能封存。Model 不行，且錯誤訊息要說得夠清楚，別讓呼叫端一直重試。 */
export function assertArchivable(assetType: AssetType): void {
  if (!ASSET_TYPE_RULES[assetType].archivable) {
    throw new AssetTypeError(
      `${assetType} 不是可封存的型別，Open Cloud 會回 INVALID_ARGUMENT。`
      + '（Model 可以從物品欄移除，但那走 inventory 端點且需要登入 session，不在本 server 範圍。）',
    );
  }
}
