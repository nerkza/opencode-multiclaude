import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DATA_DIR = join(homedir(), ".local", "share", "opencode")
const STORE_FILE = join(DATA_DIR, "multi-account.json")

export interface ApiAccount {
  type: "api"
  key: string
  added: string
  label?: string
}

export interface OAuthAccount {
  type: "oauth"
  accessToken: string
  refreshToken: string
  expiresAt: number
  added: string
  label?: string
}

export type Account = ApiAccount | OAuthAccount

export interface Store {
  active: string | null
  accounts: Record<string, Account>
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

export function read(): Store {
  try {
    const data = JSON.parse(readFileSync(STORE_FILE, "utf-8"))
    return {
      active: data.active ?? null,
      accounts: data.accounts ?? {},
    }
  } catch {
    return { active: null, accounts: {} }
  }
}

export function write(store: Store): void {
  ensureDir()
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export function addApiAccount(name: string, key: string, label?: string): Store {
  const store = read()
  store.accounts[name] = {
    type: "api",
    key,
    added: new Date().toISOString(),
    ...(label ? { label } : {}),
  }
  if (!store.active) store.active = name
  write(store)
  return store
}

export function addOAuthAccount(
  name: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
  label?: string,
): Store {
  const store = read()
  store.accounts[name] = {
    type: "oauth",
    accessToken,
    refreshToken,
    expiresAt,
    added: new Date().toISOString(),
    ...(label ? { label } : {}),
  }
  if (!store.active) store.active = name
  write(store)
  return store
}

export function updateOAuthTokens(name: string, accessToken: string, refreshToken: string, expiresAt: number): void {
  const store = read()
  const account = store.accounts[name]
  if (account?.type === "oauth") {
    account.accessToken = accessToken
    account.refreshToken = refreshToken
    account.expiresAt = expiresAt
    write(store)
  }
}

export function getActiveAccount(): Account | null {
  const store = read()
  if (!store.active) return null
  return store.accounts[store.active] ?? null
}

export function removeAccount(name: string): Store {
  const store = read()
  delete store.accounts[name]
  if (store.active === name) {
    const remaining = Object.keys(store.accounts)
    store.active = remaining.length > 0 ? remaining[0] : null
  }
  write(store)
  return store
}

export function switchAccount(name: string): Store | null {
  const store = read()
  if (!store.accounts[name]) return null
  store.active = name
  write(store)
  return store
}

export function getActiveKey(): string | null {
  const store = read()
  if (!store.active) return null
  const account = store.accounts[store.active]
  if (!account) return null
  return account.type === "api" ? account.key : null
}

export function listAccounts(): { name: string; active: boolean; label?: string; added: string }[] {
  const store = read()
  return Object.entries(store.accounts).map(([name, account]) => ({
    name,
    active: name === store.active,
    label: account.label,
    added: account.added,
  }))
}
