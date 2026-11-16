// One Hono route through the hexagonal layers (ports and adapters)
//
// The route only parses input and calls a core service. The core service
// depends on port interfaces. It never imports the database. A Drizzle
// adapter implements the port, and a single container file wires them up.
// Unit tests pass in-memory fakes for the same ports.
// Four files are shown together here. Excerpt, trimmed for length.

// ---- ports/IDuplicateReviewRepo.ts ----
export interface IDuplicateReviewRepo {
  /** Pairs the user confirmed are NOT duplicates, as "idA:idB" with idA < idB. */
  findDismissedPairKeys(userId: string): Promise<Set<string>>
  dismiss(userId: string, receiptIdA: string, receiptIdB: string): Promise<void>
}

// ---- core/DuplicateExpenseService.ts ----
export class DuplicateExpenseService {
  constructor(
    private readonly receiptRepo: IReceiptRepo, // another port
    private readonly reviewRepo: IDuplicateReviewRepo,
  ) {}

  dismiss(userId: string, idA: string, idB: string) {
    return this.reviewRepo.dismiss(userId, idA, idB)
  }
  // findPairs(...) scans the user's expenses for same-amount pairs
}

// ---- adapters/db/DuplicateReviewRepo.ts ----
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { duplicateExpenseDismissals as t } from '../../db/schema'

export class DrizzleDuplicateReviewRepo implements IDuplicateReviewRepo {
  async findDismissedPairKeys(userId: string) {
    const rows = await db.select().from(t).where(eq(t.userId, userId))
    return new Set(rows.map((r) => `${r.receiptIdA}:${r.receiptIdB}`))
  }

  async dismiss(userId: string, idA: string, idB: string) {
    const [a, b] = idA < idB ? [idA, idB] : [idB, idA]
    await db.insert(t).values({ userId, receiptIdA: a, receiptIdB: b }).onConflictDoNothing()
  }
}

// ---- entrypoints/http/routes/duplicateExpenses.ts ----
import { Hono } from 'hono'
import { dismissDuplicateExpenseSchema } from '@app/schemas'
import { duplicateExpenseService } from '../../container'
import { type AuthVariables, requireAuth } from '../middleware/auth'

export const duplicateExpensesRouter = new Hono<{ Variables: AuthVariables }>()

duplicateExpensesRouter.use('/*', requireAuth)

duplicateExpensesRouter.post('/dismiss', async (c) => {
  const parsed = dismissDuplicateExpenseSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ ok: false, message: 'Invalid request', issues: parsed.error.issues }, 400)
  }
  const { receiptIdA, receiptIdB } = parsed.data
  await duplicateExpenseService.dismiss(c.get('userId'), receiptIdA, receiptIdB)
  return c.json({ ok: true })
})

// ---- entrypoints/container.ts (the only place adapters meet services) ----
// const duplicateExpenseService = new DuplicateExpenseService(
//   new DrizzleReceiptRepo(),
//   new DrizzleDuplicateReviewRepo(),
// )
