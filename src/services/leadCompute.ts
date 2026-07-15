import type { WorkspaceSettings } from '../types/settings.js'

export type Tier = 'hot' | 'warm' | 'cold'

export function computeTier(leadScore: number, settings: WorkspaceSettings): Tier {
  if (leadScore >= settings.tierThresholds.hot) return 'hot'
  if (leadScore >= settings.tierThresholds.warm) return 'warm'
  return 'cold'
}

export function defaultWinProbability(leadScore: number, settings: WorkspaceSettings): number {
  const bands = [...settings.winProbabilityMap].sort((a, b) => b.min - a.min)
  for (const band of bands) {
    if (leadScore >= band.min) return band.p
  }
  return bands.length > 0 ? bands[bands.length - 1]!.p : 0
}

export function computeExpectedValue(dealValueLow: number, dealValueHigh: number, winProbability: number): number {
  return Math.round(((dealValueLow + dealValueHigh) / 2) * winProbability * 100) / 100
}

export interface ComputedLeadFields {
  tier: Tier
  winProbability: number
  expectedValue: number
}

/**
 * Compute tier / winProbability / expectedValue for a lead write.
 * A human-set winProbability override survives recomputation.
 */
export function applyComputed(
  input: {
    leadScore: number
    dealValueLow: number
    dealValueHigh: number
    winProbability?: number | null
    winProbabilityOverridden?: boolean
  },
  settings: WorkspaceSettings,
): ComputedLeadFields {
  const tier = computeTier(input.leadScore, settings)
  const winProbability =
    input.winProbabilityOverridden && input.winProbability != null
      ? input.winProbability
      : defaultWinProbability(input.leadScore, settings)
  return {
    tier,
    winProbability,
    expectedValue: computeExpectedValue(input.dealValueLow, input.dealValueHigh, winProbability),
  }
}
