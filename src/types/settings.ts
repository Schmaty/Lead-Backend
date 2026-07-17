export interface WinProbabilityBand {
  /** Lowest leadScore (inclusive) this band applies to. */
  min: number
  /** Default win probability for the band, 0..1. */
  p: number
}

export interface WorkspaceSettings {
  tierThresholds: { hot: number; warm: number }
  winProbabilityMap: WinProbabilityBand[]
  stages: string[]
  closedStages: string[]
  wonStage: string
  lostStage: string
  sources: string[]
  inquiryTypes: string[]
  notificationThresholds: { hotLeadScore: number }
  scanSettings: { pollMinutes: number }
  staleDays: number
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  tierThresholds: { hot: 8, warm: 5 },
  winProbabilityMap: [
    { min: 9, p: 0.55 },
    { min: 7, p: 0.35 },
    { min: 5, p: 0.18 },
    { min: 3, p: 0.07 },
    { min: 0, p: 0.02 },
  ],
  stages: ['New', 'Contacted', 'Qualified', 'Proposal sent', 'Closed won', 'Closed lost', 'Not fit'],
  closedStages: ['Closed won', 'Closed lost', 'Not fit'],
  wonStage: 'Closed won',
  lostStage: 'Closed lost',
  sources: ['Website form', 'Email', 'Referral', 'Event', 'Other'],
  inquiryTypes: [
    'New project / hot lead',
    'Training request',
    'Workshop / speaking',
    'Consulting inquiry',
    'Partnership',
    'Vendor pitch',
    'Job inquiry',
    'Other',
  ],
  notificationThresholds: { hotLeadScore: 8 },
  scanSettings: { pollMinutes: 15 },
  staleDays: 5,
}

/** Merge stored workspace settings over defaults so missing keys never crash. */
export function resolveSettings(stored: unknown): WorkspaceSettings {
  const raw = (stored ?? {}) as Partial<WorkspaceSettings>
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    tierThresholds: { ...DEFAULT_SETTINGS.tierThresholds, ...(raw.tierThresholds ?? {}) },
    notificationThresholds: { ...DEFAULT_SETTINGS.notificationThresholds, ...(raw.notificationThresholds ?? {}) },
    scanSettings: { ...DEFAULT_SETTINGS.scanSettings, ...(raw.scanSettings ?? {}) },
    winProbabilityMap: raw.winProbabilityMap ?? DEFAULT_SETTINGS.winProbabilityMap,
    stages: raw.stages ?? DEFAULT_SETTINGS.stages,
    closedStages: raw.closedStages ?? DEFAULT_SETTINGS.closedStages,
    sources: raw.sources ?? DEFAULT_SETTINGS.sources,
    inquiryTypes: raw.inquiryTypes ?? DEFAULT_SETTINGS.inquiryTypes,
  }
}
