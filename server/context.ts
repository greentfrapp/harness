import type { HarnessConfig } from '../shared/types.ts';
import type { SSEManager } from './sse.ts';
import type { TaskQueue } from './queue.ts';
import type * as queries from './db/queries.ts';

export interface AppContext {
  config: HarnessConfig;
  sseManager: SSEManager;
  taskQueue: TaskQueue;
  queries: typeof queries;
}
