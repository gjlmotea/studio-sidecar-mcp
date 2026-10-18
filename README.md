# Studio Sidecar — companion MCP server for Roblox Studio

**English** | [繁體中文](README.zh-TW.md)

![Studio Sidecar: a companion MCP server for Roblox Studio](assets/social-preview.png)

**Studio Sidecar fills the gaps in Roblox Studio's built-in MCP server. It does not replace it.**

Since 2026, Roblox Studio ships its own MCP server (`StudioMCP`, installed with Studio, stdio transport), and the standalone [`Roblox/studio-rust-mcp-server`](https://github.com/Roblox/studio-rust-mcp-server) repository has been archived. The built-in server has tools that no third party can rebuild: `generate_mesh`, `generate_material` and `generate_procedural_model` use Roblox's cloud AI with moderation; `search_asset`, `insert_asset` and `upload_image` carry your signed-in inventory permissions; `user_keyboard_input` and `user_mouse_input` go through `CreateVirtualInput`. Replacing it would throw all of that away.

So Studio Sidecar adds only what the built-in server structurally cannot do, and leaves everything else to it:

- **Open a place that is not open yet**, and see every Studio process and StudioMCP broker/stub on the machine.
- **Guard writes by PlaceId**, run Luau without one protected property aborting the whole chunk, and **extract scripts past the 100k output limit** with byte-exact verification.
- **Upload, update and archive assets through Roblox Open Cloud**, with an explicit verdict when an update was silently deduplicated.

No Studio plugin is needed. 11 tools; Windows fully verified, macOS partly (see [Platform support](#platform-support)).

## Contents

- [Tools](#tools)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [What the tools know that the built-in server does not tell you](#what-the-tools-know-that-the-built-in-server-does-not-tell-you)
- [Platform support](#platform-support)
- [Boundaries](#boundaries)
- [Development](#development)
- [License and trademarks](#license-and-trademarks)

## Tools

| Tool | Why the built-in server cannot do it |
|---|---|
| `roblox_get_status` | Shows whether Open Cloud is configured and which folders uploads may read from |
| `roblox_list_studios` | The built-in server lives inside one Studio process; it cannot see other Studio processes or the StudioMCP broker/stub structure |
| `roblox_open_place` | Opening a place that is not open yet is an operating-system job: it needs a new sibling process |
| `roblox_cleanup_stubs` | Same reason; reports by default and only terminates stubs with `apply=true`, never the broker |
| `roblox_place_guard` | The built-in `multi_edit` writes by path, and a wrong `studio_id` silently overwrites another game with no undo or warning |
| `roblox_luau_safe` | The built-in `execute_luau` aborts the whole chunk on a protected property and silently truncates output beyond 100k characters |
| `roblox_extract_place` | There is no tool that handles the 100k truncation boundary: chunking, sentinels and per-file byte checks are left to the caller, and getting them wrong does not raise an error |
| `roblox_get_asset` | The built-in `search_asset` reports the holder as `creatorId`, not the author |
| `roblox_upload_asset` | `AssetService:CreateAssetAsync` inside Studio currently always throws `not available yet` |
| `roblox_update_asset` | `CreateAssetVersionAsync` is unavailable in the same way |
| `roblox_archive_asset` | The built-in server has no Open Cloud surface |

**Deliberately not included**: script reading and writing, scene queries, `execute_luau`, `screen_capture`, playtesting. The built-in server already has them, and a second implementation would only drift.

### How Luau runs on the Studio side

An MCP process can be a server and a client at the same time. Studio Sidecar starts `StudioMCP` as its own child process and connects to it as an MCP client, which gives it the built-in `execute_luau`. The chunking, sentinel and byte-check machinery is then wrapped into single tools. When the client closes normally, the child process goes away too, so this route does not leak stubs.

## Quick start

Requirements: Roblox Studio with its MCP server enabled (Studio → **Assistant Settings**), and Node.js 22 or newer.

Register Studio Sidecar with your AI client. Claude Code:

```bash
claude mcp add roblox-companion --scope user \
  -e ROBLOX_API_KEY="<your Open Cloud API key>" \
  -e ROBLOX_CREATOR_USER_ID="<your Roblox user ID>" \
  -e ROBLOX_UPLOAD_ROOT="<folder that uploads may read from>" \
  -- npx -y @gjlmotea/studio-sidecar-mcp
```

Any client that uses a JSON config:

```json
{
  "mcpServers": {
    "roblox-companion": {
      "command": "npx",
      "args": ["-y", "@gjlmotea/studio-sidecar-mcp"],
      "env": {
        "ROBLOX_API_KEY": "<your Open Cloud API key>",
        "ROBLOX_CREATOR_USER_ID": "<your Roblox user ID>",
        "ROBLOX_UPLOAD_ROOT": "<folder that uploads may read from>"
      }
    }
  }
}
```

All three variables are optional: without the key the four Open Cloud tools refuse, without `ROBLOX_UPLOAD_ROOT` every upload is refused, and the other tools work as usual. **Do not put the key in any config file that is tracked by version control.**

Register Studio's built-in MCP server as well; script editing, screenshots and playtesting live there. On macOS the executable has a fixed path:

```bash
claude mcp add roblox-studio --scope user -- /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
```

On Windows, `StudioMCP.exe` lives in `%LOCALAPPDATA%\Roblox\Versions\version-<hash>\`, and the folder changes with every Studio update, so a hard-coded path breaks on the next update. Register a small launcher that resolves the path at start-up instead, using absolute paths for both `node` and the launcher.

Restart the session after registering, then call `roblox_get_status` and check `openCloudConfigured` and `allowedUploadRoots`.

Desktop apps started from Finder or the Start menu often do not see your shell's `PATH`; if the server does not start, use the absolute path of `npx` (or of `node` when running from source).

### Running from source

```bash
git clone https://github.com/gjlmotea/studio-sidecar-mcp.git
cd studio-sidecar-mcp
corepack pnpm install --frozen-lockfile
corepack pnpm run build
claude mcp add roblox-companion --scope user -- "$(which node)" "$PWD/dist/index.js"
```

Prefer `claude mcp add` with absolute paths over a hand-written `.mcp.json`: `${CLAUDE_PROJECT_DIR}` is not expanded there and nothing reports it (the server just fails to connect), relative paths follow the directory the client was started in, and project-scope servers need an interactive approval that never appears in non-interactive sessions.

## Configuration

| Variable | Purpose |
|---|---|
| `ROBLOX_API_KEY` | Open Cloud API key with Asset **read and write** (Creator Dashboard → Open Cloud API Keys) |
| `ROBLOX_CREATOR_USER_ID` | Creator recorded in `creationContext` when uploading |
| `ROBLOX_UPLOAD_ROOT` | **Folders uploads may read from** (several allowed, separated by the platform's path separator). **When unset, every upload is refused** |
| `ROBLOX_STUDIO_PATH` | Studio executable; resolved automatically from the current installation when unset |

`ROBLOX_UPLOAD_ROOT` is a deliberate guard rail: uploading sends a local file to an external service, and for Models it cannot be undone, so the MCP client may not pick arbitrary file paths.

## What the tools know that the built-in server does not tell you

Each of these was found on real hardware and has a regression test.

**Launch intent quoting fails silently.** Studio expects `-launchIntentString "{\"task\":\"EditPlace\",\"universeid\":\"…\",\"placeid\":\"…\"}"`. Unescaped quotes are eaten by the Windows command-line parser, Studio receives broken JSON, ignores the intent and opens an empty session with no error. The only clue is a window title of `Roblox Studio` instead of `<place name> - Roblox Studio`. Studio Sidecar passes arguments to `spawn` as an array and makes the `CommandLineToArgvW` rules testable. `universeid` is the `gameId` in `scene/place.json`.

**Never steal window focus.** Two seconds after `SetForegroundWindow`, a stray key press in Studio closed the place that had just loaded. `roblox_open_place` only polls the broker connection and process titles.

**The broker must not be killed, and its identity moves.** StudioMCP is one broker plus one stub per client; the first one listens on `127.0.0.1:13469`, and Studio itself and every stub connect to it. Killing the broker drops every connection, Studio's included. The broker role also moves to a different process over time, so the broker is always identified as "whoever listens on 13469", never by a remembered PID. `roblox_cleanup_stubs` gives up when it cannot identify the broker. Stubs pile up because some clients do not reap them on exit (see [openai/codex#25893](https://github.com/openai/codex/issues/25893)); an age threshold keeps cleanup away from sessions that may still be alive.

**An update succeeds by `revisionId`, not by HTTP status.** PATCHing an asset with byte-identical content returns `HTTP 200`, `done: true` and no error, but `revisionId` does not move: the content was deduplicated. `roblox_update_asset` compares `revisionId` before and after and reports `updated`, `deduplicated` or `indeterminate`. A higher `revisionId` still does not guarantee that Studio sees the new content; Studio-side caching is outside what Open Cloud can confirm. To replace content, do not send `updateMask` (`updateMask=fileContent` fails with `Unknown field file_content`); it is only for metadata changes.

**The 100k truncation belongs to StudioMCP itself.** Measured directly against StudioMCP: a 100,000-character reply arrives whole; a 120,000-character one stops at 100,015 characters ending in `... (truncated)`. No client can lift it. `roblox_extract_place` therefore uses three safeguards, all required:

1. A sentinel at the end of every chunk; a chunk without it counts as incomplete. Length alone cannot tell a complete reply from a truncated one.
2. The UTF-8-safe cut point is decided in Lua and reported back, and the caller continues from there, so the two sides never compute boundaries separately.
3. A byte-count check per file (`Buffer.byteLength`, not `String.length`). Any mismatch aborts the whole extraction, because a partially correct snapshot looks like success.

The data is staged in `shared.RBXEXTRACT` (Lua VM memory only, never the DataModel or the `.rbxl`) and cleared afterwards. Instance names can be almost anything, including `..` and path separators, so every path segment is sanitized and the final path is checked to be inside the output folder before writing.

**The Studio bridge must live as long as the server.** Closing it after every call makes the first call succeed and every later one fail with "Unable to reach Roblox Studio right now", which sounds like Studio is closed. It is not: closing kills the stub, and the next call races the broker. The same message also appears during a cold start before a fresh stub reaches the broker, so the bridge retries that one message, and only that one, for up to 20 seconds with exponential backoff.

**Open Cloud formats are narrow.** Models accept `.fbx` only; Decals accept bmp, jpeg, png and tga; Audio accepts mp3 and ogg and can only be created, not updated, under a monthly quota. Wrong formats would only fail after polling the operation, so they are rejected locally. Models and Decals have never supported archiving, and `roblox_archive_asset` says so up front.

## Platform support

| | Windows | macOS |
|---|:---:|:---:|
| Open a given place | ✅ verified | ✅ implemented, **not verified on hardware** |
| Process and broker inspection | ✅ verified (PowerShell) | ✅ verified (`ps` + `lsof`) |
| Stub cleanup | ✅ verified | ✅ implemented, **not verified on hardware** |
| Window titles | ✅ | ❌ always `undefined` (needs Accessibility permission) |
| Open Cloud tools | ✅ | ✅ (plain HTTP) |

Platform differences sit behind `ports/process-inspector.ts`; broker detection, stub classification and cleanup are shared. Linux is refused explicitly rather than returning an empty snapshot, because Roblox Studio does not run there and an empty answer would read as "no Studio running".

## Boundaries

- **No window focus changes.** Stealing focus can make a stray key close a freshly loaded place.
- **`roblox_luau_safe` is not a new way to run arbitrary code.** `execute_luau` is already in the client's hands; this tool adds a mandatory PlaceId guard, a whole-chunk `pcall` and chunked results in front of the same entry point. It is not a sandbox.
- **No reverse engineering of the broker's private protocol on 13469.** Talking to `StudioMCP` as an ordinary MCP client makes that unnecessary.
- **No "remove from inventory".** That goes through `inventory.roblox.com` with a signed-in session cookie and CSRF token, which an Open Cloud API key cannot do.
- **Messages are in Traditional Chinese for now.** Tool descriptions, server instructions and error messages are written in Traditional Chinese. AI models read them without trouble; English messages are planned.

## Development

```bash
corepack pnpm install
corepack pnpm run verify          # typecheck, tests, build, stdio smoke
corepack pnpm run verify:live     # read-only checks against real Studio and a real account
corepack pnpm run verify:extract  # end to end: open_place → place_guard → luau_safe → extract_place
```

`verify:live` only performs read-only operations: no uploads, updates, opened places or terminated processes. Its Open Cloud part needs `ROBLOX_API_KEY` and an asset ID (`node scripts/verify-live.mjs <assetId>`) and is skipped otherwise.

`verify:extract` needs `ROBLOX_VERIFY_PLACE_ID`, `ROBLOX_VERIFY_UNIVERSE_ID` (a place you own) and `ROBLOX_VERIFY_BASELINE` (a hand-made, byte-verified script snapshot). It opens a Studio instance and compares the extracted scripts byte for byte against the snapshot. The steps are chained on purpose, because the bridge lifetime bug only shows up across several consecutive tool calls.

## License and trademarks

[MIT](LICENSE).

Studio Sidecar is an independent open-source project, not affiliated with or endorsed by Roblox Corporation. Roblox, Roblox Studio and Luau are trademarks of Roblox Corporation.
