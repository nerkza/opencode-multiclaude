# OpenCode-MultiClaude

A plugin for [OpenCode](https://github.com/anomalyco/opencode) that lets you manage and switch between multiple Claude/Anthropic accounts within a single session. Supports both OAuth (Claude Pro/Max and Console) and API keys.

## Why?

OpenCode supports one API key per provider. If you have separate Anthropic accounts for work, personal projects, or different organizations, you need to restart OpenCode and swap credentials each time. This plugin adds named accounts with instant switching — no restart required.

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

### Adding accounts via OAuth

The recommended way to add accounts. Run the CLI from your terminal:

```bash
bun run /path/to/opencode-multiclaude/src/cli.ts oauth personal
```

This will:

1. Print an authorization URL — open it in your browser
2. You log in with your Claude Pro/Max account and authorize
3. The callback is handled automatically and tokens are stored
4. The account is ready to use in OpenCode

You can also specify the `console` mode for Anthropic Console accounts:

```bash
bun run /path/to/opencode-multiclaude/src/cli.ts oauth work console
```

OAuth is also available through OpenCode's `/connect` menu, which shows "Claude Pro/Max" and "Anthropic Console" options when this plugin is installed.

### Adding accounts via API key

Import your currently active key (from `ANTHROPIC_API_KEY` or `auth.json`):

```
/import-key work
```

Or add a key directly (note: the key will be visible in session history):

> Add a Claude account called "side-project" with key sk-ant-...

### Switching accounts

```
/switch personal
/accounts
```

Switching takes effect on the next API call within the same session.

## Commands

Add these to the `command` section of your `opencode.json`:

```json
{
  "command": {
    "switch": {
      "template": "Switch to the Claude account named \"$1\" using the switch_claude_account tool.",
      "description": "Switch active Claude account"
    },
    "accounts": {
      "template": "List all configured Claude accounts using the list_claude_accounts tool. Show the results to me.",
      "description": "List all Claude accounts"
    },
    "import-key": {
      "template": "Import the currently active Anthropic API key as an account named \"$1\" using the import_claude_account tool.",
      "description": "Import current API key as a named account"
    },
    "remove-account": {
      "template": "Remove the Claude account named \"$1\" using the remove_claude_account tool.",
      "description": "Remove a Claude account"
    }
  }
}
```

## CLI

The plugin includes a standalone CLI for operations that are easier outside of OpenCode:

```bash
bun run src/cli.ts <command> [args]
```

| Command | Usage | Description |
|---------|-------|-------------|
| `oauth` | `oauth personal [max\|console]` | Add an account via OAuth browser login |
| `add` | `add work [key]` | Add an account with an API key (prompts if omitted) |
| `switch` | `switch personal` | Switch the active account |
| `list` | `list` | List all accounts |
| `remove` | `remove old` | Remove an account |

## Tools

The plugin exposes tools that the AI agent can call directly:

| Tool | Description |
|------|-------------|
| `import_claude_account` | Import the active key from `ANTHROPIC_API_KEY` or `auth.json` under a name. The key never appears in chat. |
| `add_claude_account` | Add an account with a key provided directly. |
| `list_claude_accounts` | Show all accounts with active marker and auth type. |
| `switch_claude_account` | Switch the active account. Takes effect on the next API request. |
| `connect_claude_oauth` | Start an OAuth flow and return the authorization URL. |
| `remove_claude_account` | Remove an account. Falls back to the next available account. |

## How OAuth works

The OAuth flow uses the same endpoints and client ID as the Claude CLI:

- **Claude Pro/Max** authenticates via `claude.ai/oauth/authorize`
- **Anthropic Console** authenticates via `platform.claude.com/oauth/authorize`
- Tokens are exchanged at `platform.claude.com/v1/oauth/token`

The flow uses **PKCE** (Proof Key for Code Exchange):

1. A local callback server starts on a random port
2. A browser URL is generated with the PKCE challenge
3. After you authorize, the callback server receives the code
4. The code is exchanged for access + refresh tokens
5. Tokens are stored and automatically refreshed before expiry

For OAuth accounts, the plugin's custom `fetch()` handler:

- Sets `Authorization: Bearer <token>` and required beta headers
- Prefixes tool names with `mcp_` in requests and strips them from responses
- Appends `?beta=true` to `/v1/messages` requests
- Handles automatic token refresh with retry logic

## How it works

- Accounts are stored in `~/.local/share/opencode/multi-account.json` with `0600` file permissions.
- The plugin registers an auth hook for the `anthropic` provider with a custom `fetch()` function that reads the active account on every API request — this enables mid-session switching without restarting.
- For **API key accounts**, the fetch sets the `x-api-key` header.
- For **OAuth accounts**, the fetch handles the full request/response transformation pipeline required by the Anthropic OAuth API.
- OAuth tokens are synced to OpenCode's built-in auth store via `client.auth.set()`, ensuring compatibility with OpenCode's auth lifecycle.
- When no accounts are configured, the plugin is transparent and default Anthropic auth works as normal.

## Credential storage

Credentials are stored separately from OpenCode's `auth.json` to support multiple accounts:

```json
{
  "active": "work",
  "accounts": {
    "work": {
      "type": "oauth",
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1743100000000,
      "added": "2026-03-27T10:00:00.000Z"
    },
    "personal": {
      "type": "api",
      "key": "sk-ant-...",
      "added": "2026-03-27T10:05:00.000Z",
      "label": "Personal projects"
    }
  }
}
```

## Requirements

- [OpenCode](https://github.com/anomalyco/opencode) v1.0.0+
- [Bun](https://bun.sh) runtime
- For OAuth: a browser for the authorization flow
- For API keys: one or more Anthropic API keys

## Known limitations

- **Auth hook exclusivity** — the plugin registers as the auth handler for `anthropic`. If another plugin does the same, they would conflict.
- **OAuth model costs** — OAuth accounts zero out model costs in the OpenCode UI since usage is included in Pro/Max plans.

## License

MIT
