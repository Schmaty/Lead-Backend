export type Role = 'OWNER' | 'ADMIN' | 'MEMBER'

export interface UserInfo {
  id: string
  name: string
  email: string
  role: Role
  developer?: boolean
  lastLoginAt: string | null
}

export interface WinBand {
  min: number
  p: number
}

export interface Settings {
  tierThresholds: { hot: number; warm: number }
  winProbabilityMap: WinBand[]
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

export interface Thread {
  id: string
  subject: string
  url: string
  direction: 'in' | 'out'
  date: string
  snippet: string
}

export interface TimelineEvent {
  id: string
  type: string
  at: string
  actor: string
  detail: string
}

export interface Lead {
  id: string
  externalId: string | null
  receivedAt: string
  name: string
  email: string
  org: string
  source: string
  inquiryType: string
  summary: string
  fitScore: number
  urgencyScore: number
  leadScore: number
  tier: 'hot' | 'warm' | 'cold'
  dealValueLow: number
  dealValueHigh: number
  estPayoutRaw: string
  winProbability: number
  winProbabilityOverridden: boolean
  expectedValue: number
  estWork: string
  recommendedNextStep: string
  draftReply: string
  fitReasons: string[]
  riskFlags: string[]
  inferredFields: string[]
  stage: string
  ownerId: string | null
  owner?: { id: string; name: string } | null
  followUpDate: string | null
  replySent: boolean
  lastTouchedAt: string
  notes: string
  createdAt: string
  updatedAt: string
  threads?: Thread[]
  timeline?: TimelineEvent[]
  timeInStageHours?: number
}

export interface Aggregates {
  total: number
  countByStage: Record<string, number>
  countByTier: Record<string, number>
  pipelineExpectedValue: number
  wonCount: number
  wonValue: number
  overdueCount: number
  unassignedCount: number
  needsAttentionCount: number
}

export interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  settings: Settings
  users: UserInfo[]
}

export interface SessionUser {
  id: string
  name: string
  email: string
  role: Role
  /** True for the allowlisted platform developer account. */
  developer?: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface CredentialRow {
  kind: string
  maskedValue: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface Filters {
  stages: string[]
  tiers: string[]
  types: string[]
  sources: string[]
  owners: string[]
  fitMin: number
  fitMax: number
  urgMin: number
  urgMax: number
  leadMin: number
  leadMax: number
  evMin: string
  evMax: string
  recvFrom: string
  recvTo: string
  followFrom: string
  followTo: string
  overdueOnly: boolean
  replySent: 'any' | 'yes' | 'no'
  needsAttention: boolean
}

export const defaultFilters = (): Filters => ({
  stages: [],
  tiers: [],
  types: [],
  sources: [],
  owners: [],
  fitMin: 0,
  fitMax: 10,
  urgMin: 0,
  urgMax: 10,
  leadMin: 0,
  leadMax: 10,
  evMin: '',
  evMax: '',
  recvFrom: '',
  recvTo: '',
  followFrom: '',
  followTo: '',
  overdueOnly: false,
  replySent: 'any',
  needsAttention: false,
})

export type SortCol =
  | 'received'
  | 'name'
  | 'org'
  | 'type'
  | 'tier'
  | 'fit'
  | 'urgency'
  | 'lead'
  | 'ev'
  | 'stage'
  | 'owner'
  | 'follow_up'
  | 'last'

export interface SortState {
  col: SortCol
  dir: 'asc' | 'desc'
}

export type ColumnKey = SortCol
export type Columns = Record<ColumnKey, boolean>

export const defaultColumns = (): Columns => ({
  received: true,
  name: true,
  org: true,
  type: false,
  tier: true,
  fit: true,
  urgency: true,
  lead: true,
  ev: true,
  stage: true,
  owner: true,
  follow_up: true,
  last: false,
})

export interface ScanResult {
  at: string
  scanned: number
  imported: number
  updated: number
  skipped: number
  errors: string[]
}

export interface ScanProgress {
  phase: 'connecting' | 'scoring'
  total: number
  processed: number
  imported: number
  updated: number
  skipped: number
}

export interface ScanStatus {
  configured: boolean
  method: 'oauth' | 'imap' | null
  email: string | null
  googleSignInAvailable: boolean
  aiReady: boolean
  running: boolean
  progress: ScanProgress | null
  lastScanAt: string | null
  pollMinutes: number
  lastResult: ScanResult | null
  lastError: string | null
}
