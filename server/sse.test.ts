import { describe, it, expect, vi } from 'vitest';
import { SSEManager } from './sse.ts';

function makeClient(id = 'c1') {
  return {
    id,
    stream: {
      writeSSE: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

describe('SSEManager', () => {
  it('tracks client count', () => {
    const mgr = new SSEManager();
    expect(mgr.clientCount).toBe(0);

    mgr.addClient(makeClient('a'));
    expect(mgr.clientCount).toBe(1);

    mgr.addClient(makeClient('b'));
    expect(mgr.clientCount).toBe(2);

    mgr.removeClient('a');
    expect(mgr.clientCount).toBe(1);

    mgr.removeClient('b');
    expect(mgr.clientCount).toBe(0);
  });

  it('removing non-existent client is a no-op', () => {
    const mgr = new SSEManager();
    mgr.removeClient('nope');
    expect(mgr.clientCount).toBe(0);
  });

  it('broadcasts correctly formatted SSE message to all clients', () => {
    const mgr = new SSEManager();
    const c1 = makeClient('c1');
    const c2 = makeClient('c2');
    mgr.addClient(c1);
    mgr.addClient(c2);

    mgr.broadcast('task:created', { id: '123' });

    const expected = { event: 'task:created', data: '{"id":"123"}' };
    expect(c1.stream.writeSSE).toHaveBeenCalledWith(expected);
    expect(c2.stream.writeSSE).toHaveBeenCalledWith(expected);
  });

  it('silently removes clients that reject on write', async () => {
    const mgr = new SSEManager();
    const bad = makeClient('bad');
    bad.stream.writeSSE.mockRejectedValue(new Error('closed'));
    const good = makeClient('good');
    mgr.addClient(bad);
    mgr.addClient(good);

    mgr.broadcast('task:updated', { id: '1' });

    // Wait for the rejected promise to be handled
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.clientCount).toBe(1);
    expect(good.stream.writeSSE).toHaveBeenCalled();
  });
});
