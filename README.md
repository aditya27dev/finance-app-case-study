# Personal Finance iOS App: Architecture Case Study

An iOS app that collects spending from receipt photos, Apple Pay taps, voice notes and manual entry into one ledger with budgets.

Designed and built solo by Aditya Batra, from the iOS app to the AWS backend.

**Status:** Commercial app in pre-launch. Source is private.

This repo explains how the app is built. It holds an architecture overview and a few short code excerpts. It does not contain the app itself.

## Tech stack

- **Mobile:** Expo SDK 58, React Native 0.88, Expo Router, TanStack Query, Swift (App Intent and a native Keychain module)
- **API:** TypeScript, Hono, GraphQL (read-only, one endpoint), Zod
- **Data:** PostgreSQL with Drizzle ORM
- **AI:** LangGraph, LangChain, OpenAI or Anthropic models, LangSmith for tracing
- **Cloud:** AWS Lambda, EventBridge schedules and KMS, deployed with SST. Amazon SES for email.
- **Auth:** Better Auth with email one-time codes

## Highlights

- Self-correcting LLM receipt extraction with validation and retries
- Bank tokens encrypted with AWS KMS, and an encrypted on-device cache
- An offline Apple Pay queue that replays purchases in order
- Hexagonal architecture with in-memory test fakes

## What to look at

- [Architecture overview and diagram](docs/architecture.md)
- [Receipt extraction agent with validate and retry](samples/01-receipt-extraction-agent.ts)
- [Encryption helpers for KMS and AES-256-GCM](samples/02-encryption-helpers.ts)
- [One API route through the hexagonal layers](samples/03-hexagonal-route.ts)

---

## Design decisions

### Why hexagonal architecture

The API is split into four layers. Routes handle HTTP. Core services hold the business rules. Ports are interfaces. Adapters talk to the outside world.

No core service imports the database client. Each one receives its ports through the constructor. One container file builds the adapters and passes them in.

This gives three practical benefits.

- **Testing.** Core service tests pass in small in-memory fakes. They run without a database or network.
- **Swapping providers.** Receipt extraction can use OpenAI or Anthropic. A config value picks the model. The core code does not change.
- **One app, many entry points.** The same services back the REST routes, the GraphQL endpoint and the scheduled jobs.

### Why a customer-managed KMS key, and how data is encrypted

The app can link bank accounts through an Open Banking provider. That flow stores live OAuth access and refresh tokens. Bank sync is built but switched off in the public build for now.

**Bank tokens on the server.** Each token is encrypted with a direct KMS `Encrypt` call before it is written to PostgreSQL. It is decrypted with `Decrypt` when read back.

- A customer-managed key lets the infrastructure code own the key policy. Automatic yearly rotation is turned on.
- Only the API Lambda has `kms:Encrypt` and `kms:Decrypt` on that one key.
- Every call passes an encryption context. A ciphertext used for the wrong purpose will not decrypt.
- Direct KMS encryption caps plaintext at 4 KB. The helper rejects anything over 3,000 bytes with a clear error. A token that is too large never gets cut short without anyone noticing.
- A database dump on its own does not reveal the tokens. Reading them also needs access to the key.

**Apple Pay Shortcut tokens.** These are random 32-byte tokens. The server stores only their SHA-256 hash.

**The on-device cache.** The app keeps its TanStack Query cache on disk so the last data shows at once on launch. That cache holds transactions, receipts and budgets.

- Before it is written to AsyncStorage, the cache is encrypted with AES-256-GCM.
- Each write uses a fresh 12-byte IV. The 16-byte auth tag is stored with the ciphertext.
- The 256-bit key is generated on the device and stored in the iOS Keychain through `expo-secure-store`.
- If decryption fails for any reason, the app treats it as an empty cache and refetches.
- On sign-out the cache file is deleted. Cache writes are paused first, so a delayed write cannot recreate the file afterwards.

### How the receipt extraction agent validates and retries

A single vision prompt often fails on faded or creased receipts. The extractor is a small LangGraph state machine instead.

1. The model reads the image and returns structured output.
2. A validation step checks it.
   - It must match the Zod schema.
   - Confidence must be at least 0.7.
   - There must be at least one line item.
   - The merchant name and total must be present and valid.
3. If any check fails, the step writes the exact reasons into the graph state. An example is "confidence 0.55 was below the 0.7 threshold, no line items were extracted".
4. The next attempt includes those reasons in its prompt.
5. The graph allows two retries, so three attempts in total.
6. If all three fail, the scan is reported as failed. The user can enter the receipt by hand.

Each model call has a 25-second timeout. The app shows live progress for each step of the graph.

### How the offline Apple Pay capture queue replays in order

The user sets up an Apple Shortcut that runs on each Apple Pay tap. It calls a Swift App Intent. The intent posts the purchase to the API. This often happens with no signal, for example in a shop basement.

**Capture.**

- The intent stamps the purchase time when the tap happens. A replayed purchase keeps its real time.
- If the request fails or returns anything other than 2xx or 400, the intent appends the purchase to a queue in the iOS Keychain. Each entry gets a UUID.
- The queue lives in the Keychain because Keychain items survive an app reinstall. The app's Documents folder does not.
- The Keychain item stays readable after the first unlock since boot. A tap-to-pay automation can fire while the phone is locked.

**Replay.**

- The app flushes the queue on launch and each time it returns to the foreground.
- Entries are sent one at a time, oldest first.
- A 2xx response removes the entry.
- A 400 response also removes it. The payload is invalid, so a retry would fail the same way.
- A network error or any other status stops the flush. That entry and every later one stay queued for the next try. This keeps the order intact.
- Finished entries are removed by ID. The queue is never overwritten as a whole. A purchase queued during a flush is not lost.

**Known limits.** The queue holds at most 200 entries. Past that, the oldest are dropped. This stops a long-broken setup from growing the Keychain item forever. Entries the server rejects with a 400 are also dropped on purpose.

---

## Licence

See [LICENSE](LICENSE).
