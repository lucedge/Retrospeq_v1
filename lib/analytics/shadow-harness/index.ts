export type {
  Uuid,
  ShadowRunRecord,
  ShadowRunRow,
  ShadowComputeResult,
  ShadowAnalytic,
} from './types';

export type { EligibleTradeFact } from './eligible-trade';
export { isEligibleTrade, filterEligibleTrades } from './eligible-trade';

export { runShadowAnalytic, runShadowAnalyticBatch, ShadowComputeError } from './runner';
export type { ShadowBatchResult } from './runner';

export {
  createSupabaseShadowRunRepository,
  ShadowHarnessNotConfiguredError,
} from './repository';
export type { ShadowRunRepository } from './repository';

export { evaluateShadowToBetaPromotion, countDistinctAccounts } from './promotion';
export type { ShadowToBetaEligibility } from './promotion';
