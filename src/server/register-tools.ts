import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { RobloxService } from '../application/roblox-service.js';
import { ASSET_TYPE_RULES, type AssetType } from '../domain/asset-types.js';
import {
  archiveAssetInputSchema,
  archiveAssetOutputSchema,
  cleanupStubsInputSchema,
  cleanupStubsOutputSchema,
  extractPlaceInputSchema,
  extractPlaceOutputSchema,
  getAssetInputSchema,
  getAssetOutputSchema,
  getStatusInputSchema,
  listStudiosInputSchema,
  listStudiosOutputSchema,
  luauSafeInputSchema,
  luauSafeOutputSchema,
  placeGuardInputSchema,
  placeGuardOutputSchema,
  openPlaceInputSchema,
  openPlaceOutputSchema,
  statusOutputSchema,
  updateAssetInputSchema,
  updateAssetOutputSchema,
  uploadAssetInputSchema,
  uploadAssetOutputSchema,
} from './schemas.js';

type ToolDependencies = { readonly service: RobloxService };

function ok(payload: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload,
    isError: false,
  };
}

function fail(summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    isError: true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 拿掉值為 undefined 的欄位。
 *
 * 本專案開了 `exactOptionalPropertyTypes`，「不存在」與「存在但為 undefined」是兩件事；
 * 直接把 zod 的 `.optional()` 結果轉交會被型別系統擋下來。
 */
function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as { [K in keyof T]?: NonNullable<T[K]> };
}

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer, { service }: ToolDependencies): void {
  // ── 狀態 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'roblox_get_status',
    {
      title: 'Read Roblox companion status',
      description:
        'Report the resolved Studio executable, whether the Open Cloud key is ready, and the folders uploads are allowed from. Check this before doing anything else.',
      inputSchema: getStatusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: READ_ONLY,
    },
    () => {
      const status = service.status();
      return ok(
        { ...compact(status), allowedUploadRoots: status.allowedUploadRoots },
        [
          `Studio executable: ${status.studioExecutable ?? '(not resolved)'}`,
          `Open Cloud: ${status.openCloudConfigured ? 'key configured' : 'ROBLOX_API_KEY not set'}`,
          `Folders uploads are allowed from: ${status.allowedUploadRoots.length === 0 ? '(not set; every upload is refused)' : status.allowedUploadRoots.join(', ')}`,
        ].join('\n'),
      );
    },
  );

  // ── Studio 行程 ──────────────────────────────────────────────────────
  server.registerTool(
    'roblox_list_studios',
    {
      title: 'List Studio and StudioMCP processes',
      description:
        'List the local Roblox Studio processes and the StudioMCP broker and stubs. '
        + 'The built-in MCP cannot see this view: it lives inside one Studio process.',
      inputSchema: listStudiosInputSchema,
      outputSchema: listStudiosOutputSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const snapshot = await service.listStudios();
        const stubs = snapshot.mcpProcesses.filter((row) => row.role === 'stub').length;
        return ok(
          {
            brokerPort: snapshot.brokerPort,
            ...compact({ brokerPid: snapshot.brokerPid }),
            studios: snapshot.studios.map((row) => compact({ ...row })),
            mcpProcesses: snapshot.mcpProcesses.map((row) => ({ ...compact(row), role: row.role })),
          },
          `Studio processes: ${snapshot.studios.length}; StudioMCP broker: ${snapshot.brokerPid ?? '(not found)'}; stubs: ${stubs}.`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_open_place',
    {
      title: 'Open a given place',
      description:
        'Start a new Studio process that opens the given place, and wait until it registers with the MCP broker. '
        + 'The built-in MCP structurally cannot do this: it lives inside one Studio process and cannot spawn a sibling process. '
        + 'After it reports connected=true, use the built-in MCP\'s list_roblox_studios to get that instance\'s studio_id. '
        + 'Warning: this tool never touches window focus at any point; stealing focus can make a stray key press close the place that has just loaded.',
      inputSchema: openPlaceInputSchema,
      outputSchema: openPlaceOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.openPlace(
          compact({
            placeId: input.placeId,
            universeId: input.universeId,
            waitMs: input.waitMs,
          }) as { placeId: string; universeId: string; waitMs?: number },
        );
        const summary = result.connected
          ? `Opened and registered (pid ${result.pid}, waited ${Math.round(result.waitedMs / 1000)} s). `
            + 'Now use the built-in MCP\'s list_roblox_studios to get the studio_id.'
          : `Studio started (pid ${result.pid}) but did not register with the broker within ${Math.round(result.waitedMs / 1000)} s. `
            + `Window title "${result.windowTitle ?? '(unreadable)'}": if the title does not include the place name, `
            + 'the launch intent was not accepted.';
        return ok({ ...compact(result), commandLine: result.commandLine }, summary);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_cleanup_stubs',
    {
      title: 'Clean up leftover StudioMCP stubs',
      description:
        'MCP clients do not always reap their own StudioMCP stubs when they exit, so stubs pile up over time. '
        + 'This tool always excludes the broker (killing it drops every connection, Studio\'s own included), '
        + 'and gives up entirely when it cannot identify the broker. By default it only reports; to actually clean up you must pass apply=true explicitly.',
      inputSchema: cleanupStubsInputSchema,
      outputSchema: cleanupStubsOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.cleanupStubs(
          compact({ olderThanHours: input.olderThanHours, apply: input.apply }),
        );
        const summary = result.dryRun
          ? `${result.planned.length} stub(s) can be cleaned up (nothing done; broker ${result.brokerPid} excluded). Pass apply=true to do it.`
          : `Terminated ${result.terminated.length} stub(s), ${result.failures.length} failed (broker ${result.brokerPid} excluded).`;
        return ok(
          {
            dryRun: result.dryRun,
            ...compact({ brokerPid: result.brokerPid }),
            planned: result.planned.map((row) => compact({ ...row })),
            terminated: [...result.terminated],
            failures: result.failures.map((row) => ({ ...row })),
          },
          summary,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  // ── Studio 端執行 ────────────────────────────────────────────────────
  server.registerTool(
    'roblox_place_guard',
    {
      title: 'Confirm the target place before writing',
      description:
        'Ask each connected Studio in turn, report which one has a `game.PlaceId` equal to the value you want, and give its studio_id. '
        + 'IMPORTANT: **Run this before any write.** The built-in multi_edit writes by path; '
        + 'a wrong studio_id overwrites another game\'s source code directly, with no undo and no warning of any kind. '
        + 'Warning: `game.Name` is not reliable; in testing, a published place returned `Place1` when opened. Only placeId tells them apart.',
      inputSchema: placeGuardInputSchema,
      outputSchema: placeGuardOutputSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const result = await service.guardPlace(input.placeId);
        return ok(
          { ...result },
          `Match: ${result.studioName} is placeId ${result.placeId} (gameId ${result.gameId}).`
          + `\nstudio_id for subsequent calls: ${result.studioId}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_luau_safe',
    {
      title: 'Run Luau in a given place without truncation or whole-chunk aborts',
      description:
        'Run Luau in the Studio whose placeId matches. Compared with the built-in execute_luau, it adds three guard rails: '
        + '(1) **a mandatory placeId guard**: on a mismatch it aborts without running any code; '
        + '(2) **the whole chunk is wrapped in pcall**: execute_luau lacks the RobloxScript capability, so touching a protected property '
        + '(such as Lighting.Technology) aborts the whole chunk; wrapped, the error becomes a readable return value; '
        + '(3) **results are fetched from a buffer in chunks**, so they are not subject to the 100000-character limit and are never silently truncated. '
        + 'This is not a new way to run code: execute_luau is already in your hands, and this tool only adds guard rails.',
      inputSchema: luauSafeInputSchema,
      outputSchema: luauSafeOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.runLuau(
          compact({
            placeId: input.placeId,
            code: input.code,
            chunkBytes: input.chunkBytes,
          }) as { placeId: string; code: string; chunkBytes?: number },
        );
        const head = result.ok
          ? `Ran successfully in "${result.studioName}" (${result.bytes} bytes, ${result.chunks} chunk(s)).`
          : `The code threw an error while running in "${result.studioName}":`;
        return ok({ ...result }, `${head}\n${result.result}`);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  // ── 抽取 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'roblox_extract_place',
    {
      title: 'Extract a place into a diffable text snapshot',
      description:
        'Extract all of a place\'s scripts and its place settings as plain text into the output folder (src/**, scene/place.json, scene/scripts.json). '
        + '**Read-only throughout**: it never writes to the DataModel. '
        + 'This tool wraps up the whole chunking/sentinel/per-file byte-check machinery needed because a single execute_luau reply '
        + 'is capped at 100000 characters and silently truncated beyond that. If any chunk is missing its sentinel, the whole batch aborts, '
        + 'because a partially correct snapshot is more dangerous than a failed extraction (it looks like success). '
        + 'It first asks each connected Studio in turn to verify the placeId, and aborts on a mismatch.',
      inputSchema: extractPlaceInputSchema,
      outputSchema: extractPlaceOutputSchema,
      annotations: {
        readOnlyHint: false, // 對 Studio 唯讀，但會寫本機檔案
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.extractPlace(
          compact({
            placeId: input.placeId,
            outDir: input.outDir,
            chunkBytes: input.chunkBytes,
          }) as { placeId: string; outDir: string; chunkBytes?: number },
        );
        return ok(
          { ...result, written: [...result.written] },
          `Extracted ${result.scriptCount} script(s) from "${result.studioName}"`
          + ` (${result.totalBytes} bytes, fetched in ${result.chunks} chunk(s), per-file byte counts verified).`
          + `\nWrote ${result.written.length} file(s) to ${input.outDir}.`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  // ── Open Cloud 資產 ──────────────────────────────────────────────────
  server.registerTool(
    'roblox_get_asset',
    {
      title: 'Read asset status and its real author',
      description:
        'Return revisionId, moderationState, state and creatorUserId. '
        + 'creatorUserId is the **author**; the creatorId returned by the built-in MCP\'s search_asset is the **holder**, and the two differ. '
        + 'This is the only way to tell "what you uploaded" from "what you took from the Toolbox".',
      inputSchema: getAssetInputSchema,
      outputSchema: getAssetOutputSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const asset = await service.getAsset(input.assetId);
        return ok(
          { asset: compact({ ...asset }) },
          `${asset.displayName ?? asset.assetId} | ${asset.assetType ?? '?'} | revision ${asset.revisionId ?? '?'}`
          + ` | ${asset.moderationState ?? '?'} | ${asset.state ?? '?'} | author ${asset.creatorUserId ?? '?'}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_upload_asset',
    {
      title: 'Upload a local file as a new asset',
      description:
        'Create a new asset through Open Cloud assets/v1 (Model accepts .fbx only, Decal accepts common image formats, Audio accepts mp3/ogg). '
        + 'IMPORTANT: An uploaded Model cannot be deleted or archived on the platform; it can only be removed from your own inventory. '
        + 'So when iterating, use roblox_update_asset to update the existing assetId instead of creating a new asset each time. '
        + 'The source file must be inside a folder allowed by ROBLOX_UPLOAD_ROOT.',
      inputSchema: uploadAssetInputSchema,
      outputSchema: uploadAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const asset = await service.uploadAsset(
          compact({
            filePath: input.filePath,
            displayName: input.displayName,
            description: input.description,
            assetType: input.assetType as AssetType | undefined,
            creatorUserId: input.creatorUserId,
          }) as { filePath: string; displayName: string },
        );
        const caveat = asset.assetType === undefined
          ? undefined
          : ASSET_TYPE_RULES[asset.assetType as AssetType]?.caveat;
        return ok(
          { asset: compact({ ...asset }), ...compact({ warning: caveat }) },
          `Created assetId ${asset.assetId} (${asset.moderationState ?? '?'}).`
          + `${caveat === undefined ? '' : `\nWarning: ${caveat}`}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_update_asset',
    {
      title: 'Update the content of an existing asset in place',
      description:
        'Push new content to the same assetId (this is how the "Package rather than Model" strategy is implemented). '
        + 'IMPORTANT: When the content bytes are identical, Open Cloud **silently deduplicates**: HTTP 200, operation done, no error, but revisionId does not move. '
        + 'This tool automatically compares revisionId before and after the update and reports a verdict; do not use the HTTP status as the success criterion.',
      inputSchema: updateAssetInputSchema,
      outputSchema: updateAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const { asset, outcome } = await service.updateAsset(
          compact({
            assetId: input.assetId,
            filePath: input.filePath,
            assetType: input.assetType as AssetType | undefined,
          }) as { assetId: string; filePath: string },
        );
        return ok(
          {
            asset: compact({ ...asset }),
            verdict: outcome.verdict,
            ...compact({
              revisionBefore: outcome.revisionBefore,
              revisionAfter: outcome.revisionAfter,
            }),
            message: outcome.message,
          },
          outcome.message,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_archive_asset',
    {
      title: 'Archive or restore an asset',
      description:
        'Works only on **asset types that support archiving**. Model and Decal have never supported archiving; this tool blocks them up front and explains why, '
        + 'so you do not keep retrying a request that is bound to fail.',
      inputSchema: archiveAssetInputSchema,
      outputSchema: archiveAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const asset = await service.archiveAsset(input.assetId, input.restore === true);
        return ok(
          { asset: compact({ ...asset }) },
          `${input.restore === true ? 'Restored' : 'Archived'} ${asset.assetId}: state=${asset.state ?? '?'}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );
}
