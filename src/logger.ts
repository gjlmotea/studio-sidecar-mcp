type LogLevel = 'info' | 'error';

/** MCP 走 stdio，stdout 屬於協定；診斷一律走 stderr。 */
export function log(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  process.stderr.write(`[roblox-mcp] ${level}: ${message}${suffix}\n`);
}
