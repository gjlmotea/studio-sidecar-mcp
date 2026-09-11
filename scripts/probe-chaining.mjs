// 驗證：一個 Node 行程能不能同時是 MCP server 又是別的 MCP server 的 client？
// 若可以，`extract_place` / `luau_safe` / `place_guard` 就不是架構上做不到，
// 而是還沒做。2026-08-30 實測通過：見 README〈還沒做的〉。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';

const before = Number(execSync('powershell -NoProfile -Command "@(Get-Process StudioMCP -EA SilentlyContinue).Count"').toString().trim());
console.log(`探測前 StudioMCP 行程數：${before}`);

const transport = new StdioClientTransport({
	command: 'cmd.exe',
	args: ['/c', `${process.env.LOCALAPPDATA}\\Roblox\\mcp.bat`],
	stderr: 'pipe',
	env: getDefaultEnvironment(),
});

const client = new Client({ name: 'chaining-probe', version: '0.0.0' });
const t0 = Date.now();
await client.connect(transport);
console.log(`✅ 握手成功（${Date.now() - t0} ms）—— 本行程同時是 client`);

try {
	const { tools } = await client.listTools();
	console.log(`✅ 取得工具面：${tools.length} 個`);

	const studios = await client.callTool({ name: 'list_roblox_studios', arguments: {} });
	const payload = JSON.parse(studios.content[0].text);
	console.log(`✅ list_roblox_studios → ${JSON.stringify(payload)}`);

	const target = payload.studios?.[0];
	if (!target) {
		console.log('⚠️ 沒有連線中的 Studio，跳過 execute_luau');
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
		console.log(`✅ execute_luau（唯讀）→ ${res.content[0].text}`);
		console.log('');
		console.log('🔴 結論：MCP server 完全可以當別的 MCP server 的 client。');
		console.log('   extract_place / luau_safe / place_guard 做得到，不是架構邊界。');
	}
} finally {
	await client.close();
	// 收尾：確認子行程有沒有跟著死，這關係到會不會製造新的 stub 洩漏。
	await new Promise((r) => setTimeout(r, 1500));
	const after = Number(execSync('powershell -NoProfile -Command "@(Get-Process StudioMCP -EA SilentlyContinue).Count"').toString().trim());
	console.log('');
	console.log(`探測後 StudioMCP 行程數：${after}（探測前 ${before}）`);
	console.log(after <= before ? '✅ 子行程已回收，不會製造 stub 洩漏' : '⚠️ 留下了 stub —— teardown 要自己收');
}
