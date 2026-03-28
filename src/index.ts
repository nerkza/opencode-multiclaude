import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import * as Store from "./store.js"
import { createOAuthFlow, type OAuthMode } from "./oauth.js"
import { installCommands } from "./commands.js"
import {
  shouldAutoSwitch,
  setCooldown,
  parseRetryAfter,
  getNextAvailableAccount,
} from "./cooldown.js"

const DEBUG_LOG = "/tmp/opencode-multiclaude.log"
function debug(msg: string) {
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

function readAuthJson(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REQUIRED_BETAS = "oauth-2025-04-20,interleaved-thinking-2025-05-14"
const OAUTH_USER_AGENT = "claude-cli/2.1.2 (external, cli)"
const MCP_PREFIX = "mcp_"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

// ---------------------------------------------------------------------------
// Request / response helpers
// ---------------------------------------------------------------------------

function prefixToolNames(body: string): string {
  try {
    const json = JSON.parse(body)
    if (Array.isArray(json.tools)) {
      for (const t of json.tools) {
        if (t.name && !t.name.startsWith(MCP_PREFIX)) {
          t.name = `${MCP_PREFIX}${t.name}`
        }
      }
    }
    if (Array.isArray(json.messages)) {
      for (const msg of json.messages) {
        if (!Array.isArray(msg.content)) continue
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.name && !block.name.startsWith(MCP_PREFIX)) {
            block.name = `${MCP_PREFIX}${block.name}`
          }
        }
      }
    }
    return JSON.stringify(json)
  } catch {
    return body
  }
}

function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_/g, '"name":"')
}

function createStrippedResponse(response: Response): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      const text = decoder.decode(value, { stream: true })
      controller.enqueue(encoder.encode(stripToolPrefix(text)))
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function mergeHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers()
  if (input instanceof Request) {
    input.headers.forEach((v, k) => headers.set(k, v))
  }
  if (init?.headers) {
    const initHeaders = new Headers(init.headers)
    initHeaders.forEach((v, k) => headers.set(k, v))
  }
  return headers
}

function rewriteUrl(input: string | URL | Request): { input: string | URL | Request } {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (!urlStr.includes("/v1/messages") || urlStr.includes("beta=true")) return { input }
  const sep = urlStr.includes("?") ? "&" : "?"
  const newUrl = `${urlStr}${sep}beta=true`
  if (typeof input === "string") return { input: newUrl }
  if (input instanceof URL) return { input: new URL(newUrl) }
  return { input: newUrl }
}

// ---------------------------------------------------------------------------
// Request preparation per account type
// ---------------------------------------------------------------------------

function prepareOAuthRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  originalBody: string | null,
  accessToken: string,
): { url: string | URL | Request; options: RequestInit } {
  const headers = mergeHeaders(input, init)
  headers.delete("x-api-key")
  headers.set("Authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-beta", REQUIRED_BETAS)
  headers.set("User-Agent", OAUTH_USER_AGENT)

  let body: any = originalBody != null ? prefixToolNames(originalBody) : init?.body
  const rewritten = rewriteUrl(input)

  return {
    url: rewritten.input,
    options: { ...init, body, headers },
  }
}

function prepareApiKeyRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  originalBody: string | null,
  apiKey: string,
): { url: string | URL | Request; options: RequestInit } {
  const headers = mergeHeaders(input, init)
  headers.delete("Authorization")
  headers.set("x-api-key", apiKey)

  const body: any = originalBody ?? init?.body

  return {
    url: input,
    options: { ...init, body, headers },
  }
}

function wrapResponse(response: Response, accountType: "oauth" | "api"): Response {
  if (accountType === "oauth") return createStrippedResponse(response)
  return response
}

// ---------------------------------------------------------------------------
// OAuth token refresh
// ---------------------------------------------------------------------------

async function refreshOAuthToken(
  auth: { refresh?: string },
  accountName: string,
  clientObj: any,
): Promise<string | null> {
  if (!auth.refresh) return null

  const maxRetries = 2
  const baseDelayMs = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)))
      }

      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          "User-Agent": "axios/1.13.6",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: auth.refresh,
          client_id: CLIENT_ID,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel()
          continue
        }
        debug(`refreshOAuthToken: failed with status ${response.status}`)
        return null
      }

      const json = (await response.json()) as {
        refresh_token: string
        access_token: string
        expires_in: number
      }

      const newExpires = Date.now() + json.expires_in * 1000

      await clientObj.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: json.refresh_token,
          access: json.access_token,
          expires: newExpires,
        },
      })

      Store.updateOAuthTokens(accountName, json.access_token, json.refresh_token, newExpires)
      debug(`refreshOAuthToken: success for ${accountName}`)
      return json.access_token
    } catch (error) {
      const isNetworkError =
        error instanceof Error &&
        (error.message.includes("fetch failed") ||
          ("code" in error &&
            ((error as any).code === "ECONNRESET" ||
              (error as any).code === "ECONNREFUSED" ||
              (error as any).code === "ETIMEDOUT")))

      if (attempt < maxRetries && isNetworkError) continue
      debug(`refreshOAuthToken: exception ${error instanceof Error ? error.message : error}`)
      return null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Get access token for an account, handling refresh if needed
// ---------------------------------------------------------------------------

async function getAccessToken(
  accountName: string,
  account: Store.OAuthAccount,
  getAuth: () => Promise<{ type: string; access?: string; refresh?: string; expires?: number }>,
  clientObj: any,
): Promise<string | null> {
  const auth = await getAuth()

  if (auth.access && auth.expires && auth.expires > Date.now()) {
    return auth.access
  }

  // Token expired or missing — try refresh
  return refreshOAuthToken(auth, accountName, clientObj)
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

let pendingOAuthName: string | null = null

export const MultiAccountPlugin: Plugin = async ({ client }) => {
  installCommands()

  async function syncAuthToOpenCode(accountName: string) {
    const store = Store.read()
    const account = store.accounts[accountName]
    if (!account) return

    if (account.type === "oauth") {
      await (client as any).auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: account.refreshToken,
          access: account.accessToken,
          expires: account.expiresAt,
        },
      })
    } else if (account.type === "api") {
      await (client as any).auth.set({
        path: { id: "anthropic" },
        body: {
          type: "api",
          key: account.key,
        },
      })
    }
  }

  return {
    'experimental.chat.system.transform': (
      input: { model?: { providerID?: string } },
      output: { system: string[] },
    ) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (input.model?.providerID === 'anthropic') {
        output.system.unshift(prefix)
        if (output.system[1])
          output.system[1] = `${prefix}\n\n${output.system[1]}`
      }
    },
    auth: {
      provider: "anthropic",
      methods: [
        { type: "api", label: "Anthropic API Key" },
        {
          type: "oauth" as const,
          label: "Claude Pro/Max",
          async authorize() {
            const name = `oauth-${Date.now()}`
            pendingOAuthName = name
            const flow = createOAuthFlow(name, "max")
            return {
              url: flow.url,
              method: "auto" as const,
              instructions: "Complete authorization in the browser.",
              callback: flow.callback,
            }
          },
        },
        {
          type: "oauth" as const,
          label: "Anthropic Console",
          async authorize() {
            const name = `oauth-${Date.now()}`
            pendingOAuthName = name
            const flow = createOAuthFlow(name, "console")
            return {
              url: flow.url,
              method: "auto" as const,
              instructions: "Complete authorization in the browser.",
              callback: flow.callback,
            }
          },
        },
      ],
      async loader(
        getAuth: () => Promise<{ type: string; access?: string; refresh?: string; expires?: number }>,
        provider: any,
      ) {
        debug(`loader called`)
        const auth = await getAuth()
        debug(`loader: auth.type=${auth.type}`)

        // Zero out model costs for OAuth (included in Pro/Max plan)
        if (auth.type === "oauth" && provider?.models) {
          for (const model of Object.values(provider.models) as any[]) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
          }
        }

        // Always return a custom fetch so we can auto-switch between any account types
        return {
          apiKey: "",
          async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
            // Capture original body for potential retries
            const originalBody = (init?.body && typeof init.body === "string") ? init.body : null
            const inputUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

            let store = Store.read()
            let accountName = store.active
            let account = accountName ? store.accounts[accountName] : null

            if (!account || !accountName) {
              debug(`fetch: no active account, falling through`)
              return fetch(input, init)
            }

            const triedAccounts = new Set<string>()
            let lastResponse: Response | null = null

            while (account && accountName && !triedAccounts.has(accountName)) {
              triedAccounts.add(accountName)

              try {
                let prepared: { url: string | URL | Request; options: RequestInit }

                if (account.type === "oauth") {
                  // Get a valid access token (refresh if needed)
                  const accessToken = await getAccessToken(accountName, account, getAuth, client as any)
                  if (!accessToken) {
                    // Refresh failed — treat as unavailable
                    debug(`fetch: OAuth refresh failed for ${accountName}, trying next account`)
                    setCooldown(accountName, 401)

                    const nextName = getNextAvailableAccount(accountName, store)
                    if (!nextName) break

                    Store.switchAccount(nextName)
                    await syncAuthToOpenCode(nextName)
                    debug(`auto-switch: ${accountName} -> ${nextName} (refresh failed)`)

                    store = Store.read()
                    accountName = nextName
                    account = store.accounts[nextName]
                    continue
                  }

                  prepared = prepareOAuthRequest(input, init, originalBody, accessToken)
                } else {
                  prepared = prepareApiKeyRequest(input, init, originalBody, account.key)
                }

                debug(`fetch: ${accountName} (${account.type}) -> ${inputUrl}`)
                const response = await fetch(prepared.url, prepared.options)
                debug(`fetch: response ${response.status} ${response.statusText}`)

                // Check if we should auto-switch
                if (shouldAutoSwitch(response)) {
                  const retryAfter = parseRetryAfter(response)
                  setCooldown(accountName, response.status, retryAfter)
                  debug(`auto-switch: ${accountName} got ${response.status}, cooldown set`)

                  const nextName = getNextAvailableAccount(accountName, store)
                  if (!nextName) {
                    debug(`auto-switch: no available accounts, returning error`)
                    return wrapResponse(response, account.type)
                  }

                  // Discard the error response
                  await response.body?.cancel()

                  Store.switchAccount(nextName)
                  await syncAuthToOpenCode(nextName)
                  debug(`auto-switch: ${accountName} -> ${nextName} (status ${response.status})`)

                  store = Store.read()
                  accountName = nextName
                  account = store.accounts[nextName]
                  lastResponse = null
                  continue
                }

                if (!response.ok) {
                  const clone = response.clone()
                  try {
                    const errBody = await clone.text()
                    debug(`fetch: error body=${errBody.slice(0, 500)}`)
                  } catch {}
                }

                return wrapResponse(response, account.type)
              } catch (err: any) {
                debug(`fetch: EXCEPTION for ${accountName}: ${err?.message ?? err}`)
                throw err
              }
            }

            // All accounts tried — return the last error or fall through
            if (lastResponse) return lastResponse
            debug(`fetch: all accounts exhausted`)
            return fetch(input, init)
          },
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
          await syncAuthToOpenCode(args.name)
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

      connect_claude_oauth: tool({
        description:
          "Add a new Claude/Anthropic account via OAuth login. Returns a URL the user must open in their browser. After they authenticate, the account is saved automatically. IMPORTANT: Show the full URL to the user so they can click it.",
        args: {
          name: tool.schema.string().describe("Account name (e.g., 'work', 'personal')"),
          mode: tool.schema
            .enum(["max", "console"])
            .optional()
            .describe("OAuth mode: 'max' for Claude Pro/Max, 'console' for API Console (default: max)"),
        },
        async execute(args) {
          const existing = Store.read()
          if (existing.accounts[args.name]) {
            return `Account "${args.name}" already exists. Remove it first or choose a different name.`
          }

          const mode = (args.mode ?? "max") as OAuthMode
          const flow = createOAuthFlow(args.name, mode)

          flow.callback().then(async (result) => {
            if (result.type === "success") {
              await syncAuthToOpenCode(args.name)
              debug(`connect_claude_oauth: ${args.name} authenticated successfully`)
            } else {
              debug(`connect_claude_oauth: ${args.name} auth failed or timed out`)
            }
          })

          return [
            `Open this link to authenticate as "${args.name}":`,
            "",
            flow.url,
            "",
            flow.instructions,
            "",
            "After you complete login in the browser, use list_claude_accounts to verify, then switch_claude_account to activate it.",
          ].join("\n")
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
            await syncAuthToOpenCode(after.active)
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
