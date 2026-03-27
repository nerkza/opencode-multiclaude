import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const COMMANDS_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "opencode",
  "commands",
)

const COMMANDS: Record<string, string> = {
  "switch.md":
    'Switch to the Claude account named "$ACCOUNT" using the switch_claude_account tool.',
  "accounts.md":
    "List all configured Claude accounts using the list_claude_accounts tool.",
  "import-key.md":
    'Import the currently active Anthropic API key as an account named "$NAME" using the import_claude_account tool.',
  "remove-account.md":
    'Remove the Claude account named "$ACCOUNT" using the remove_claude_account tool.',
}

export function installCommands() {
  if (!existsSync(COMMANDS_DIR)) mkdirSync(COMMANDS_DIR, { recursive: true })

  for (const [filename, content] of Object.entries(COMMANDS)) {
    const filepath = join(COMMANDS_DIR, filename)
    if (!existsSync(filepath)) {
      writeFileSync(filepath, content)
    }
  }
}
