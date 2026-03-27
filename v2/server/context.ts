import type { HarnessConfig } from '../shared/types'
import type * as queries from './db/queries'

export interface CheckoutEntry {
  taskId: string
  checkoutBranch: string
}

export interface AppContext {
  config: HarnessConfig
  queries: typeof queries
  checkoutState: Map<string, CheckoutEntry>
}
