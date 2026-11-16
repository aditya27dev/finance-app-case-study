// Encryption helpers: AWS KMS on the server, AES-256-GCM on the device
//
// Part A runs in the API. Bank OAuth tokens are encrypted with direct
// KMS Encrypt and Decrypt calls under a customer-managed key. An encryption
// context binds each ciphertext to its purpose.
// Part B runs in the iOS app. The persisted query cache is encrypted with
// AES-256-GCM. The key is generated on the device and kept in the Keychain.
// Excerpt, trimmed for length.

// ---- Part A: server, AWS KMS ----
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms'

const kms = new KMSClient({})
const CONTEXT = { purpose: 'bank-connection-token' }
const MAX_PLAINTEXT_BYTES = 3000 // direct KMS Encrypt caps plaintext at 4 KB

export async function encryptToken(plaintext: string, keyId: string): Promise<string> {
  const buf = Buffer.from(plaintext, 'utf8')
  if (buf.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('token too large for direct KMS encryption')
  const out = await kms.send(new EncryptCommand({ KeyId: keyId, Plaintext: buf, EncryptionContext: CONTEXT }))
  if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext')
  return Buffer.from(out.CiphertextBlob).toString('base64')
}

export async function decryptToken(ciphertextB64: string): Promise<string> {
  const out = await kms.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertextB64, 'base64'),
    EncryptionContext: CONTEXT, // a mismatched context fails to decrypt
  }))
  if (!out.Plaintext) throw new Error('KMS returned no plaintext')
  return Buffer.from(out.Plaintext).toString('utf8')
}

// ---- Part B: device, AES-256-GCM ----
import * as SecureStore from 'expo-secure-store'
import { Buffer as QBuffer, createCipheriv, createDecipheriv, randomBytes } from 'react-native-quick-crypto'

const KEY_NAME = 'cache_encryption_key'
const IV_LENGTH = 12
const TAG_LENGTH = 16

async function getOrCreateKey(): Promise<QBuffer> {
  const existing = await SecureStore.getItemAsync(KEY_NAME)
  if (existing) return QBuffer.from(existing, 'base64')
  const key = randomBytes(32)
  await SecureStore.setItemAsync(KEY_NAME, key.toString('base64'))
  return key
}

export async function encryptCache(plaintext: string): Promise<string> {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', await getOrCreateKey(), iv)
  const body = QBuffer.concat([cipher.update(QBuffer.from(plaintext, 'utf8')), cipher.final(), cipher.getAuthTag()])
  return `${iv.toString('base64')}.${body.toString('base64')}`
}

// Any failure returns null. The caller treats that as a cache miss and refetches.
export async function decryptCache(payload: string): Promise<string | null> {
  try {
    const [ivB64, bodyB64] = payload.split('.')
    if (!ivB64 || !bodyB64) return null
    const body = QBuffer.from(bodyB64, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', await getOrCreateKey(), QBuffer.from(ivB64, 'base64'))
    decipher.setAuthTag(body.subarray(body.length - TAG_LENGTH))
    return QBuffer.concat([decipher.update(body.subarray(0, body.length - TAG_LENGTH)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
