import type { Store } from "./store.js"

interface CooldownEntry {
  failedAt: number
  retryAfter: number // absolute timestamp when account can be retried
  reason: string
}

// Default cooldown durations in seconds
const COOLDOWN_DURATIONS: Record<number, number> = {
  429: 60,  // rate limited — 1 minute default (overridden by Retry-After header)
  402: 300, // out of credits — 5 minutes
  403: 300, // forbidden/suspended — 5 minutes
}

const cooldowns = new Map<string, CooldownEntry>()

/**
 * Mark an account as on cooldown after a failed request.
 */
export function setCooldown(accountName: string, status: number, retryAfterSecs?: number): void {
  const duration = retryAfterSecs ?? COOLDOWN_DURATIONS[status] ?? 60
  cooldowns.set(accountName, {
    failedAt: Date.now(),
    retryAfter: Date.now() + duration * 1000,
    reason: String(status),
  })
}

/**
 * Check if an account is currently on cooldown.
 */
export function isOnCooldown(accountName: string): boolean {
  const entry = cooldowns.get(accountName)
  if (!entry) return false
  if (Date.now() >= entry.retryAfter) {
    cooldowns.delete(accountName)
    return false
  }
  return true
}

/**
 * Find the next available account that is not on cooldown.
 * Returns null if all accounts are on cooldown.
 */
export function getNextAvailableAccount(
  currentName: string,
  store: Store,
): string | null {
  const names = Object.keys(store.accounts)
  for (const name of names) {
    if (name === currentName) continue
    if (!isOnCooldown(name)) return name
  }
  return null
}

/**
 * Whether a response status code should trigger an auto-switch.
 * For 429, only switch if the Retry-After delay exceeds the threshold.
 */
export function shouldAutoSwitch(response: Response, retryAfterThresholdSecs = 30): boolean {
  const { status } = response

  if (status === 402 || status === 403) return true

  if (status === 429) {
    const retryAfter = response.headers.get("retry-after")
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10)
      if (!isNaN(secs) && secs <= retryAfterThresholdSecs) return false
    }
    return true
  }

  return false
}

/**
 * Parse the Retry-After header value in seconds (for cooldown duration).
 */
export function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const secs = parseInt(header, 10)
  return isNaN(secs) ? undefined : secs
}

/**
 * Clear all cooldowns (useful for testing or reset).
 */
export function clearCooldowns(): void {
  cooldowns.clear()
}
