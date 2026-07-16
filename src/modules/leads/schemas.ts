import { z } from 'zod'

/** Accepts repeated query params or a comma-separated list. */
const multiString = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined
    const parts = Array.isArray(value) ? value : value.split(',')
    const cleaned = parts.map((part) => part.trim()).filter(Boolean)
    return cleaned.length > 0 ? cleaned : undefined
  })

const boolString = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'))

/** Parse an ISO-8601 (or date-only) string into a Date. */
export const isoDate = z.string().transform((value, ctx) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid date: "${value}"` })
    return z.NEVER
  }
  return date
})

const score = z.coerce.number().int().min(0).max(10)

export const SORT_FIELDS = [
  'receivedAt',
  'leadScore',
  'fitScore',
  'urgencyScore',
  'expectedValue',
  'winProbability',
  'followUpDate',
  'name',
  'org',
  'stage',
  'lastTouchedAt',
  'createdAt',
] as const

export const listLeadsQuerySchema = z.object({
  stage: multiString,
  tier: multiString,
  inquiryType: multiString,
  source: multiString,
  ownerId: multiString,
  fitMin: score.optional(),
  fitMax: score.optional(),
  urgencyMin: score.optional(),
  urgencyMax: score.optional(),
  leadMin: score.optional(),
  leadMax: score.optional(),
  receivedFrom: isoDate.optional(),
  receivedTo: isoDate.optional(),
  followUpFrom: isoDate.optional(),
  followUpTo: isoDate.optional(),
  overdue: boolString,
  expectedMin: z.coerce.number().min(0).optional(),
  expectedMax: z.coerce.number().min(0).optional(),
  replySent: boolString,
  needsAttention: boolString,
  search: z.string().trim().max(200).optional(),
  /** Optional relation includes for list responses: "threads,timeline". */
  include: z
    .string()
    .optional()
    .transform((value) => {
      const parts = (value ?? '').split(',').map((part) => part.trim())
      return { threads: parts.includes('threads'), timeline: parts.includes('timeline') }
    }),
  sort: z.enum(SORT_FIELDS).default('receivedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
})

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>

export const createLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320),
    org: z.string().max(300).default(''),
    source: z.string().trim().min(1).max(100).default('Other'),
    inquiryType: z.string().trim().min(1).max(150).default('Other'),
    summary: z.string().max(10_000).default(''),
    fitScore: z.number().int().min(0).max(10).default(5),
    urgencyScore: z.number().int().min(0).max(10).default(5),
    leadScore: z.number().int().min(0).max(10).default(5),
    dealValueLow: z.number().min(0).default(0),
    dealValueHigh: z.number().min(0).default(0),
    estPayoutRaw: z.string().max(1000).default(''),
    estWork: z.string().max(1000).default(''),
    recommendedNextStep: z.string().max(5000).default(''),
    draftReply: z.string().max(50_000).default(''),
    fitReasons: z.array(z.string().max(1000)).max(100).default([]),
    riskFlags: z.array(z.string().max(1000)).max(100).default([]),
    inferredFields: z.array(z.string().max(200)).max(100).default([]),
    stage: z.string().trim().min(1).default('New'),
    ownerId: z.string().nullable().optional(),
    followUpDate: isoDate.nullable().optional(),
    notes: z.string().max(20_000).default(''),
    receivedAt: isoDate.optional(),
    replySent: z.boolean().default(false),
  })
  .strict()

export type CreateLeadInput = z.infer<typeof createLeadSchema>

/** The only fields a human may PATCH; everything else is AI- or computed-owned. */
export const SAFE_PATCH_FIELDS = [
  'stage',
  'ownerId',
  'followUpDate',
  'notes',
  'replySent',
  'winProbability',
] as const

export const patchLeadSchema = z.object({
  stage: z.string().trim().min(1).optional(),
  ownerId: z.string().nullable().optional(),
  followUpDate: isoDate.nullable().optional(),
  notes: z.string().max(20_000).optional(),
  replySent: z.boolean().optional(),
  winProbability: z.number().min(0).max(1).optional(),
})

export type PatchLeadInput = z.infer<typeof patchLeadSchema>
