import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { RobloxService } from '../application/roblox-service.js';
import { registerTools } from './register-tools.js';

export const SERVER_NAME = 'roblox-mcp';

/**
 * 單次 tools/call 引數的元素上限（陣列元素加物件成員），SDK 在 zod 驗證之前先數。
 * 每個工具的引數都是少數幾個純量，最多不到 10 個；1,000 留了充分餘裕。
 */
export const MAX_TOOL_INPUT_ELEMENTS = 1_000;

export function createMcpServer(options: {
  readonly service: RobloxService;
  readonly version: string;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions: [
        'This server is a companion layer for Roblox Studio\'s **built-in** MCP, not a replacement.',
        'For script reading and writing, scene queries, generate_mesh, screen_capture and playtesting, keep using the built-in tools. They are not here and will not be rebuilt here.',
        'It only adds what the built-in server structurally cannot do or does not have at all: opening a place that is not open yet and managing StudioMCP processes; guarding writes by PlaceId, running Luau so that a runtime error comes back as a readable result (the error still stops the rest of the chunk, and earlier changes are not rolled back), and extracting scripts past the 100k output limit; and uploading, updating and archiving assets through Open Cloud.',
        'To work on a place that is not open yet: call roblox_open_place first, wait for connected=true, then get the studio_id from the built-in MCP\'s list_roblox_studios.',
        'IMPORTANT: Verify the placeId before any write. A wrong studio_id overwrites another game\'s source code with no undo. game.Name is not reliable (in testing, a published place opened with game.Name returning Place1); only game.PlaceId is reliable.',
        'IMPORTANT: An uploaded Model cannot be deleted or archived on the platform; it can only be removed from your own inventory. So always iterate with roblox_update_asset on the existing assetId instead of calling roblox_upload_asset each time.',
        'IMPORTANT: The success criterion for roblox_update_asset is the verdict field, not the HTTP status: when the content bytes are identical, Open Cloud silently deduplicates, and the response looks completely normal but revisionId does not move (verdict=deduplicated).',
        'roblox_cleanup_stubs only reports by default; to actually terminate processes you must pass apply=true explicitly, and it never touches the broker.',
        'Luau runs only through the built-in execute_luau, and only after the placeId check: roblox_luau_safe runs the code you pass (which can change the place), and roblox_extract_place only reads. This server never touches window focus (stealing focus can make a stray key press close a place that has just loaded).',
      ].join('\n'),
    },
  );

  registerTools(server, { service: options.service });
  return server;
}
