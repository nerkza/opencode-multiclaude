import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import * as Store from "./store.js"
import { createOAuthFlow, refreshAccessToken } from "./oauth.js"

const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

function readAuthJson(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
  } catch {
    return {}
  }
}

// 5-minute buffer before expiry to trigger refresh
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

/**
 * Custom fetch that reads the active account on every request.
 * - API key accounts: sets x-api-key header
 * - OAuth accounts: sets Authorization Bearer, handles token refresh
 */
async function dynamicFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const store = Store.read()
  const accountName = store.active
  if (!accountName) return globalThis.fetch(url, init)

  const account = store.accounts[accountName]
  if (!account) return globalThis.fetch(url, init)

  const headers = new Headers(init?.headers)

  if (account.type === "api") {
    headers.set("x-api-key", account.key)
  } else if (account.type === "oauth") {
    let { accessToken, refreshToken, expiresAt } = account

    // Refresh if token is expired or about to expire
    if (Date.now() > expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      try {
        const refreshed = await refreshAccessToken(accountName, refreshToken)
        accessToken = refreshed.accessToken
      } catch {
        // If refresh fails, try with the existing token anyway
      }
    }

    headers.delete("x-api-key")
    headers.set("Authorization", `Bearer ${accessToken}`)
  }

  return globalThis.fetch(url, { ...init, headers })
}

// State for pending OAuth flows (authorize → callback two-phase)
let pendingOAuthName: string | null = null

export const MultiAccountPlugin: Plugin = async (_input) => {
  return {
    auth: {
      provider: "anthropic",
      methods: [
        // Standard API key entry
        { type: "api", label: "Anthropic API Key" },

        // Hypothetical OAuth flow — see oauth.ts for full disclaimer.
        // This would appear in the /connect menu alongside the API key option.
        {
          type: "oauth" as const,
          label: "Claude Account (OAuth) [experimental]",
          prompts: [
            {
              type: "text" as const,
              key: "name",
              message: "Account name (e.g., work, personal)",
              placeholder: "personal",
              validate: (value: string) => {
                if (!value.trim()) return "Account name is required"
                if (Store.read().accounts[value]) return `Account "${value}" already exists`
                return undefined
              },
            },
          ],
          async authorize(inputs?: Record<string, string>) {
            const name = inputs?.name ?? "default"
            pendingOAuthName = name
            const flow = createOAuthFlow(name)
            return {
              url: flow.url,
              method: "auto" as const,
              instructions: flow.instructions,
              callback: flow.callback,
            }
          },
        },
      ],
      async loader(_getAuth, _provider) {
        const store = Store.read()
        if (!store.active || !store.accounts[store.active]) {
          return {}
        }
        const account = store.accounts[store.active]
        return {
          apiKey: account.type === "api" ? account.key : "opencode-multiclaude-oauth",
          fetch: dynamicFetch,
        }
      },
    },

    tool: {
      switch_claude_account: tool({
        description:
          "Switch the active Claude/Anthropic account. Use list_claude_accounts first to see available accounts.",
        args: {
          name: tool.schema.string().describe("The account name to switch to"),
        },
        async execute(args) {
          const result = Store.switchAccount(args.name)
          if (!result) {
            const accounts = Store.listAccounts()
            const names = accounts.map((a) => a.name).join(", ")
            return `Account "${args.name}" not found. Available accounts: ${names || "none"}`
          }
          const account = result.accounts[args.name]
          const authType = account.type === "oauth" ? " (OAuth)" : " (API key)"
          return `Switched to account "${args.name}"${authType}. The next request will use this account.`
        },
      }),

      list_claude_accounts: tool({
        description: "List all configured Claude/Anthropic accounts and show which one is active.",
        args: {},
        async execute() {
          const accounts = Store.listAccounts()
          if (accounts.length === 0) {
            return "No accounts configured. Use import_claude_account or add_claude_account to add one, or run /connect to set up OAuth."
          }
          const store = Store.read()
          const lines = accounts.map((a) => {
            const marker = a.active ? " (active)" : ""
            const label = a.label ? ` — ${a.label}` : ""
            const account = store.accounts[a.name]
            let authInfo: string
            if (account.type === "oauth") {
              const expired = Date.now() > account.expiresAt
              authInfo = `OAuth${expired ? " [expired]" : ""}`
            } else {
              authInfo = `sk-...${account.key.slice(-4)}`
            }
            return `- ${a.name}${marker}: ${authInfo}${label}`
          })
          return lines.join("\n")
        },
      }),

      import_claude_account: tool({
        description:
          "Import the currently active Anthropic API key (from ANTHROPIC_API_KEY env var or auth.json) into the multi-account store under a given name. This is the recommended way to add accounts without exposing the key in chat.",
        args: {
          name: tool.schema.string().describe("Account name (e.g., 'work', 'personal')"),
          label: tool.schema.string().optional().describe("Optional description for this account"),
        },
        async execute(args) {
          const existing = Store.read()
          if (existing.accounts[args.name]) {
            return `Account "${args.name}" already exists. Remove it first or choose a different name.`
          }

          let key = process.env.ANTHROPIC_API_KEY
          if (!key) {
            const authData = readAuthJson()
            const entry = authData["anthropic"]
            if (entry?.type === "api") key = entry.key
          }
          if (!key) {
            return "No Anthropic API key found. Set ANTHROPIC_API_KEY or run /connect for Anthropic first."
          }

          Store.addApiAccount(args.name, key, args.label)
          const isFirst = Object.keys(existing.accounts).length === 0
          return `Imported current key as account "${args.name}".${isFirst ? " It is now the active account." : ""}`
        },
      }),

      add_claude_account: tool({
        description:
          "Add a Claude/Anthropic account by providing an API key directly. Note: the key will appear in the session history. Prefer import_claude_account for better security.",
        args: {
          name: tool.schema.string().describe("Account name (e.g., 'work', 'personal')"),
          key: tool.schema.string().describe("Anthropic API key (starts with sk-ant-)"),
          label: tool.schema.string().optional().describe("Optional description for this account"),
        },
        async execute(args) {
          if (!args.key.startsWith("sk-ant-")) {
            return "Invalid key format. Anthropic API keys start with sk-ant-."
          }
          const existing = Store.read()
          if (existing.accounts[args.name]) {
            return `Account "${args.name}" already exists. Remove it first or choose a different name.`
          }
          Store.addApiAccount(args.name, args.key, args.label)
          const isFirst = Object.keys(existing.accounts).length === 0
          return `Added account "${args.name}".${isFirst ? " It is now the active account." : ""}`
        },
      }),

      remove_claude_account: tool({
        description: "Remove a Claude/Anthropic account from the multi-account store.",
        args: {
          name: tool.schema.string().describe("The account name to remove"),
        },
        async execute(args) {
          const before = Store.read()
          if (!before.accounts[args.name]) {
            return `Account "${args.name}" not found.`
          }
          const after = Store.removeAccount(args.name)
          const remaining = Object.keys(after.accounts).length
          let msg = `Removed account "${args.name}".`
          if (before.active === args.name && after.active) {
            msg += ` Active account switched to "${after.active}".`
          } else if (remaining === 0) {
            msg += " No accounts remaining — Anthropic will use default auth."
          }
          return msg
        },
      }),
    },
  }
}

export default MultiAccountPlugin
