/**
 * Hypothetical Anthropic OAuth implementation.
 *
 * This is a THEORETICAL module — Anthropic does not currently offer a public
 * OAuth program for third-party tools. Their OAuth flow (used by Claude Code
 * and Claude Desktop) is locked to first-party clients and actively rejects
 * tokens from third-party applications.
 *
 * This code models what the integration WOULD look like if Anthropic ever
 * published an OAuth Authorization Server with standard PKCE support,
 * following the same pattern used by OpenCode's Codex plugin for OpenAI.
 *
 * If Anthropic opens up OAuth in the future, replace the placeholder
 * endpoints and client ID below with the real values.
 */

import { randomBytes, createHash } from "crypto"
import * as Store from "./store.js"

// ---------------------------------------------------------------------------
// Placeholder endpoints — replace with real values if Anthropic opens OAuth
// ---------------------------------------------------------------------------
const AUTH_BASE = "https://auth.anthropic.com" // does not exist today
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const CLIENT_ID = "opencode-multiclaude" // would need to be registered
const REDIRECT_PORT = 19282
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`
const SCOPES = "api:read api:write"

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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
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
export function createOAuthFlow(accountName: string) {
  const { verifier, challenge } = generatePKCE()
  const state = generateState()

  const authorizeUrl = new URL(AUTHORIZE_URL)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("client_id", CLIENT_ID)
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI)
  authorizeUrl.searchParams.set("scope", SCOPES)
  authorizeUrl.searchParams.set("state", state)
  authorizeUrl.searchParams.set("code_challenge", challenge)
  authorizeUrl.searchParams.set("code_challenge_method", "S256")

  return {
    url: authorizeUrl.toString(),
    instructions: `Log in with your Anthropic account to add it as "${accountName}".`,

    /**
     * Start a local HTTP server to receive the OAuth callback,
     * exchange the authorization code for tokens, and store them.
     */
    async callback(): Promise<
      | { type: "success"; refresh: string; access: string; expires: number }
      | { type: "failed" }
    > {
      return new Promise((resolve) => {
        // In a real implementation, this would use Bun.serve() like the
        // Codex plugin does. Simplified here for clarity.
        const server = Bun.serve({
          port: REDIRECT_PORT,
          async fetch(req) {
            const url = new URL(req.url)
            if (url.pathname !== "/callback") {
              return new Response("Not found", { status: 404 })
            }

            const code = url.searchParams.get("code")
            const returnedState = url.searchParams.get("state")

            if (returnedState !== state || !code) {
              resolve({ type: "failed" })
              server.stop()
              return new Response("Authentication failed. You can close this tab.")
            }

            try {
              // Exchange authorization code for tokens
              const tokenRes = await globalThis.fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "authorization_code",
                  client_id: CLIENT_ID,
                  code,
                  redirect_uri: REDIRECT_URI,
                  code_verifier: verifier,
                }),
              })

              if (!tokenRes.ok) {
                resolve({ type: "failed" })
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

              resolve({
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
              resolve({ type: "failed" })
              server.stop()
              return new Response("Authentication error. You can close this tab.")
            }
          },
        })

        // Timeout after 5 minutes
        setTimeout(() => {
          resolve({ type: "failed" })
          server.stop()
        }, 5 * 60 * 1000)
      })
    },
  }
}
