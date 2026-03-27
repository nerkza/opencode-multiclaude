import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const DEBUG_LOG = "/tmp/opencode-multiclaude.log"
function debug(msg: string) {
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}
import * as Store from "./store.js"
import { createOAuthFlow, type OAuthMode } from "./oauth.js"
import { installCommands } from "./commands.js"

const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

function readAuthJson(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
  } catch {
    return {}
  }
}

// Required headers/betas for OAuth requests to the Anthropic API
const REQUIRED_BETAS = "oauth-2025-04-20,interleaved-thinking-2025-05-14"
const OAUTH_USER_AGENT = "claude-cli/2.1.2 (external, cli)"
const MCP_PREFIX = "mcp_"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Prefix tool names in request body with "mcp_" — required for OAuth API calls.
 */
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

/**
 * Strip "mcp_" prefix from tool names in response chunks.
 */
function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_/g, '"name":"')
}

/**
 * Wrap a response to strip mcp_ prefixes from streamed tool names.
 */
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

/**
 * Rewrite URL to add ?beta=true for /v1/messages (required for OAuth).
 */
function rewriteUrl(input: string | URL | Request): { input: string | URL | Request } {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (!urlStr.includes("/v1/messages") || urlStr.includes("beta=true")) return { input }
  const sep = urlStr.includes("?") ? "&" : "?"
  const newUrl = `${urlStr}${sep}beta=true`
  if (typeof input === "string") return { input: newUrl }
  if (input instanceof URL) return { input: new URL(newUrl) }
  return { input: newUrl }
}

/**
 * Merge headers from a Request object and init headers into a single Headers.
 */
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

// State for pending OAuth flows
let pendingOAuthName: string | null = null

export const MultiAccountPlugin: Plugin = async ({ client }) => {
  installCommands()

  /**
   * Update OpenCode's auth store with tokens from our multi-account store.
   * This syncs our active account into OpenCode's auth system.
   */
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
    // The OAuth token is scoped to Claude Code — the API validates this prefix
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
        debug(`loader: auth.type=${auth.type}, hasAccess=${!!auth.access}, hasRefresh=${!!auth.refresh}, expires=${auth.expires}`)

        if (auth.type === "oauth") {
          // Zero out model costs (included in Pro/Max plan)
          if (provider?.models) {
            for (const model of Object.values(provider.models) as any[]) {
              model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
            }
          }

          return {
            apiKey: "",
            async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
              try {
              const auth = await getAuth()
              debug(`fetch: auth.type=${auth.type}, url=${typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url}`)
              if (auth.type !== "oauth") return fetch(input, init)

              // Refresh if expired or missing
              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                debug(`fetch: token expired or missing, refreshing...`)
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
                      throw new Error(`Token refresh failed: ${response.status}`)
                    }

                    const json = (await response.json()) as {
                      refresh_token: string
                      access_token: string
                      expires_in: number
                    }

                    const newExpires = Date.now() + json.expires_in * 1000

                    await (client as any).auth.set({
                      path: { id: "anthropic" },
                      body: {
                        type: "oauth",
                        refresh: json.refresh_token,
                        access: json.access_token,
                        expires: newExpires,
                      },
                    })

                    // Also update our multi-account store
                    const store = Store.read()
                    if (store.active) {
                      Store.updateOAuthTokens(
                        store.active,
                        json.access_token,
                        json.refresh_token,
                        newExpires,
                      )
                    }

                    auth.access = json.access_token
                    break
                  } catch (error) {
                    const isNetworkError =
                      error instanceof Error &&
                      (error.message.includes("fetch failed") ||
                        ("code" in error &&
                          ((error as any).code === "ECONNRESET" ||
                            (error as any).code === "ECONNREFUSED" ||
                            (error as any).code === "ETIMEDOUT")))

                    if (attempt < maxRetries && isNetworkError) continue
                    throw error
                  }
                }
              }

              // Transform headers
              const requestHeaders = mergeHeaders(input, init)
              requestHeaders.delete("x-api-key")
              requestHeaders.set("Authorization", `Bearer ${auth.access}`)
              requestHeaders.set("anthropic-beta", REQUIRED_BETAS)
              requestHeaders.set("User-Agent", OAUTH_USER_AGENT)

              // Prefix tool names in request body
              let body = init?.body
              if (body && typeof body === "string") {
                body = prefixToolNames(body)
              }

              // Rewrite URL
              const rewritten = rewriteUrl(input)

              debug(`fetch: making request to ${typeof rewritten.input === 'string' ? rewritten.input : 'non-string'}`)
              const hdrs: Record<string, string> = {}
              requestHeaders.forEach((v, k) => { hdrs[k] = k === 'authorization' ? v.slice(0, 30) + '...' : v })
              debug(`fetch: headers=${JSON.stringify(hdrs)}`)
              if (body && typeof body === 'string') {
                debug(`fetch: body snippet=${body.slice(0, 300)}`)
              } else {
                debug(`fetch: body type=${typeof body}, is null/undefined=${body == null}`)
              }
              const response = await fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
              })

              debug(`fetch: response status=${response.status} ${response.statusText}`)
              if (!response.ok) {
                const clone = response.clone()
                try {
                  const errBody = await clone.text()
                  debug(`fetch: error body=${errBody.slice(0, 500)}`)
                } catch {}
              }

              // Strip mcp_ prefix from response
              return createStrippedResponse(response)
              } catch (err: any) {
                debug(`fetch: EXCEPTION ${err?.message ?? err}`)
                throw err
              }
            },
          }
        }

        // For API key auth, check our store for multi-account support
        const store = Store.read()
        if (store.active && store.accounts[store.active]?.type === "api") {
          return { apiKey: (store.accounts[store.active] as Store.ApiAccount).key }
        }

        return {}
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
          // Sync the new active account into OpenCode's auth
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

          // Fire-and-forget: when the user completes auth in the browser,
          // the callback server stores the tokens and syncs to OpenCode
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
