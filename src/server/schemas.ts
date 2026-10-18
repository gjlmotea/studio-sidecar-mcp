import { z } from 'zod';

/**
 * 工具的輸入與輸出 schema。
 *
 * MCP SDK 的 `registerTool` 收的是 ZodRawShape（欄位物件），不是 `z.object(...)`。
 */

const assetType = z.enum(['Model', 'Decal', 'Audio']);

const idString = z
  .string()
  .regex(/^[0-9]+$/, 'must be a decimal digit string');

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
  placeId: idString.describe('placeId of the target place, taken from the project\'s scene/place.json.'),
  universeId: idString.describe(
    'Universe id: the gameId in scene/place.json (Roblox calls it universeid in the launch arguments).',
  ),
  waitMs: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .optional()
    .describe('Maximum time to wait for the new instance to register with the broker; default 180000. A cold start plus downloading a large place can take a long time.'),
};

export const openPlaceOutputSchema = {
  pid: z.number(),
  connected: z
    .boolean()
    .describe('true means it is registered with the broker, and the built-in MCP\'s list_roblox_studios can be used to get the studio_id.'),
  waitedMs: z.number(),
  windowTitle: z.string().optional(),
  commandLine: z.string().describe('The command line actually used, for manual comparison and troubleshooting.'),
};

export const cleanupStubsInputSchema = {
  olderThanHours: z
    .number()
    .min(0)
    .max(720)
    .optional()
    .describe('Only clean up stubs older than this many hours; default 12. The threshold keeps cleanup away from sessions that may still be alive.'),
  apply: z
    .boolean()
    .optional()
    .describe('Default false = report only, change nothing. Set true only to actually terminate processes.'),
};

export const cleanupStubsOutputSchema = {
  dryRun: z.boolean(),
  brokerPid: z.number().optional().describe('The one process that is never cleaned up.'),
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
  filePath: z.string().describe('Local source file. Must be inside a folder allowed by ROBLOX_UPLOAD_ROOT.'),
  displayName: z.string().min(1).describe('Asset name. Chinese text is replaced with # by the text filter; ASCII is recommended.'),
  description: z.string().optional(),
  assetType: assetType.optional().describe('Inferred from the file extension when omitted. Model accepts .fbx only.'),
  creatorUserId: idString.optional().describe('Uses ROBLOX_CREATOR_USER_ID when omitted.'),
};

export const uploadAssetOutputSchema = {
  asset: assetRecord,
  warning: z.string().optional(),
};

export const updateAssetInputSchema = {
  assetId: idString.describe('The existing asset to update in place.'),
  filePath: z.string().describe('Source file for the new content. Must be inside a folder allowed by ROBLOX_UPLOAD_ROOT.'),
  assetType: assetType.optional(),
};

export const updateAssetOutputSchema = {
  asset: assetRecord,
  verdict: z
    .enum(['updated', 'deduplicated', 'indeterminate'])
    .describe(
      'updated = revisionId increased, the content really changed; deduplicated = identical content, Roblox silently skipped creating a new version; '
      + 'indeterminate = revisionId could not be obtained, check it yourself.',
    ),
  revisionBefore: z.string().optional(),
  revisionAfter: z.string().optional(),
  message: z.string(),
};

// ── 抽取 ───────────────────────────────────────────────────────────────

export const extractPlaceInputSchema = {
  placeId: idString.describe(
    'placeId of the target place. Each connected Studio is asked in turn, and it aborts if none matches: extracting the wrong place would write a snapshot attributed to the wrong place.',
  ),
  outDir: z.string().describe('Output folder. Writes src/**, scene/place.json and scene/scripts.json.'),
  chunkBytes: z
    .number()
    .int()
    .min(1_000)
    .max(99_000)
    .optional()
    .describe('Bytes fetched per call; default 70000. A single execute_luau reply is capped at 100000 characters.'),
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
  placeId: idString.describe('The expected placeId, taken from the project\'s scene/place.json.'),
};

export const placeGuardOutputSchema = {
  studioId: z.string().describe('The matching instance. Pass it to the built-in MCP\'s tool calls.'),
  studioName: z.string(),
  placeId: z.string(),
  gameId: z.string(),
};

export const luauSafeInputSchema = {
  placeId: idString.describe('Target place. On a mismatch it aborts without running any code.'),
  code: z.string().min(1).describe('Luau to run. It is wrapped in pcall, and its return value becomes the result.'),
  chunkBytes: z
    .number()
    .int()
    .min(1_000)
    .max(99_000)
    .optional()
    .describe('Bytes per fetched chunk; default 70000.'),
};

export const luauSafeOutputSchema = {
  studioName: z.string(),
  ok: z.boolean().describe('false means the user code threw an error; the error message is in result.'),
  bytes: z.number(),
  chunks: z.number(),
  result: z.string(),
};

export const archiveAssetInputSchema = {
  assetId: idString,
  restore: z.boolean().optional().describe('true = restore; false or omitted = archive.'),
};

export const archiveAssetOutputSchema = { asset: assetRecord };
