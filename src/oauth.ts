/**
 * Anthropic OAuth implementation using PKCE.
 *
 * Uses the same OAuth endpoints and client ID as the Claude CLI.
 * Supports two modes:
 *   - "max"     → Claude Pro/Max accounts via claude.ai
 *   - "console" → API Console accounts via platform.claude.com
 */

import { randomBytes, createHash } from "crypto"
import * as Store from "./store.js"

// ---------------------------------------------------------------------------
// OAuth endpoints & configuration
// ---------------------------------------------------------------------------
export type OAuthMode = "max" | "console"

const AUTHORIZE_URLS: Record<OAuthMode, string> = {
  max: "https://claude.ai/oauth/authorize",
  console: "https://platform.claude.com/oauth/authorize",
}
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function generateState() {
  return randomBytes(16).toString("hex")
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------
export async function refreshAccessToken(
  accountName: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const res = await globalThis.fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "axios/1.13.6",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  Store.updateOAuthTokens(accountName, tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
  return tokens
}

// ---------------------------------------------------------------------------
// OAuth authorize flow (PKCE + local callback server)
// ---------------------------------------------------------------------------
export function createOAuthFlow(accountName: string, mode: OAuthMode = "max") {
  const { verifier, challenge } = generatePKCE()
  const state = generateState()

  // Start the callback server first so we know the port
  let resolveFlow: (
    value:
      | { type: "success"; refresh: string; access: string; expires: number }
      | { type: "failed" }
  ) => void

  const callbackPromise = new Promise<
    | { type: "success"; refresh: string; access: string; expires: number }
    | { type: "failed" }
  >((resolve) => {
    resolveFlow = resolve
  })

  // Use port 0 to let the OS assign a free port
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 })
      }

      const code = url.searchParams.get("code")
      const returnedState = url.searchParams.get("state")

      if (returnedState !== state || !code) {
        resolveFlow({ type: "failed" })
        server.stop()
        return new Response("Authentication failed. You can close this tab.")
      }

      try {
        const redirectUri = `http://localhost:${server.port}/callback`

        // Exchange authorization code for tokens
        const tokenRes = await globalThis.fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "axios/1.13.6",
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            state: returnedState,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }),
        })

        if (!tokenRes.ok) {
          resolveFlow({ type: "failed" })
          server.stop()
          return new Response("Token exchange failed. You can close this tab.")
        }

        const data = (await tokenRes.json()) as {
          access_token: string
          refresh_token: string
          expires_in: number
        }

        const expiresAt = Date.now() + data.expires_in * 1000

        Store.addOAuthAccount(accountName, data.access_token, data.refresh_token, expiresAt)

        resolveFlow({
          type: "success",
          refresh: data.refresh_token,
          access: data.access_token,
          expires: expiresAt,
        })

        server.stop()
        return new Response(
          "Authenticated successfully! You can close this tab and return to OpenCode.",
        )
      } catch {
        resolveFlow({ type: "failed" })
        server.stop()
        return new Response("Authentication error. You can close this tab.")
      }
    },
  })

  // Timeout after 5 minutes
  setTimeout(() => {
    resolveFlow({ type: "failed" })
    server.stop()
  }, 5 * 60 * 1000)

  const redirectUri = `http://localhost:${server.port}/callback`

  const authorizeUrl = new URL(AUTHORIZE_URLS[mode])
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("client_id", CLIENT_ID)
  authorizeUrl.searchParams.set("redirect_uri", redirectUri)
  authorizeUrl.searchParams.set("scope", SCOPES)
  authorizeUrl.searchParams.set("state", state)
  authorizeUrl.searchParams.set("code_challenge", challenge)
  authorizeUrl.searchParams.set("code_challenge_method", "S256")

  return {
    url: authorizeUrl.toString(),
    instructions: `Log in with your ${mode === "max" ? "Claude Pro/Max" : "Anthropic Console"} account to add it as "${accountName}".`,
    async callback() {
      return callbackPromise
    },
  }
}
