#!/usr/bin/env bun
import * as Store from "./store.js"
import { createOAuthFlow, type OAuthMode } from "./oauth.js"

const [command, ...args] = process.argv.slice(2)

function usage() {
  console.log(`Usage:
  multiclaude oauth <name> [mode]  Add account via OAuth (mode: max|console, default: max)
  multiclaude add <name> [key]     Add an account with API key (prompts if omitted)
  multiclaude switch <name>        Switch active account
  multiclaude list                 List all accounts
  multiclaude remove <name>        Remove an account`)
  process.exit(1)
}

async function promptKey(): Promise<string> {
  process.stdout.write("Anthropic API key: ")
  const buf: Buffer[] = []
  for await (const chunk of process.stdin) {
    buf.push(chunk)
    if (chunk.includes(10)) break // newline
  }
  return Buffer.concat(buf).toString().trim()
}

async function main() {
  switch (command) {
    case "oauth": {
      const name = args[0]
      if (!name) usage()
      const mode = (args[1] ?? "max") as OAuthMode
      if (mode !== "max" && mode !== "console") {
        console.error(`Invalid mode "${mode}". Use "max" or "console".`)
        process.exit(1)
      }
      const existing = Store.read()
      if (existing.accounts[name]) {
        console.error(`Account "${name}" already exists. Remove it first.`)
        process.exit(1)
      }

      const flow = createOAuthFlow(name, mode)
      console.log(`\nOpen this link in your browser:\n`)
      console.log(`  ${flow.url}\n`)
      console.log(flow.instructions)
      console.log(`\nWaiting for authentication... (times out in 5 minutes)\n`)

      const result = await flow.callback()
      if (result.type === "success") {
        console.log(`Account "${name}" authenticated successfully!`)
        console.log(`Run "multiclaude switch ${name}" or use /switch ${name} in OpenCode.`)
      } else {
        console.error("Authentication failed or timed out.")
        process.exit(1)
      }
      break
    }

    case "add": {
      const name = args[0]
      if (!name) usage()
      let key = args[1]
      if (!key) key = await promptKey()
      if (!key) {
        console.error("No key provided.")
        process.exit(1)
      }
      const existing = Store.read()
      if (existing.accounts[name]) {
        console.error(`Account "${name}" already exists. Remove it first.`)
        process.exit(1)
      }
      Store.addApiAccount(name, key)
      const isFirst = Object.keys(existing.accounts).length === 0
      console.log(`Added account "${name}".${isFirst ? " Set as active." : ""}`)
      break
    }

    case "switch": {
      const name = args[0]
      if (!name) usage()
      const result = Store.switchAccount(name)
      if (!result) {
        console.error(`Account "${name}" not found.`)
        process.exit(1)
      }
      console.log(`Switched to "${name}".`)
      break
    }

    case "list": {
      const accounts = Store.listAccounts()
      if (accounts.length === 0) {
        console.log("No accounts configured. Run: multiclaude add <name>")
        break
      }
      const store = Store.read()
      for (const a of accounts) {
        const marker = a.active ? " (active)" : ""
        const account = store.accounts[a.name]
        const info = account.type === "oauth" ? "OAuth" : `sk-...${account.key.slice(-4)}`
        console.log(`  ${a.name}${marker}: ${info}`)
      }
      break
    }

    case "remove": {
      const name = args[0]
      if (!name) usage()
      const before = Store.read()
      if (!before.accounts[name]) {
        console.error(`Account "${name}" not found.`)
        process.exit(1)
      }
      const after = Store.removeAccount(name)
      console.log(`Removed "${name}".${after.active ? ` Active account: "${after.active}".` : ""}`)
      break
    }

    default:
      usage()
  }
}

main()
