import type { HarnessConfig } from '../shared/types.ts';
import type { SSEManager } from './sse.ts';
import type { TaskQueue } from './queue.ts';
import type { AgentPool } from './pool.ts';
import type { Dispatcher } from './dispatcher.ts';
import type * as queries from './db/queries.ts';

export interface AppContext {
  config: HarnessConfig;
  sseManager: SSEManager;
  taskQueue: TaskQueue;
  pool: AgentPool;
  dispatcher: Dispatcher;
  queries: typeof queries;
}
