// Receipt extraction agent: validate and retry
//
// A LangGraph state machine reads a receipt photo with a vision model.
// Each result is checked against a Zod schema and a confidence threshold.
// If the check fails, the reason is written into state and fed back into
// the next prompt. The graph allows two retries, so three attempts in total.
// Excerpt, trimmed for length. Progress events and tracing are removed.

import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { receiptExtractionSchema, type ReceiptExtraction } from '@app/schemas'
import { pickChatModel } from './modelProvider'

const MIN_CONFIDENCE = 0.7
const MAX_RETRIES = 2
const keep = <T>(_old: T, next: T) => next

const State = Annotation.Root({
  imageUrl: Annotation<string>({ reducer: keep, default: () => '' }),
  attempt: Annotation<number>({ reducer: keep, default: () => 0 }),
  extraction: Annotation<ReceiptExtraction | null>({ reducer: keep, default: () => null }),
  confidenceOk: Annotation<boolean>({ reducer: keep, default: () => false }),
  lastFailureReason: Annotation<string | null>({ reducer: keep, default: () => null }),
})
type S = typeof State.State

async function extractReceipt(state: S): Promise<Partial<S>> {
  const model = pickChatModel().withStructuredOutput(receiptExtractionSchema)
  // The previous failure reason goes back to the model as plain text.
  const attemptText = state.lastFailureReason
    ? `Attempt ${state.attempt + 1}. The previous attempt failed because: ${state.lastFailureReason}.`
    : `Attempt ${state.attempt + 1}`

  const extraction = await model.invoke(
    [
      { role: 'system', content: 'Extract receipt data from the attached image.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: attemptText },
          { type: 'image_url', image_url: { url: state.imageUrl } },
        ],
      },
    ],
    { timeout: 25_000 },
  )
  return { extraction }
}

async function validateOutput(state: S): Promise<Partial<S>> {
  const parsed = receiptExtractionSchema.safeParse(state.extraction)
  if (!parsed.success) {
    return { confidenceOk: false, lastFailureReason: 'extraction did not match the expected schema' }
  }

  const { confidence, items, merchantName, total } = parsed.data
  const reasons: string[] = []
  if (confidence < MIN_CONFIDENCE) {
    reasons.push(`confidence ${confidence.toFixed(2)} was below the ${MIN_CONFIDENCE} threshold`)
  }
  if (items.length === 0) reasons.push('no line items were extracted')
  if (!merchantName || total < 0) reasons.push('merchant name or total was missing or invalid')

  return reasons.length === 0
    ? { confidenceOk: true, lastFailureReason: null }
    : { confidenceOk: false, lastFailureReason: reasons.join(', ') }
}

const retry = async (state: S): Promise<Partial<S>> => ({ attempt: state.attempt + 1 })

export const receiptGraph = new StateGraph(State)
  .addNode('extractReceipt', extractReceipt)
  .addNode('validateOutput', validateOutput)
  .addNode('retry', retry)
  .addEdge(START, 'extractReceipt')
  .addEdge('extractReceipt', 'validateOutput')
  .addConditionalEdges('validateOutput', (s) =>
    !s.confidenceOk && s.attempt < MAX_RETRIES ? 'retry' : END)
  .addEdge('retry', 'extractReceipt')
  .compile()
