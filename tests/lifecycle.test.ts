import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { installShutdown, type CloseTarget } from '../src/lifecycle.js';

function harness(options: { readonly bridgeFails?: boolean } = {}) {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  const closed: string[] = [];
  const targets: CloseTarget[] = [
    {
      name: 'studio-bridge',
      close: async () => {
        closed.push('studio-bridge');
        if (options.bridgeFails === true) throw new Error('the StudioMCP child did not exit');
      },
    },
    {
      name: 'stdio',
      close: async () => {
        closed.push('stdio');
      },
    },
  ];
  const markFailed = vi.fn();
  const exit = vi.fn();
  const log = vi.fn();
  const lifecycle = installShutdown(
    { stdin, stdout, signals, markFailed, exit, log, forcedExitMs: 5 },
    targets,
  );
  return { stdin, stdout, signals, closed, markFailed, exit, lifecycle };
}

/** 比 forcedExitMs 久，讓關機流程與計時器都跑完。 */
const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 30));

describe('🔴 stdin 結束也要走關機流程並收 Studio 橋', () => {
  it('stdin end：橋與 stdio 各收一次，緊接的 close 不重跑，收乾淨就不強制結束', async () => {
    const h = harness();
    await h.lifecycle.startupComplete();
    h.stdin.emit('end');
    h.stdin.emit('close');
    await settle();
    expect(h.closed.sort()).toEqual(['stdio', 'studio-bridge']);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
    expect(h.stdin.listenerCount('end')).toBe(0);
  });

  it('只有 stdin close 也會關機', async () => {
    const h = harness();
    await h.lifecycle.startupComplete();
    h.stdin.emit('close');
    await settle();
    expect(h.closed).toContain('studio-bridge');
  });

  it('stdin error：標記失敗並關機，而不是讓例外炸掉行程留下 stub', async () => {
    const h = harness();
    await h.lifecycle.startupComplete();
    h.stdin.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
    await settle();
    expect(h.markFailed).toHaveBeenCalled();
    expect(h.closed).toContain('studio-bridge');
  });

  it('啟動期間 stdin 就結束：等啟動完成再收，並告訴呼叫端不要繼續', async () => {
    const h = harness();
    h.stdin.emit('end');
    await settle();
    expect(h.closed).toEqual([]);
    await expect(h.lifecycle.startupComplete()).resolves.toBe(false);
    expect(h.closed).toContain('studio-bridge');
  });

  it('有一個 close 失敗時其他照收、標記失敗，並保留強制結束', async () => {
    const h = harness({ bridgeFails: true });
    await h.lifecycle.startupComplete();
    h.signals.emit('SIGTERM');
    await settle();
    expect(h.closed).toContain('stdio');
    expect(h.markFailed).toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});
