import { spawn } from 'node:child_process';

import { ProcessInspectorError } from '../ports/process-inspector.js';

export type RunResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * 跑一個外部命令並收回輸出。
 *
 * 不用 `exec`：那條路會過 shell，參數要自己跳脫，而本專案已經被引號吃掉過一次
 * （見 domain/launch-intent 的註解）。一律傳陣列。
 */
export async function run(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly allowFailure?: boolean } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProcessInspectorError(`${command} 逾時（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ProcessInspectorError(`${command} 啟動失敗：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // lsof 找不到符合條件的連線時回 1，那是正常結果不是錯誤。
      if (code === 0 || options.allowFailure === true) resolve({ code, stdout, stderr });
      else reject(new ProcessInspectorError(`${command} 結束碼 ${code}：${stderr.trim() || '（無輸出）'}`));
    });
  });
}
