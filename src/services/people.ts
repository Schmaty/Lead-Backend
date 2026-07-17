import type { PrismaClient } from '@prisma/client'

export interface PersonInput {
  name: string
  email: string
  /** Only set when the person is first created (or currently blank). */
  role?: string
  seenAt: Date
}

/**
 * Upsert a person on a lead's profile: matched by email (case-insensitive)
 * when present, else by exact name. Fills blanks (a later email can supply the
 * name), never overwrites an existing name/role, and keeps first/last-seen
 * fresh. Returns the person id.
 */
export async function upsertPerson(prisma: PrismaClient, leadId: string, input: PersonInput): Promise<string> {
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim()
  const people = await prisma.person.findMany({ where: { leadId } })
  const existing =
    (email ? people.find((p) => p.email.toLowerCase() === email) : undefined) ??
    (name ? people.find((p) => !p.email && p.name.toLowerCase() === name.toLowerCase()) : undefined)

  if (existing) {
    await prisma.person.update({
      where: { id: existing.id },
      data: {
        ...(name && !existing.name ? { name } : {}),
        ...(email && !existing.email ? { email } : {}),
        ...(input.role && !existing.role ? { role: input.role } : {}),
        ...(input.seenAt > existing.lastSeenAt ? { lastSeenAt: input.seenAt } : {}),
        ...(input.seenAt < existing.firstSeenAt ? { firstSeenAt: input.seenAt } : {}),
      },
    })
    return existing.id
  }
  const created = await prisma.person.create({
    data: {
      leadId,
      name: name || email || '(unknown)',
      email,
      role: input.role ?? '',
      firstSeenAt: input.seenAt,
      lastSeenAt: input.seenAt,
    },
  })
  return created.id
}
