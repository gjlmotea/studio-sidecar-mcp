import { DarwinProcessInspector } from './adapters/darwin-process-inspector.js';
import { FetchOpenCloud } from './adapters/fetch-open-cloud.js';
import { FsSnapshotStore } from './adapters/fs-snapshot-store.js';
import { LocalStudioHost } from './adapters/local-studio-host.js';
import { McpStudioBridge } from './adapters/mcp-studio-bridge.js';
import { WindowsProcessInspector } from './adapters/windows-process-inspector.js';
import { RobloxService } from './application/roblox-service.js';
import type { ProcessInspector } from './ports/process-inspector.js';
import { StudioHostError } from './ports/studio-host.js';

export type CompositionOptions = {
  readonly apiKey?: string;
  readonly creatorUserId?: string;
  readonly studioPath?: string;
  readonly uploadRoots?: readonly string[];
  /** 測試用；正式執行時依 `process.platform` 挑。 */
  readonly inspector?: ProcessInspector;
};

/** Roblox Studio 只存在於 Windows 與 macOS，所以只實作這兩個平台。 */
export function createProcessInspector(platform: NodeJS.Platform = process.platform): ProcessInspector {
  switch (platform) {
    case 'win32':
      return new WindowsProcessInspector();
    case 'darwin':
      return new DarwinProcessInspector();
    default:
      throw new StudioHostError(
        `Roblox Studio does not support ${platform}; this server only implements Windows and macOS.`,
      );
  }
}

export function createRobloxService(version: string, options: CompositionOptions = {}): RobloxService {
  const inspector = options.inspector ?? createProcessInspector();
  const studio = new LocalStudioHost(inspector, options.studioPath);
  const openCloud = new FetchOpenCloud(
    options.apiKey === undefined ? {} : { apiKey: options.apiKey },
  );

  return new RobloxService({
    studio,
    openCloud,
    version,
    allowedUploadRoots: options.uploadRoots ?? [],
    bridge: new McpStudioBridge({ version }),
    snapshots: new FsSnapshotStore(),
    ...(options.creatorUserId === undefined ? {} : { defaultCreatorUserId: options.creatorUserId }),
  });
}
