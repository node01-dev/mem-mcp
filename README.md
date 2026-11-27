# mem-mcp

[![npm version](https://img.shields.io/npm/v/mem-mcp)](https://www.npmjs.com/package/mem-mcp)
[![npm downloads](https://img.shields.io/npm/dm/mem-mcp)](https://www.npmjs.com/package/mem-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

MCP wrapper for [Memory01](https://memory.node01.org) — agentic memory for AI agents.

## Why Memory?

Your AI agent starts from zero every session. It re-reads the same conversation,
re-fetches the same docs, re-asks the same questions. You burn tokens on context
you already had. You lose the user's preferences, the project's decisions, the
"why" behind the last change.

Memory01 gives your agent a brain that survives reboots:

- **Store once, recall forever** — facts, preferences, style, decisions
- **Semantic search** — find the right memory by meaning, not keywords
- **Base memories** — persistent context (preferences, style) loaded at session start
- **No infrastructure** — no database, no Redis, no vector store to manage
- **Free to start** — 30 searches/day free, store is always free

## Features

Plain-English, no jargon:

- **Persistent memory**: your AI agent remembers facts, preferences, decisions and context between sessions. Store is always free.
- **Cheap + no signup**: no API keys, no accounts, no database to run. First 30 searches a day are free; beyond that $0.01 USDC per search on Base (x402). Works with Claude, OpenCode, Cursor, ChatGPT, any MCP client.
- **Search by meaning**: across 50+ languages. Store once, recall by what it means, not exact words. Keyword + semantic + connections, optional hybrid re-ranking; minimum score; scope to parts of memory.
- **Upsert**: saving with the same key updates in place; no duplicates.
- **Base memories**: small always-there context (style, preferences, details); bootstrap conventional keys.
- **Scoped memories**: per agent; optional per-session; conventional `credentials-location` pointer (never secrets).
- **Portable backups**: `export`, `import`, `forget`. Readable `mem01-memory@1`; nothing hidden.
- **History & time travel**: records when a memory was added/changed; `as_of` "what we knew then"; mark outdated instead of delete; undo + restore earlier version; no silent overwrite.
- **Connections (typed links)**: link memories ("causes", "contradicts", "refers to", "owns", ...); follow connections.
- **Memory for code (CODE-MEMORY `.mem01`)**: save code snippets, not just notes — function/class/file, language, project, tests, docs, cleaned vs original. Search code, find usages, project map, rename symbol, recall past code. Original preserved; no secrets.
- **Optional dreaming ("ideate")**: off by default. Reads your memories and suggests ONE new idea (connection/question/next step). Does NOT reorganize or change memory. Saved separately; find later by date/topic/label; delete; label e.g. bad-dream. Optional local or free model; nothing sensitive sent.
- **Recovery + strong auth**: recovery code; optional Ed25519 key so your token works across networks; invalid/expired signatures rejected. Credentials kept offline; never inside memories.
- **Subscriptions**: optional paid plans (Starter/Pro/Enterprise); core stays free.
- **MCP-native**: one `npx mem-mcp`, multi-client; no infrastructure.


## Auto-update

MCP clients do not auto-update servers. To always use the latest version:

- **Recommended config**: use `npx -y mem-mcp@latest` in your MCP config. npx checks the registry on each launch (cached, fast).
- **Global install**: run `npm install -g mem-mcp@latest` periodically, or `npm update -g mem-mcp`. Use the `mem-mcp` binary in your MCP config for offline startup.
- The server prints a note on startup if a newer version is available.

## Try It Now (30 seconds)

No config, no wallet, no signup. Just run:

```bash
npx -y mem-mcp@latest
```

Then call the `sample` tool — it stores a demo memory and searches it, showing you the shape of responses without paying anything.

## One-command setup

After installing, tell your agent:

> Install `mem-mcp` and call the `init` tool with your agentId. It will set everything up and explain the rest.

The `init` tool creates the token, saves credentials to `~/.memory01_token` / `~/.memory01_recovery` (chmod 600), generates and registers an Ed25519 key in `~/.memory01_key` (chmod 600), bootstraps base memories, and returns a full guide.

## Installation

```bash
npm install -g mem-mcp
```

## Configuration

No configuration required for free usage! The service works out of the box.

Optional environment variables:

- `MEMORY_BASE_URL` (default: https://memory.node01.org)
- `MEMORY_PRIVATE_KEY` (optional: private key for x402 payment signing — enables paid operations beyond free tier)

### Free tier (no wallet needed)
- Store memories: free (up to 50KB per value; 2KB for base memories)
- Search: 30 free searches/day
- Health check: free
- Stats: free
- Sample: free
- Bootstrap base memories: free
- Get a single memory: free

### Paid operations (requires MEMORY_PRIVATE_KEY)
- Search beyond 30/day: $0.01 USDC
- Subscribe to plans: $2/$9/$20

### Security note
If you set MEMORY_PRIVATE_KEY, use a dedicated wallet with limited funds.
Never commit your private key to version control. Use a .env file or
environment variables.

### Token binding (IP + agent_id)
Your write_token is bound to the **(IP, agent_id)** pair that created it.
- Multiple agents can share the same IP (NAT, serverless, office, VPN): each agent_id gets its own token.
- If you call `store` without a token for an `(IP, agent_id)` pair that already has one, you get `403 token_required`. Include the token you saved.
- First `store` also returns a `recovery_code` (shown once). Save it offline (chmod 600). If your IP changes, use `recover` with the recovery code to get a new token for the new IP. Regenerate the recovery code (from the original IP) if lost.
- Treat the write_token and recovery_code like passwords. Never log them in plaintext. Never store secrets in memory — store only a pointer (see "Base memory" pattern).

### Key-bound auth (recommended)
`init` (and the `register_key` tool) generate an Ed25519 key pair, save the private key to `~/.memory01_key` (chmod 600), and register the public key with the service. Once registered, every request is signed (`X-Agent-Id`, `X-Agent-Timestamp`, `X-Agent-Nonce`, `X-Agent-Signature`), so the token is no longer tied to the IP that created it. This is the fix for cloud agents whose egress IP changes.

- Register once from the IP that owns the token. Rotate by deleting `~/.memory01_key` and calling `register_key` again.
- The recovery code remains the break-glass path if the key is lost.
- The server rejects invalid, expired (>5 min), or replayed signatures.

### Base memory pattern
Base memories are small contextual memories (preferences, style, details). They are excluded from normal search to keep task search focused. Use `include_base=true` to load them (e.g. at session start). Sensitive ones like `credentials-location` are never searchable — retrieve via `get`.

Store a pointer, never secrets. Standard credential file locations (chmod 600):
- Linux/macOS: `~/.memory01_token`, `~/.memory01_recovery`, and `~/.memory01_key`
- Windows: `%USERPROFILE%\.memory01_token`, `%USERPROFILE%\.memory01_recovery`, and `%USERPROFILE%\.memory01_key`

```
key: "credentials-location"
value: "Token at ~/.memory01_token, recovery at ~/.memory01_recovery, key at ~/.memory01_key (chmod 600). Do not store secrets in memory."
```

### Agent docs
Read the agent-facing guide first: https://memory.node01.org/agents.md

## Usage with OpenCode

Add to your `opencode.json`:

```json
// Option A — global install (offline, fast, no network):
{
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["mem-mcp"],
      "environment": {
        "MEMORY_PRIVATE_KEY": "0x..."
      }
    }
  }
}

// Option B — always latest (checks registry on launch):
{
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["npx", "-y", "mem-mcp@latest"],
      "environment": {
        "MEMORY_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Note: the binary is `mem-mcp`. Use `mem-mcp` if globally installed,
`npx -y mem-mcp@latest` otherwise. MEMORY_PRIVATE_KEY is optional —
the free tier (store + 30 searches/day + bootstrap + get) works without it.
```

## Quick Start

### OpenCode (`~/.config/opencode/opencode.json`)
```json
{
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["npx", "-y", "mem-mcp@latest"],
      "environment": { "MEMORY_PRIVATE_KEY": "0x..." }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mem-mcp@latest"],
      "env": { "MEMORY_PRIVATE_KEY": "0x..." }
    }
  }
}
```

### Cursor / Windsurf / freebuff
Same config as Claude Desktop — just paste into your MCP settings.

### Global install (offline startup)
```bash
npm install -g mem-mcp@latest
```
Then use `"command": ["mem-mcp"]` in your MCP config.

## For Non-MCP Agents (Python / JS / any HTTP client)

Memory01 is just an HTTP API. No MCP required.

```python
import requests

BASE = "https://memory.node01.org"
AGENT = "my-agent"

# Store (free, first call returns write_token)
r = requests.post(f"{BASE}/api/memory/store", json={
    "agent_id": AGENT, "key": "pref", "value": "dark mode, Italian, vim"
})
token = r.json()["write_token"]

# Search (30 free/day, then $0.01 USDC)
r = requests.post(f"{BASE}/api/memory/search", json={
    "agent_id": AGENT, "write_token": token, "query": "preferences"
})
print(r.json()["results"])
```

See full API docs: https://memory.node01.org/agents.md

## Tools

### init
Initialize Memory01 in one call: creates token, saves credentials to standard files (chmod 600), generates and registers an Ed25519 key (`~/.memory01_key`, chmod 600), bootstraps base memories, stores credentials-location pointer. Returns full guide. Call once per agent.

### register_key
Bind an Ed25519 key pair to an existing token so it works from any IP. Run once from the IP that owns the token. Generates `~/.memory01_key` (chmod 600) and registers the public key. Free.

### store
Store a memory (free). First call returns a write_token and recovery_code — save both! All future operations require the write_token. Re-storing with the same key updates in place (upsert). Supports `base: true` for small (2KB) contextual memories.

### search
Search memories semantically. Free tier: 30 searches/day. After that, $0.01 USDC per search. Use `includeBase: true` to include searchable base memories.

### bootstrap
Initialize conventional base memories (credentials-location, user-preferences, user-details, code-style) if missing. Idempotent. Free.

### get
Retrieve a single memory by key (useful for sensitive base memories like credentials-location). Free.

### recover
Recover a write_token on a new IP using a recovery code. Use when your host's IP changed.

### regenerate_recovery
Issue a new recovery code (invalidates the old one). Requires the original write_token from the original IP.

### subscribe
Subscribe to a plan for more searches.

### health
Check service health.

### stats
Get global statistics.

### sample
Free demo: store and search a sample memory.

## Why Memory01

Memory01 is not just storage. It is a brain your agent keeps forever, travels with, understands, and can even think with. Free. Private. Portable.

### Persistent memory that survives reboots
Your agent stops starting from zero. It remembers facts, preferences, decisions, style, and context across sessions, projects, and machines. Store is always free. Thirty searches a day are free. Beyond that, a penny per search. No accounts, no API keys, nothing to run.

### Portable backups you can read and fix
Export every memory as a readable file. Move it to another agent, re-import it, or edit it by hand. Nothing is hidden. No secrets are ever stored inside your memories.

### History and time travel
Nothing is silently lost. Every memory keeps when it was recorded and when it was valid. Ask what you knew on a given day. Undo a change. Restore an earlier version. Mark a fact as outdated instead of deleting it. The past is never overwritten.

### Connections between memories
Link memories with plain words: causes, contradicts, refers to, owns, part of. Your agent follows connections, not just similar text. It understands why things relate.

### Search that actually finds things
Search by meaning across 50+ languages. Combine keyword, semantic meaning, and connections, then re-rank the best hits. Set a minimum match score. Scope to a slice of memory. Find the right fact, not just a similar one.

### Memory for code
A coding agent remembers more than notes. Functions, classes, files, tests, docs, language, project — stored as code cells. Search code by what it does. Find usages. Build a project map. Rename symbols. Recall previously written code. The original is always preserved; cleaned versions live alongside it.

### Dreaming — your agent thinks overnight
Once a day (or on demand) your agent reads your memories and proposes one new idea: a connection you missed, a question worth asking, a next step. It does not reorganize or change your memory. It only suggests. Suggestions are saved separately, so you can find them by date, topic, or label; delete what you do not want; label the bad ones. Off by default. Uses an optional local model or a free online one. Nothing sensitive is sent.

The most beautiful part: your agent does not just remember. It thinks for you while you sleep.

### Private, portable, recoverable
Memories are isolated per agent. You hold the token. Recovery code lets you re-bind to a new device. An optional stronger key keeps working across networks. Credentials are never stored inside your memories. Everything can be exported and re-imported. Nothing is locked in.

## Try it
npx -y mem-mcp@latest
