// 驗證：一個 Node 行程能不能同時是 MCP server 又是別的 MCP server 的 client？
// 若可以，`extract_place` / `luau_safe` / `place_guard` 就不是架構上做不到，
// 而是還沒做。2026-08-30 實測通過：見 README〈還沒做的〉。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';

const before = Number(execSync('powershell -NoProfile -Command "@(Get-Process StudioMCP -EA SilentlyContinue).Count"').toString().trim());
console.log(`StudioMCP processes before the probe: ${before}`);

const transport = new StdioClientTransport({
	command: 'cmd.exe',
	args: ['/c', `${process.env.LOCALAPPDATA}\\Roblox\\mcp.bat`],
	stderr: 'pipe',
	env: getDefaultEnvironment(),
});

const client = new Client({ name: 'chaining-probe', version: '0.0.0' });
const t0 = Date.now();
await client.connect(transport);
console.log(`✅ Handshake succeeded (${Date.now() - t0} ms): this process is also a client`);

try {
	const { tools } = await client.listTools();
	console.log(`✅ Tool surface: ${tools.length} tools`);

	const studios = await client.callTool({ name: 'list_roblox_studios', arguments: {} });
	const payload = JSON.parse(studios.content[0].text);
	console.log(`✅ list_roblox_studios → ${JSON.stringify(payload)}`);

	const target = payload.studios?.[0];
	if (!target) {
		console.log('⚠️ No Studio is connected; skipping execute_luau');
	} else {
		// 唯讀：只讀 placeId 與計數，不寫入任何東西。
		const res = await client.callTool({
			name: 'execute_luau',
			arguments: {
				studio_id: target.id,
				datamodel_type: 'Edit',
				code: 'local n = 0 for _ in pairs(game:GetService("Workspace"):GetChildren()) do n += 1 end '
					+ 'return string.format("placeId=%d name=%s workspaceChildren=%d", game.PlaceId, game.Name, n)',
			},
		});
		console.log(`✅ execute_luau (read-only) → ${res.content[0].text}`);
		console.log('');
		console.log('🔴 Conclusion: an MCP server can also act as a client of another MCP server.');
		console.log('   extract_place / luau_safe / place_guard can be built; this is not an architectural limit.');
	}
} finally {
	await client.close();
	// 收尾：確認子行程有沒有跟著死，這關係到會不會製造新的 stub 洩漏。
	await new Promise((r) => setTimeout(r, 1500));
	const after = Number(execSync('powershell -NoProfile -Command "@(Get-Process StudioMCP -EA SilentlyContinue).Count"').toString().trim());
	console.log('');
	console.log(`StudioMCP processes after the probe: ${after} (before: ${before})`);
	console.log(after <= before ? '✅ Child process was reaped; no stub leaked' : '⚠️ A stub was left behind; teardown has to clean it up');
}
