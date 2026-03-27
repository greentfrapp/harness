import type { HarnessConfig } from '../shared/types'
import type * as queries from './db/queries'
import type { Dispatcher } from './dispatcher'
import type { AgentPool } from './pool'
import type { TaskQueue } from './queue'
import type { SSEManager } from './sse'

export interface CheckoutEntry {
  taskId: string
  checkoutBranch: string
}

export interface AppContext {
  config: HarnessConfig
  sseManager: SSEManager
  taskQueue: TaskQueue
  pool: AgentPool
  dispatcher: Dispatcher
  queries: typeof queries
  checkoutState: Map<string, CheckoutEntry>
}
