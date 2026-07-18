/**
 * Demo seed: "Fieldstone Training Group" workspace with 3 users and 34 leads.
 * All people, companies and email addresses are 100% fictional (.example domains).
 *
 * Run:      npx tsx prisma/seed.ts                      (needs DATABASE_URL)
 * Dev DB:   npx tsx scripts/dev-db.ts -- npx tsx prisma/seed.ts
 *
 * Idempotent: workspace is upserted by slug, users by email, leads by the
 * (workspaceId, externalId) compound unique. Threads and timeline events are
 * deleted and recreated per lead on every run, so re-running never duplicates.
 */
import { PrismaClient, type Prisma } from '@prisma/client'
import { DEFAULT_SETTINGS } from '../src/types/settings.js'
import { hashPassword } from '../src/crypto/hashing.js'
import { applyComputed } from '../src/services/leadCompute.js'

const prisma = new PrismaClient()

const DAY = 24 * 60 * 60 * 1000
const now = new Date()
const daysAgo = (d: number): Date => new Date(now.getTime() - d * DAY)
const daysFromNow = (d: number): Date => new Date(now.getTime() + d * DAY)
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue

const USERS = [
  { key: 'avery', name: 'Avery Fieldstone', email: 'owner@fieldstone-demo.example', password: 'FieldstoneDemo#2026', role: 'OWNER' },
  { key: 'jordan', name: 'Jordan Reyes', email: 'jordan@fieldstone-demo.example', password: 'JordanDemo#2026', role: 'MEMBER' },
  { key: 'sam', name: 'Sam Whitaker', email: 'sam@fieldstone-demo.example', password: 'SamDemo#2026', role: 'MEMBER' },
] as const
type OwnerKey = (typeof USERS)[number]['key']

interface LeadDef {
  n: string; e: string; o: string; src: string; iq: string; subj: string; sum: string
  fit: number; urg: number; score: number
  low?: number; high?: number; payout?: string; work?: string
  next?: string; draft?: string
  reasons?: string[]; risks?: string[]; inf?: string[]
  stage: string; owner: OwnerKey | null; days: number
  /** followUpDate as days relative to now (negative = overdue). */
  follow?: number
  reply?: boolean; notes?: string
}

/** How each lead walked the pipeline, for stage_change timeline events. */
const STAGE_PATHS: Record<string, string[]> = {
  'New': ['New'],
  'Contacted': ['New', 'Contacted'],
  'Qualified': ['New', 'Contacted', 'Qualified'],
  'Proposal sent': ['New', 'Contacted', 'Qualified', 'Proposal sent'],
  'Closed won': ['New', 'Contacted', 'Qualified', 'Proposal sent', 'Closed won'],
  'Closed lost': ['New', 'Contacted', 'Qualified', 'Closed lost'],
  'Not fit': ['New', 'Not fit'],
}

const LEADS: LeadDef[] = [
  // ---- New (7) ----
  { n: 'Dana Okafor', e: 'dana@northwind-logistics.example', o: 'Northwind Logistics', src: 'Website form',
    iq: 'New project / hot lead', subj: 'AI rollout for our ops team',
    sum: 'VP Ops wants an AI adoption program for a 40-person operations team, kickoff next month.',
    fit: 9, urg: 8, score: 9, low: 8000, high: 15000, payout: '$8,000–15,000 — 40-seat ops rollout, clear budget',
    work: '2-day workshop + 4 weeks coaching', next: 'Reply within 24h and offer a scoping call',
    draft: 'Hi Dana — happy to walk you through our 40-seat rollout format. Does Thursday work for a 25-min call?',
    reasons: ['Decision-maker (VP)', 'Budget allocated', 'Named kickoff window'], risks: ['Exact dates unconfirmed'],
    inf: ['dealValueLow', 'dealValueHigh'], stage: 'New', owner: null, days: 1 },
  { n: 'Priya Raman', e: 'priya@bluefin-analytics.example', o: 'Bluefin Analytics', src: 'Email',
    iq: 'Training request', subj: 'Prompt engineering training for analysts',
    sum: 'Head of Data asking for a hands-on prompt engineering course for 15 analysts.',
    fit: 7, urg: 6, score: 7, low: 6000, high: 9000, payout: '$6,000–9,000 — 15-seat analyst cohort',
    work: '1-day workshop + follow-up lab', next: 'Send curriculum outline and pricing tiers',
    draft: 'Hi Priya — our analyst track covers prompting, evals and tooling. Outline attached; happy to tailor it.',
    reasons: ['Specific team and headcount', 'Technical audience'], risks: ['No stated deadline'],
    inf: ['dealValueHigh'], stage: 'New', owner: 'avery', days: 2, follow: 2 },
  { n: 'Marcus Bell', e: 'marcus.bell@harborlight-health.example', o: 'Harborlight Health', src: 'Referral',
    iq: 'Consulting inquiry', subj: 'AI governance advice (referred by a client)',
    sum: 'Referred COO wants advisory on safe AI use policies across three clinics.',
    fit: 8, urg: 7, score: 8, low: 10000, high: 18000, payout: '$10,000–18,000 — multi-site advisory engagement',
    work: 'Assessment + policy sprint (3–4 weeks)', next: 'Assign an owner and book intro call this week',
    draft: 'Hi Marcus — thanks for the referral intro. We run a 3-week policy sprint for healthcare teams; call this week?',
    reasons: ['Warm referral', 'Regulated industry urgency'], risks: ['Compliance review may slow start'],
    inf: ['dealValueLow', 'dealValueHigh'], stage: 'New', owner: null, days: 3 },
  { n: 'Elena Voss', e: 'elena@copperleaf-design.example', o: 'Copperleaf Design', src: 'Website form',
    iq: 'Workshop / speaking', subj: 'Speaker for our design offsite',
    sum: 'Creative director wants a 90-minute AI-for-designers talk at a June offsite.',
    fit: 5, urg: 4, score: 5, low: 2500, high: 4000, payout: '$2,500–4,000 — single keynote + Q&A',
    work: 'Half-day incl. prep', next: 'Confirm date availability and send speaking kit',
    draft: 'Hi Elena — the offsite talk sounds fun. Sharing our speaking kit; which June dates are you holding?',
    reasons: ['Clear event scope'], risks: ['Small budget', 'One-off engagement'],
    inf: ['dealValueLow'], stage: 'New', owner: 'jordan', days: 5, follow: 5 },
  { n: 'Tomás Rivera', e: 'tomas@sierra-freight.example', o: 'Sierra Freight Co.', src: 'Event',
    iq: 'Training request', subj: 'Follow-up from the logistics expo booth',
    sum: 'Ops manager we met at the expo wants AI basics training for dispatch staff.',
    fit: 6, urg: 5, score: 6, low: 5000, high: 8000, payout: '$5,000–8,000 — dispatch team basics course',
    work: '1-day on-site workshop', next: 'Send expo follow-up email with course menu',
    draft: 'Hi Tomás — great meeting you at the expo. Here is the dispatch-team course menu we discussed.',
    reasons: ['Met in person', 'Operational pain point named'], risks: ['Budget owner not yet involved'],
    inf: ['dealValueLow', 'dealValueHigh'], stage: 'New', owner: null, days: 6 },
  { n: 'Grace Liu', e: 'grace.liu@lanternwood-schools.example', o: 'Lanternwood Schools', src: 'Email',
    iq: 'Other', subj: 'Question about AI literacy for teachers',
    sum: 'District coordinator exploring AI literacy options for teachers; very early stage.',
    fit: 4, urg: 3, score: 4, work: 'TBD — discovery call first', next: 'Qualify budget and timeline on a short call',
    draft: 'Hi Grace — happy to share how we run teacher AI-literacy sessions. A 15-min call would help us scope it.',
    reasons: ['Education sector interest'], risks: ['No budget mentioned', 'Exploratory tone'],
    inf: [], stage: 'New', owner: 'sam', days: 4 },
  { n: 'Omar Haddad', e: 'omar@quartzline-capital.example', o: 'Quartzline Capital', src: 'Website form',
    iq: 'New project / hot lead', subj: 'Urgent: AI enablement before Q3 planning',
    sum: 'Partner wants firm-wide AI enablement finished before Q3 planning cycle; asked for a call this week.',
    fit: 8, urg: 9, score: 8, low: 12000, high: 20000, payout: '$12,000–20,000 — firm-wide enablement, tight timeline',
    work: '2 workshops + exec briefing', next: 'Call today — explicit urgency in the message',
    draft: 'Hi Omar — we can meet your pre-Q3 window. I have two slots tomorrow for a scoping call.',
    reasons: ['Explicit urgency', 'Senior sponsor (Partner)'], risks: ['Tight timeline'],
    inf: ['dealValueLow', 'dealValueHigh'], stage: 'New', owner: null, days: 0.5 },
  // ---- Contacted (6) ----
  { n: 'Felicity Grant', e: 'felicity@meridian-mutual.example', o: 'Meridian Mutual', src: 'Referral',
    iq: 'Training request', subj: 'Claims team AI training (referral)',
    sum: 'L&D lead referred to us; wants AI training for a 25-person claims team.',
    fit: 7, urg: 6, score: 7, low: 7000, high: 11000, payout: '$7,000–11,000 — 25-seat claims cohort',
    work: '1.5-day workshop + toolkit', next: 'Chase reply — follow-up is overdue',
    draft: 'Hi Felicity — following up on the claims-team training outline I sent. Any questions from your side?',
    reasons: ['Warm referral', 'Named team size'], risks: ['Slow email responses'],
    inf: ['dealValueHigh'], stage: 'Contacted', owner: 'avery', days: 8, follow: -2, reply: true },
  { n: 'Noah Petersen', e: 'noah@tidewater-marine.example', o: 'Tidewater Marine', src: 'Email',
    iq: 'Consulting inquiry', subj: 'AI workflow review for scheduling desk',
    sum: 'Wants a consultant to review their vessel-scheduling workflow for AI opportunities.',
    fit: 6, urg: 5, score: 6, low: 4000, high: 9000, payout: '$4,000–9,000 — workflow assessment',
    work: '1-week assessment', next: 'Await reply to discovery questions; call booked window',
    draft: 'Hi Noah — sent over five discovery questions on the scheduling desk. Keen to hear the answers before we scope.',
    reasons: ['Concrete workflow named'], risks: ['Scope could shrink to a single report'],
    inf: ['dealValueLow'], stage: 'Contacted', owner: 'jordan', days: 10, follow: 3, reply: true },
  { n: 'Ingrid Solberg', e: 'ingrid@fjordview-travel.example', o: 'Fjordview Travel', src: 'Website form',
    iq: 'Workshop / speaking', subj: 'AI workshop for travel agents',
    sum: 'Owner of a boutique agency wants a half-day AI workshop for 10 agents.',
    fit: 5, urg: 4, score: 5, low: 3000, high: 5000, payout: '$3,000–5,000 — half-day, 10 seats',
    work: 'Half-day workshop', next: 'Overdue follow-up — nudge on proposed dates',
    draft: 'Hi Ingrid — circling back on the half-day workshop dates I proposed. Do any of them still work?',
    reasons: ['Owner is decision-maker'], risks: ['Small team, price sensitive'],
    inf: [], stage: 'Contacted', owner: 'sam', days: 12, follow: -4, reply: true },
  { n: 'Caleb Wren', e: 'caleb@stonebridge-legal.example', o: 'Stonebridge Legal', src: 'Event',
    iq: 'Training request', subj: 'CLE-style AI course for associates',
    sum: 'Practice manager from the legal summit wants an AI course adapted for associates.',
    fit: 7, urg: 5, score: 7, low: 6000, high: 10000, payout: '$6,000–10,000 — associates cohort, CLE format',
    work: '2 half-day sessions', next: 'Send legal-industry case studies before next call',
    draft: 'Hi Caleb — attaching two law-firm case studies. Our associates track maps well to your CLE format.',
    reasons: ['Industry fit (prior legal clients)', 'Met at summit'], risks: ['Partner sign-off needed'],
    inf: ['dealValueLow', 'dealValueHigh'], stage: 'Contacted', owner: 'avery', days: 9, follow: 6, reply: true },
  { n: 'Mira Patel', e: 'mira@juniper-biotech.example', o: 'Juniper Biotech', src: 'Email',
    iq: 'New project / hot lead', subj: 'AI adoption program for R&D + ops',
    sum: 'Director of Ops scoping a two-track AI adoption program covering R&D and operations.',
    fit: 8, urg: 7, score: 8, low: 14000, high: 22000, payout: '$14,000–22,000 — two-track program, exec sponsor',
    work: '2-day kickoff + 6 weeks coaching', next: 'Prepare two-track outline for Friday call',
    draft: 'Hi Mira — outline for the R&D and ops tracks is drafted; sending ahead of Friday so we can dive straight in.',
    reasons: ['Exec sponsor engaged', 'Two teams in scope'], risks: ['Procurement process unknown'],
    inf: ['dealValueHigh'], stage: 'Contacted', owner: 'jordan', days: 7, follow: 1, reply: true },
  { n: 'Stefan Kovács', e: 'stefan@aldergate-manufacturing.example', o: 'Aldergate Manufacturing', src: 'Other',
    iq: 'Partnership', subj: 'Co-branded training partnership idea',
    sum: 'Training vendor proposing a co-branded AI curriculum partnership for manufacturing clients.',
    fit: 5, urg: 4, score: 5, work: 'Partner evaluation', next: 'Assign owner; assess partner fit before replying further',
    reasons: ['Channel into manufacturing'], risks: ['Rev-share unclear', 'Brand fit unverified'],
    inf: [], stage: 'Contacted', owner: null, days: 14, follow: -1,
    notes: 'Wants co-branded curriculum; needs partner-fit review before we invest more time.' },
  // ---- Qualified (5) ----
  { n: 'Rosa Delgado', e: 'rosa@saffron-hospitality.example', o: 'Saffron Hospitality Group', src: 'Referral',
    iq: 'Training request', subj: 'AI training across 6 hotel properties',
    sum: 'Qualified: budget confirmed for AI training of GMs and front-office leads across 6 properties.',
    fit: 8, urg: 7, score: 8, low: 9000, high: 15000, payout: '$9,000–15,000 — 6 properties, budget confirmed',
    work: 'Roadshow: 3 regional sessions', next: 'Draft proposal with per-property pricing',
    draft: 'Hi Rosa — pulling together the per-property proposal now; you will have it before your leadership sync.',
    reasons: ['Budget confirmed', 'Multi-site scope'], risks: ['Scheduling across properties'],
    inf: [], stage: 'Qualified', owner: 'avery', days: 16, follow: 4, reply: true },
  { n: 'Ben Carver', e: 'ben@ironwood-outfitters.example', o: 'Ironwood Outfitters', src: 'Website form',
    iq: 'Consulting inquiry', subj: 'AI for merchandising decisions',
    sum: 'Qualified on call: wants advisory on using AI in merchandising; budget range verbally agreed.',
    fit: 7, urg: 6, score: 7, low: 7000, high: 12000, payout: '$7,000–12,000 — merchandising advisory',
    work: '4-week advisory block', next: 'Overdue: send the advisory scope doc promised on the call',
    draft: 'Hi Ben — apologies for the delay; the merchandising advisory scope doc is attached.',
    reasons: ['Verbal budget agreement', 'Specific use case'], risks: ['Promised doc is overdue'],
    inf: ['dealValueLow'], stage: 'Qualified', owner: 'jordan', days: 18, follow: -3 },
  { n: 'Yuki Tanaka', e: 'yuki@paperlantern-media.example', o: 'Paper Lantern Media', src: 'Event',
    iq: 'Workshop / speaking', subj: 'Newsroom AI workshop series',
    sum: 'Qualified: editor-in-chief wants a 3-part newsroom AI workshop series next quarter.',
    fit: 6, urg: 5, score: 6, low: 3500, high: 6000, payout: '$3,500–6,000 — 3-part series',
    work: '3 x 2-hour sessions', next: 'Hold dates for next quarter and send series outline',
    draft: 'Hi Yuki — holding three dates next quarter for the newsroom series; outline attached.',
    reasons: ['Editorial sponsor', 'Series (repeat) format'], risks: ['Quarter-out timeline may slip'],
    inf: [], stage: 'Qualified', owner: 'sam', days: 20, follow: 7 },
  { n: 'Harriet Boone', e: 'harriet@gladstone-credit.example', o: 'Gladstone Credit Union', src: 'Email',
    iq: 'Training request', subj: 'AI upskilling for member-services team',
    sum: 'Qualified: L&D budget approved for AI upskilling of 30 member-services staff plus leadership briefing.',
    fit: 9, urg: 8, score: 9, low: 11000, high: 17000, payout: '$11,000–17,000 — 30 seats + leadership briefing',
    work: '2-day program + exec session', next: 'Prep proposal; decision committee meets in 2 weeks',
    draft: 'Hi Harriet — proposal is in progress; it covers the 30-seat program and the leadership briefing you asked for.',
    reasons: ['Budget approved', 'Decision date known', 'Compliance-aware buyer'], risks: ['Committee decision (multi-stakeholder)'],
    inf: [], stage: 'Qualified', owner: 'avery', days: 15, follow: 2, reply: true },
  { n: 'Viktor Lindqvist', e: 'viktor@arcticpine-software.example', o: 'Arctic Pine Software', src: 'Website form',
    iq: 'New project / hot lead', subj: 'Engineering org AI enablement',
    sum: 'Qualified then stalled: CTO wanted AI enablement for 50 engineers; quiet since security review request.',
    fit: 8, urg: 6, score: 8, low: 13000, high: 19000, payout: '$13,000–19,000 — 50-engineer enablement',
    work: '3 workshops + office hours', next: 'Overdue: escalate politely to CTO after security-review silence',
    draft: 'Hi Viktor — checking in on the security review. Happy to join a call with your team to close out questions.',
    reasons: ['CTO sponsor', 'Large seat count'], risks: ['Gone quiet 2+ weeks', 'Security review pending'],
    inf: ['dealValueHigh'], stage: 'Qualified', owner: 'jordan', days: 22, follow: -5,
    notes: 'Champion went quiet after we sent security documentation. Try phone next.' },
  // ---- Proposal sent (4) ----
  { n: 'Amara Diallo', e: 'amara@sunbridge-energy.example', o: 'Sunbridge Energy', src: 'Referral',
    iq: 'Consulting inquiry', subj: 'AI strategy engagement — proposal',
    sum: 'Proposal sent for an AI strategy engagement with the transformation office; verbal positive signals.',
    fit: 9, urg: 7, score: 9, low: 15000, high: 25000, payout: '$15,000–25,000 — strategy engagement, strong signals',
    work: '6-week strategy engagement', next: 'Follow up after their steering meeting next week',
    draft: 'Hi Amara — thanks for the kind words on the proposal. Happy to adjust phase 2 scope if the committee prefers.',
    reasons: ['Transformation office sponsor', 'Positive verbal feedback'], risks: ['Competing internal initiative'],
    inf: [], stage: 'Proposal sent', owner: 'avery', days: 25, follow: 5, reply: true },
  { n: 'Leo Marchetti', e: 'leo@vintale-wines.example', o: 'Vintale Wines', src: 'Event',
    iq: 'Training request', subj: 'Proposal: AI for sales & tasting-room teams',
    sum: 'Proposal sent for sales and tasting-room AI training; decision promised "within the week" — now overdue.',
    fit: 7, urg: 6, score: 7, low: 9000, high: 14000, payout: '$9,000–14,000 — two-team training package',
    work: '2-day split program', next: 'Overdue: nudge on the promised decision',
    draft: 'Hi Leo — checking in on the proposal decision. Anything I can clarify to help it across the line?',
    reasons: ['Met at trade event', 'Two teams committed'], risks: ['Decision overdue'],
    inf: [], stage: 'Proposal sent', owner: 'jordan', days: 28, follow: -2, reply: true },
  { n: 'Sadie Kirkland', e: 'sadie@hollowbrook-farms.example', o: 'Hollowbrook Farms', src: 'Website form',
    iq: 'Workshop / speaking', subj: 'Proposal: AI intro day for co-op members',
    sum: 'Proposal sent for an AI introduction day at the co-op annual meeting; board reviews next month.',
    fit: 6, urg: 4, score: 6, low: 4000, high: 7000, payout: '$4,000–7,000 — annual-meeting workshop day',
    work: '1-day event program', next: 'Wait for board review; check in after their meeting',
    draft: 'Hi Sadie — no rush ahead of the board meeting; ping me if the members want a shorter format option.',
    reasons: ['Annual budget line exists'], risks: ['Board approval cycle is slow'],
    inf: ['dealValueLow'], stage: 'Proposal sent', owner: 'sam', days: 30, follow: 8, reply: true },
  { n: 'Rajesh Nair', e: 'rajesh@crestwave-shipping.example', o: 'Crestwave Shipping', src: 'Email',
    iq: 'New project / hot lead', subj: 'Proposal: fleet-ops AI program',
    sum: 'Proposal sent for a fleet-operations AI program; CFO reviewing numbers, champion pushing hard.',
    fit: 9, urg: 8, score: 9, low: 18000, high: 25000, payout: '$18,000–25,000 — fleet-ops program, CFO reviewing',
    work: '8-week program, 3 teams', next: 'Send ROI one-pager to help the CFO review',
    draft: 'Hi Rajesh — here is the ROI one-pager for your CFO. Happy to join a 15-min numbers call.',
    reasons: ['Active champion', 'CFO engaged (real evaluation)'], risks: ['Price negotiation likely'],
    inf: [], stage: 'Proposal sent', owner: 'avery', days: 24, follow: 1, reply: true },
  // ---- Closed won (5) ----
  { n: 'Colette Marceau', e: 'colette@beaconhill-realty.example', o: 'Beacon Hill Realty', src: 'Referral',
    iq: 'Training request', subj: 'Agent AI training package — signed',
    sum: 'Won: 3-workshop AI training package for realty agents, signed and scheduled.',
    fit: 9, urg: 7, score: 9, low: 14000, high: 14000, payout: '$14,000 — 3-workshop package, signed',
    work: '3 workshops over 6 weeks', next: 'Deliver kickoff workshop; upsell coaching at wrap-up',
    reasons: ['Referral from happy client', 'Fast signature'], risks: [],
    inf: [], stage: 'Closed won', owner: 'avery', days: 45, notes: 'Signed 3-workshop package; invoice paid. Kickoff booked.' },
  { n: 'Douglas Finch', e: 'douglas@wrenfield-insurance.example', o: 'Wrenfield Insurance', src: 'Website form',
    iq: 'Consulting inquiry', subj: 'Underwriting AI advisory — won',
    sum: 'Won: underwriting AI advisory engagement, largest deal this quarter.',
    fit: 8, urg: 7, score: 8, low: 25000, high: 25000, payout: '$25,000 — underwriting advisory, signed SOW',
    work: '8-week advisory engagement', next: 'Run engagement; schedule QBR at week 4',
    reasons: ['Signed SOW', 'Exec sponsor'], risks: [],
    inf: [], stage: 'Closed won', owner: 'jordan', days: 52 },
  { n: 'Naomi Adeyemi', e: 'naomi@silvercreek-dental.example', o: 'Silvercreek Dental Partners', src: 'Event',
    iq: 'Workshop / speaking', subj: 'Practice-managers AI workshop — booked',
    sum: 'Won: half-day AI workshop for dental practice managers, delivered and invoiced.',
    fit: 8, urg: 6, score: 8, low: 3500, high: 3500, payout: '$3,500 — half-day workshop, delivered',
    work: 'Half-day workshop', next: 'Send follow-up survey and referral ask',
    reasons: ['Met at conference', 'Quick close'], risks: [],
    inf: [], stage: 'Closed won', owner: 'sam', days: 60 },
  { n: 'Hugo Lindgren', e: 'hugo@stormvik-logistics.example', o: 'Stormvik Logistics', src: 'Email',
    iq: 'Training request', subj: 'Company-wide AI academy — signed',
    sum: 'Won: company-wide AI academy (train-the-trainer model) for a 200-person logistics firm.',
    fit: 10, urg: 8, score: 10, low: 21000, high: 21000, payout: '$21,000 — AI academy with trainer certification',
    work: '10-week academy + certification', next: 'Deliver cohort 1; certify internal trainers',
    reasons: ['Perfect ICP match', 'Trainer certification upsell landed'], risks: [],
    inf: [], stage: 'Closed won', owner: 'avery', days: 66, notes: 'Flagship reference client — ask for case study at wrap.' },
  { n: 'Tessa Whitmore', e: 'tessa@fablemoor-publishing.example', o: 'Fablemoor Publishing', src: 'Referral',
    iq: 'New project / hot lead', subj: 'Editorial AI pilot — won',
    sum: 'Won: editorial AI pilot program for two imprints, signed after a single call.',
    fit: 9, urg: 8, score: 9, low: 8000, high: 8000, payout: '$8,000 — editorial pilot, two imprints',
    work: '4-week pilot', next: 'Run pilot; propose expansion to remaining imprints',
    reasons: ['Referral', 'One-call close'], risks: [],
    inf: [], stage: 'Closed won', owner: 'jordan', days: 40 },
  // ---- Closed lost (3) ----
  { n: 'Gareth Llewellyn', e: 'gareth@brynmore-mining.example', o: 'Brynmore Mining', src: 'Email',
    iq: 'Consulting inquiry', subj: 'Site-safety AI advisory — lost',
    sum: 'Lost: chose to build an internal L&D program instead of external advisory.',
    fit: 7, urg: 5, score: 7, low: 10000, high: 16000, payout: '$10,000–16,000 — lost to internal build',
    work: '6-week advisory (not won)', next: 'Re-engage in 6 months when internal program stalls',
    reasons: ['Good industry fit'], risks: ['Preferred internal ownership'],
    inf: [], stage: 'Closed lost', owner: 'avery', days: 55, notes: 'Went with an internal L&D program. Revisit in Q1.' },
  { n: 'Simone Aubert', e: 'simone@lavande-cosmetics.example', o: 'Lavande Cosmetics', src: 'Website form',
    iq: 'Training request', subj: 'Marketing AI training — lost',
    sum: 'Lost on price: picked a cheaper self-paced e-learning vendor for marketing team training.',
    fit: 6, urg: 5, score: 6, low: 5000, high: 9000, payout: '$5,000–9,000 — lost on price',
    work: '1-day workshop (not won)', next: 'Add to nurture list; share free webinar invites',
    reasons: ['Engaged marketing lead'], risks: ['Price sensitive'],
    inf: [], stage: 'Closed lost', owner: 'sam', days: 48 },
  { n: 'Pete Hastings', e: 'pete@oakhollow-hardware.example', o: 'Oak Hollow Hardware', src: 'Event',
    iq: 'Workshop / speaking', subj: 'Store-managers AI intro — lost',
    sum: 'Lost: quarterly budget cut removed the training line item entirely.',
    fit: 5, urg: 4, score: 5, low: 2000, high: 3500, payout: '$2,000–3,500 — budget cut',
    work: 'Half-day session (not won)', next: 'Check back next fiscal year',
    reasons: ['Friendly contact'], risks: ['Budget volatility'],
    inf: ['dealValueLow'], stage: 'Closed lost', owner: 'jordan', days: 63, notes: 'Budget cut for the quarter; contact remains warm.' },
  // ---- Not fit (2) ----
  { n: 'Randall Osei', e: 'randall@velvetpeak-recruiting.example', o: 'Velvet Peak Recruiting', src: 'Email',
    iq: 'Job inquiry', subj: 'Interested in joining your team',
    sum: 'Job seeker asking about facilitator openings — not a buyer.',
    fit: 2, urg: 3, score: 3, next: 'Send polite decline with careers-page link',
    reasons: [], risks: ['Not a buyer'], inf: [], stage: 'Not fit', owner: null, days: 33,
    notes: 'Job seeker, not a buyer. Replied with careers info.' },
  { n: 'Bianca Ferri', e: 'bianca@lumastro-saas.example', o: 'Lumastro SaaS', src: 'Other',
    iq: 'Vendor pitch', subj: 'Partnership? Our LMS platform + your content',
    sum: 'Vendor pitching their LMS platform; no training demand on their side.',
    fit: 2, urg: 2, score: 2, next: 'No action — archived as vendor pitch',
    reasons: [], risks: ['Selling to us, not buying'], inf: [], stage: 'Not fit', owner: 'sam', days: 38 },
]

interface EventRow { type: string; at: Date; actor: string; detail: string }

function buildTimeline(d: LeadDef, receivedAt: Date, followUpDate: Date | null, actor: string): EventRow[] {
  const path = STAGE_PATHS[d.stage] ?? [d.stage]
  const span = Math.max(now.getTime() - receivedAt.getTime(), DAY / 2)
  const step = span / (path.length + 2)
  const at = (k: number): Date => new Date(receivedAt.getTime() + step * k)
  const events: EventRow[] = [{ type: 'created', at: receivedAt, actor: 'system', detail: `Scanned from inbox (${d.src})` }]
  for (let i = 1; i < path.length; i++) {
    events.push({ type: 'stage_change', at: at(i), actor, detail: `${path[i - 1]} → ${path[i]}` })
  }
  if (d.reply) events.push({ type: 'reply_sent', at: at(path.length - 0.5), actor, detail: `Reply sent to ${d.e}` })
  if (followUpDate) {
    events.push({ type: 'follow_up_set', at: at(path.length), actor, detail: `Follow-up set for ${followUpDate.toISOString().slice(0, 10)}` })
  }
  if (d.notes) events.push({ type: 'note_added', at: at(path.length + 0.5), actor, detail: 'Note added' })
  return events
}

function buildThreads(d: LeadDef, externalId: string, receivedAt: Date): Omit<Prisma.ThreadCreateManyInput, 'leadId'>[] {
  const slug = externalId.replace(/-/g, '')
  const url = (k: string): string => `https://mail.google.com/mail/u/0/#all/${slug}${k}`
  const threads: Omit<Prisma.ThreadCreateManyInput, 'leadId'>[] = [
    { subject: d.subj, url: url('a'), direction: 'in', date: receivedAt, snippet: d.sum.slice(0, 140) },
  ]
  if (d.reply) {
    const snippet = (d.draft ?? 'Thanks for reaching out — sharing our program options and a couple of call slots.').slice(0, 140)
    threads.push({ subject: `Re: ${d.subj}`, url: url('b'), direction: 'out', date: new Date(receivedAt.getTime() + DAY), snippet })
  }
  if (d.stage === 'Proposal sent' || d.stage === 'Closed won') {
    threads.push({
      subject: `Re: ${d.subj}`, url: url('c'), direction: 'in', date: new Date(receivedAt.getTime() + 2 * DAY),
      snippet: 'Thanks — reviewing this internally with the team, will come back to you shortly.',
    })
  }
  return threads
}

async function main(): Promise<void> {
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'fieldstone-training-group' },
    create: { name: 'Fieldstone Training Group', slug: 'fieldstone-training-group', settings: json(DEFAULT_SETTINGS) },
    update: { name: 'Fieldstone Training Group', settings: json(DEFAULT_SETTINGS) },
  })

  const ownerIds = {} as Record<OwnerKey, string>
  const ownerNames = {} as Record<OwnerKey, string>
  for (const u of USERS) {
    const passwordHash = await hashPassword(u.password)
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: { workspaceId: workspace.id, email: u.email, name: u.name, role: u.role, passwordHash },
      update: { workspaceId: workspace.id, name: u.name, role: u.role, passwordHash },
    })
    ownerIds[u.key] = user.id
    ownerNames[u.key] = user.name
  }

  for (let i = 0; i < LEADS.length; i++) {
    const d = LEADS[i]!
    const externalId = `seed-${String(i + 1).padStart(3, '0')}`
    const receivedAt = daysAgo(d.days)
    const followUpDate = d.follow !== undefined ? daysFromNow(d.follow) : null
    const actor = d.owner ? ownerNames[d.owner] : ownerNames.avery
    const events = buildTimeline(d, receivedAt, followUpDate, actor)
    const computed = applyComputed({ leadScore: d.score, dealValueLow: d.low ?? 0, dealValueHigh: d.high ?? 0 }, DEFAULT_SETTINGS)
    const data = {
      receivedAt, name: d.n, email: d.e, org: d.o, source: d.src, inquiryType: d.iq, summary: d.sum,
      fitScore: d.fit, urgencyScore: d.urg, leadScore: d.score, tier: computed.tier,
      dealValueLow: d.low ?? 0, dealValueHigh: d.high ?? 0, estPayoutRaw: d.payout ?? '',
      winProbability: computed.winProbability, winProbabilityOverridden: false, expectedValue: computed.expectedValue,
      estWork: d.work ?? '', recommendedNextStep: d.next ?? '', draftReply: d.draft ?? '',
      fitReasons: json(d.reasons ?? []), riskFlags: json(d.risks ?? []), inferredFields: json(d.inf ?? []),
      stage: d.stage, ownerId: d.owner ? ownerIds[d.owner] : null, followUpDate,
      replySent: d.reply ?? false, lastTouchedAt: events[events.length - 1]!.at, notes: d.notes ?? '',
      // Re-seeding always restores a fully visible demo, even if leads were
      // previously soft-deleted in a scratch/testing session.
      deletedAt: null,
    }
    const lead = await prisma.lead.upsert({
      where: { workspaceId_externalId: { workspaceId: workspace.id, externalId } },
      create: { workspaceId: workspace.id, externalId, ...data },
      update: data,
    })
    // Threads and timeline are recreated wholesale so re-runs never duplicate.
    await prisma.thread.deleteMany({ where: { leadId: lead.id } })
    await prisma.timelineEvent.deleteMany({ where: { leadId: lead.id } })
    const threads = buildThreads(d, externalId, receivedAt)
    if (threads.length > 0) {
      await prisma.thread.createMany({ data: threads.map((t) => ({ ...t, leadId: lead.id })) })
    }
    await prisma.timelineEvent.createMany({ data: events.map((ev) => ({ ...ev, leadId: lead.id })) })
  }

  const total = await prisma.lead.count({ where: { workspaceId: workspace.id } })
  const grouped = await prisma.lead.groupBy({
    by: ['stage'], where: { workspaceId: workspace.id }, _count: { _all: true },
  })
  const countByStage = new Map(grouped.map((g) => [g.stage, g._count._all]))
  const threadCount = await prisma.thread.count({ where: { lead: { workspaceId: workspace.id } } })
  const eventCount = await prisma.timelineEvent.count({ where: { lead: { workspaceId: workspace.id } } })

  console.log(`\nSeeded workspace "${workspace.name}" (${workspace.slug})`)
  console.log(`Leads total: ${total} | threads: ${threadCount} | timeline events: ${eventCount}`)
  for (const stage of DEFAULT_SETTINGS.stages) {
    console.log(`  ${stage.padEnd(14)} ${countByStage.get(stage) ?? 0}`)
  }
  console.log('\nDemo logins (fictional demo data — intended to be printed):')
  for (const u of USERS) {
    console.log(`  ${u.role.padEnd(6)} ${u.email}  /  ${u.password}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
