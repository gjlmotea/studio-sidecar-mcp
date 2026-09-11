import { z } from 'zod';

/**
 * 工具的輸入與輸出 schema。
 *
 * MCP SDK 的 `registerTool` 收的是 ZodRawShape（欄位物件），不是 `z.object(...)`。
 */

const assetType = z.enum(['Model', 'Decal', 'Audio']);

const idString = z
  .string()
  .regex(/^[0-9]+$/, '必須是十進位數字字串');

const assetRecord = z.object({
  assetId: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  assetType: z.string().optional(),
  revisionId: z.string().optional(),
  revisionCreateTime: z.string().optional(),
  creatorUserId: z.string().optional(),
  moderationState: z.string().optional(),
  state: z.string().optional(),
});

// ── 狀態 ───────────────────────────────────────────────────────────────

export const getStatusInputSchema = {};

export const statusOutputSchema = {
  version: z.string(),
  studioExecutable: z.string().optional(),
  openCloudConfigured: z.boolean(),
  allowedUploadRoots: z.array(z.string()),
  defaultCreatorConfigured: z.boolean(),
};

// ── Studio 行程 ────────────────────────────────────────────────────────

export const listStudiosInputSchema = {};

export const listStudiosOutputSchema = {
  brokerPort: z.number(),
  brokerPid: z.number().optional(),
  studios: z.array(
    z.object({
      pid: z.number(),
      startedAt: z.string().optional(),
      windowTitle: z.string().optional(),
      executablePath: z.string().optional(),
    }),
  ),
  mcpProcesses: z.array(
    z.object({
      pid: z.number(),
      startedAt: z.string().optional(),
      executablePath: z.string().optional(),
      role: z.enum(['broker', 'stub']),
      client: z.string().optional(),
    }),
  ),
};

export const openPlaceInputSchema = {
  placeId: idString.describe('目標 place 的 placeId，取自該專案 scene/place.json。'),
  universeId: idString.describe(
    'universe id，就是 scene/place.json 裡的 gameId（Roblox 在啟動參數裡叫它 universeid）。',
  ),
  waitMs: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .optional()
    .describe('等待新實例註冊到 broker 的上限，預設 180000。冷啟動加大型 place 下載會很久。'),
};

export const openPlaceOutputSchema = {
  pid: z.number(),
  connected: z
    .boolean()
    .describe('true 代表已註冊到 broker，可以用內建 MCP 的 list_roblox_studios 取得 studio_id。'),
  waitedMs: z.number(),
  windowTitle: z.string().optional(),
  commandLine: z.string().describe('實際下的命令列，供人工比對與排錯。'),
};

export const cleanupStubsInputSchema = {
  olderThanHours: z
    .number()
    .min(0)
    .max(720)
    .optional()
    .describe('只清超過這個時數的 stub，預設 12。門檻是為了不去碰可能還活著的 session。'),
  apply: z
    .boolean()
    .optional()
    .describe('預設 false＝只報告不動手。要真的終止行程才設 true。'),
};

export const cleanupStubsOutputSchema = {
  dryRun: z.boolean(),
  brokerPid: z.number().optional().describe('永遠不會被清除的那一隻。'),
  planned: z.array(
    z.object({
      pid: z.number(),
      startedAt: z.string().optional(),
      client: z.string().optional(),
    }),
  ),
  terminated: z.array(z.number()),
  failures: z.array(z.object({ pid: z.number(), reason: z.string() })),
};

// ── Open Cloud 資產 ────────────────────────────────────────────────────

export const getAssetInputSchema = {
  assetId: idString,
};

export const getAssetOutputSchema = { asset: assetRecord };

export const uploadAssetInputSchema = {
  filePath: z.string().describe('本機來源檔。必須位於 ROBLOX_UPLOAD_ROOT 允許的目錄內。'),
  displayName: z.string().min(1).describe('資產名稱。中文會被文字過濾器換成 #，建議用 ASCII。'),
  description: z.string().optional(),
  assetType: assetType.optional().describe('省略時依副檔名推斷。Model 只吃 .fbx。'),
  creatorUserId: idString.optional().describe('省略時用 ROBLOX_CREATOR_USER_ID。'),
};

export const uploadAssetOutputSchema = {
  asset: assetRecord,
  warning: z.string().optional(),
};

export const updateAssetInputSchema = {
  assetId: idString.describe('要就地更新的既有資產。'),
  filePath: z.string().describe('新內容的來源檔。必須位於 ROBLOX_UPLOAD_ROOT 允許的目錄內。'),
  assetType: assetType.optional(),
};

export const updateAssetOutputSchema = {
  asset: assetRecord,
  verdict: z
    .enum(['updated', 'deduplicated', 'indeterminate'])
    .describe(
      'updated＝revisionId 遞增，內容確實換了；deduplicated＝內容相同，Roblox 靜默跳過建立新版本；'
      + 'indeterminate＝拿不到 revisionId，需自行複查。',
    ),
  revisionBefore: z.string().optional(),
  revisionAfter: z.string().optional(),
  message: z.string(),
};

// ── 抽取 ───────────────────────────────────────────────────────────────

export const extractPlaceInputSchema = {
  placeId: idString.describe(
    '目標 place 的 placeId。會逐一詢問連線中的 Studio，找不到相符的就中止 —— 抽錯 place 會寫出張冠李戴的快照。',
  ),
  outDir: z.string().describe('輸出目錄。會寫出 src/**、scene/place.json、scene/scripts.json。'),
  chunkBytes: z
    .number()
    .int()
    .min(1_000)
    .max(99_000)
    .optional()
    .describe('每次取回的位元組數，預設 70000。execute_luau 單次回傳上限是 100000 字元。'),
};

export const extractPlaceOutputSchema = {
  placeId: z.string(),
  gameId: z.string(),
  studioName: z.string(),
  scriptCount: z.number(),
  totalBytes: z.number(),
  chunks: z.number(),
  written: z.array(z.string()),
};

export const placeGuardInputSchema = {
  placeId: idString.describe('期望的 placeId，取自該專案 scene/place.json。'),
};

export const placeGuardOutputSchema = {
  studioId: z.string().describe('相符的那個實例。把它帶進內建 MCP 的工具呼叫。'),
  studioName: z.string(),
  placeId: z.string(),
  gameId: z.string(),
};

export const luauSafeInputSchema = {
  placeId: idString.describe('目標 place。對不上就中止，不會執行任何程式碼。'),
  code: z.string().min(1).describe('要執行的 Luau。會被包在 pcall 裡，回傳值當作結果。'),
  chunkBytes: z
    .number()
    .int()
    .min(1_000)
    .max(99_000)
    .optional()
    .describe('分塊取回的位元組數，預設 70000。'),
};

export const luauSafeOutputSchema = {
  studioName: z.string(),
  ok: z.boolean().describe('false 代表使用者程式碼拋錯，錯誤訊息在 result。'),
  bytes: z.number(),
  chunks: z.number(),
  result: z.string(),
};

export const archiveAssetInputSchema = {
  assetId: idString,
  restore: z.boolean().optional().describe('true＝還原，false／省略＝封存。'),
};

export const archiveAssetOutputSchema = { asset: assetRecord };
