# OpenCode-MultiClaude

A plugin for [OpenCode](https://github.com/anomalyco/opencode) that lets you manage and switch between multiple Claude/Anthropic accounts within a single session. Supports API keys and includes an experimental OAuth module.

## Why?

OpenCode supports one API key per provider. If you have separate Anthropic keys for work, personal projects, or different organizations, you need to restart OpenCode and swap environment variables each time. This plugin adds named accounts with instant switching — no restart required.

## Installation

### From npm

```bash
# Add to your opencode.json
{
  "plugin": ["opencode-multiclaude"]
}
```

### From source

Clone the repo, then reference it as a local plugin:

```bash
git clone https://github.com/nerkza/opencode-multiclaude.git
```

```json
{
  "plugin": ["file:///path/to/opencode-multiclaude"]
}
```

## Setup

### 1. Import your existing key

Start OpenCode with your `ANTHROPIC_API_KEY` environment variable set as usual, then ask the agent:

> Import my current Anthropic key as "work"

This saves the key from your environment (or `auth.json`) into the multi-account store without it ever appearing in chat history.

### 2. Add more accounts

Set a different `ANTHROPIC_API_KEY` and restart OpenCode, then import again:

> Import my current key as "personal"

Or add a key directly (note: the key will be visible in session history):

> Add a Claude account called "side-project" with key sk-ant-...

### 3. Switch accounts

> Switch to my personal Claude account

> List my Claude accounts

That's it. Switching takes effect on the next API call within the same session.

## Tools

The plugin exposes five tools that the AI agent can call:

| Tool | Description |
|------|-------------|
| `import_claude_account` | Import the active key from `ANTHROPIC_API_KEY` or `auth.json` under a name. Recommended — the key never appears in chat. |
| `add_claude_account` | Add an account with a key provided directly. |
| `list_claude_accounts` | Show all accounts with an active marker and key preview (last 4 chars). |
| `switch_claude_account` | Switch the active account. Takes effect on the next API request. |
| `remove_claude_account` | Remove an account. Automatically falls back to the next available account. |

## OAuth Support (Experimental)

The plugin includes an experimental OAuth module that models what Anthropic OAuth integration would look like. When you run `/connect` in OpenCode with this plugin installed, you'll see two options:

1. **Anthropic API Key** — standard API key entry (works today)
2. **Claude Account (OAuth) [experimental]** — browser-based OAuth login

### How the OAuth flow works

The OAuth method uses a standard **PKCE authorization code flow**:

1. You're prompted for an account name
2. A browser window opens to Anthropic's authorization page
3. A local callback server on port 19282 receives the redirect
4. The authorization code is exchanged for access + refresh tokens
5. Tokens are stored in the multi-account store with automatic refresh

The custom `fetch()` handler transparently manages token lifecycle — it checks expiry before each request and refreshes tokens with a 5-minute buffer.

## How it works

- Accounts are stored in `~/.local/share/opencode/multi-account.json` with `0600` file permissions.
- The plugin registers an auth hook for the `anthropic` provider. When an active account exists in the store, the hook injects a custom `fetch()` function that reads the active account on every API request — this is what enables mid-session switching without restarting.
- For **API key accounts**, the fetch sets the `x-api-key` header.
- For **OAuth accounts**, the fetch sets `Authorization: Bearer <token>` and handles automatic token refresh when the access token is near expiry.
- When no accounts are configured, the plugin is transparent and default Anthropic auth (env var, `/connect`, config) works as normal.

## Credential storage

Credentials are stored separately from OpenCode's `auth.json` to avoid conflicts with the single-key-per-provider schema. The store supports both account types:

```json
{
  "active": "work",
  "accounts": {
    "work": {
      "type": "api",
      "key": "sk-ant-...",
      "added": "2026-03-27T10:00:00.000Z",
      "label": "Acme Corp workspace"
    },
    "personal": {
      "type": "oauth",
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1743100000000,
      "added": "2026-03-27T10:05:00.000Z"
    }
  }
}
```

The file is created at `~/.local/share/opencode/multi-account.json` with owner-only read/write permissions.

## Requirements

- [OpenCode](https://github.com/anomalyco/opencode) v1.0.0+
- An Anthropic API key (one or more)
- For OAuth: a browser for the redirect flow (Anthropic does not currently expose public OAuth endpoints — see above)

## Known limitations

- **No GUI for account management** - all interaction is through natural language via the AI agent's tools. A future version could add a `/switch` TUI command.
- **Auth hook exclusivity** — the plugin registers as the auth handler for `anthropic`. If OpenCode adds a built-in Anthropic auth plugin in the future, they would conflict. This is not currently an issue as no built-in Anthropic auth plugin exists.

## License

MIT
