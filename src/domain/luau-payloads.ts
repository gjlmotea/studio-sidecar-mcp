import { SENTINEL } from './extraction.js';

/**
 * 要送進 `execute_luau` 的 Luau 片段。
 *
 * 三條共通紀律：
 * - **全程唯讀**，不對 DataModel 做任何寫入。
 * - 結果放進 `shared.*`（Lua VM 的執行期記憶體，**不碰 DataModel、不進 .rbxl**），
 *   之後的切片呼叫就只剩兩行，不必每次重算。用完設回 `nil`。
 * - 每一段回傳都以哨兵收尾，讓呼叫端能辨識截斷。
 */

/** 存放抽取結果的 Lua 全域。用完要清掉。 */
const BUFFER = 'shared.RBXEXTRACT';

/** 走訪這些 service 底下的腳本。與 vibe/roblox 快照的目錄約定一致。 */
const SCRIPT_SERVICES = [
  'Workspace',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'ServerScriptService',
  'ServerStorage',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'SoundService',
  'Lighting',
  'TextChatService',
] as const;

/** 寫入前的 placeId 守衛。對不上就回報，不做任何事。 */
export function placeGuardLuau(expectedPlaceId: string): string {
  return `
local expected = ${expectedPlaceId}
local ok = game.PlaceId == expected
return string.format("placeId=%d expected=%d match=%s gameId=%d", game.PlaceId, expected,
	tostring(ok), game.GameId) .. "${SENTINEL}"`;
}

/**
 * 把所有腳本串成單一資料流放進 buffer。
 *
 * `#src` 在 Lua 數的是**位元組**，這正是呼叫端要拿來校驗的數字 ——
 * 用 JS 的 `String.length`（數字元）比會對不起來。
 */
export function buildScriptStreamLuau(): string {
  return `
local out, count = {}, 0
local function walk(inst, path)
	for _, child in ipairs(inst:GetChildren()) do
		local childPath = path .. "/" .. child.Name
		if child:IsA("LuaSourceContainer") then
			-- 受保護的容器可能讀不到 Source，個別跳過而不是整批中止。
			local ok, src = pcall(function() return child.Source end)
			if ok and type(src) == "string" then
				count += 1
				out[#out + 1] = string.format("<<<RBXFILE|%s|%s|%d>>>", childPath, child.ClassName, #src)
				out[#out + 1] = src
			end
		end
		walk(child, childPath)
	end
end
for _, name in ipairs({${SCRIPT_SERVICES.map((s) => `"${s}"`).join(', ')}}) do
	local ok, service = pcall(function() return game:GetService(name) end)
	if ok and service then walk(service, name) end
end
${BUFFER} = table.concat(out, "\\n")
return string.format("bytes=%d count=%d", #${BUFFER}, count) .. "${SENTINEL}"`;
}

/**
 * 取出 buffer 的一段。
 *
 * 🔴 **切點的 UTF-8 安全由 Lua 這邊決定並回報**（`<<<AT|實際結束位置>>>`），
 * 呼叫端拿它當下一段的起點。若改成兩邊各自算，只要有一邊的邊界調整邏輯不同步，
 * 就會漏掉或重複位元組，而且長度校驗要到最後才爆。
 */
export function sliceBufferLuau(start: number, maxBytes: number): string {
  return `
local s = ${BUFFER}
if type(s) ~= "string" then return "<<<AT|0>>>" .. "${SENTINEL}" end
local start = ${start}
local finish = math.min(start + ${maxBytes} - 1, #s)
-- 續接位元組是 0x80–0xBF。若切點的下一個位元組是續接位元組，代表切在字元中間，
-- 往前退到字元邊界。
while finish > start and finish < #s do
	local nextByte = string.byte(s, finish + 1)
	if nextByte and nextByte >= 128 and nextByte <= 191 then
		finish = finish - 1
	else
		break
	end
end
return string.format("<<<AT|%d>>>", finish) .. string.sub(s, start, finish) .. "${SENTINEL}"`;
}

/** 用完把 buffer 還給 Lua VM。 */
export function releaseBufferLuau(): string {
  return `${BUFFER} = nil return "released${SENTINEL}"`;
}

/**
 * 把使用者的 Luau 包起來執行，結果放進 buffer。
 *
 * 兩件內建版沒有替你做的事：
 * - **整段包 pcall** —— `execute_luau` 沒有 `RobloxScript` capability，碰到受保護屬性
 *   （例如 `Lighting.Technology`）會讓**整段中止**。包起來之後錯誤變成可讀的回傳值。
 * - **結果進 buffer 而不是直接回傳** —— 直接回傳超過 100,000 字元會被靜默截斷。
 *   放進 buffer 之後由呼叫端分塊取回，長度不再是限制。
 */
export function runUserLuau(code: string): string {
  return `
local ok, result = pcall(function()
${code}
end)
local text
if ok then
	text = type(result) == "string" and result or tostring(result)
else
	text = "!!LUAU_ERROR!! " .. tostring(result)
end
${BUFFER} = text
return string.format("ok=%s bytes=%d", tostring(ok), #text) .. "${SENTINEL}"`;
}

/** 使用者程式碼拋錯時，buffer 內容的前綴。 */
export const LUAU_ERROR_PREFIX = '!!LUAU_ERROR!! ';

/** 讀 place 層級設定，對應快照的 `scene/place.json`。 */
export function placeMetaLuau(): string {
  return `
local HttpService = game:GetService("HttpService")
local function safe(fn, fallback)
	local ok, value = pcall(fn)
	if ok then return value end
	return fallback
end
local ws, lighting = game:GetService("Workspace"), game:GetService("Lighting")
local meta = {
	placeName = game.Name,
	placeId = game.PlaceId,
	gameId = game.GameId,
	creatorId = safe(function() return game.CreatorId end, 0),
	creatorType = safe(function() return tostring(game.CreatorType) end, "Unknown"),
	workspace = {
		gravity = ws.Gravity,
		fallenPartsDestroyHeight = safe(function() return ws.FallenPartsDestroyHeight end, nil),
		streamingEnabled = safe(function() return ws.StreamingEnabled end, nil),
	},
	lighting = {
		brightness = lighting.Brightness,
		clockTime = lighting.ClockTime,
		fogEnd = lighting.FogEnd,
		globalShadows = lighting.GlobalShadows,
		-- Lighting.Technology 需要 RobloxScript capability，execute_luau 沒有 ——
		-- 不包 pcall 會讓整段中止。
		technology = safe(function() return tostring(lighting.Technology) end, nil),
	},
}
return HttpService:JSONEncode(meta) .. "${SENTINEL}"`;
}

/** 解析 `<<<AT|n>>>` 前綴，回傳實際結束位置與剩下的內容。 */
export function parseSliceHeader(text: string): { readonly endOffset: number; readonly body: string } {
  const match = /^<<<AT\|(\d+)>>>/.exec(text);
  if (!match) {
    throw new Error(`切片回應缺少 <<<AT|n>>> 前綴，收到：${JSON.stringify(text.slice(0, 60))}`);
  }
  const raw = match[1];
  return {
    endOffset: Number.parseInt(raw ?? '0', 10),
    body: text.slice(match[0].length),
  };
}
