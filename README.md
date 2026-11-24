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

- **Store**: Free memory storage (first call returns a write_token + recovery_code)
- **Upsert**: Re-store with the same key updates in place (no duplicates)
- **Search**: Semantic search across 50+ languages (free tier: 30/day, then $0.01 USDC)
- **Base memories**: Small (max 2KB) contextual memories (preferences, style, details). Excluded from normal search by default; include with `include_base=true`. Bootstrap creates conventional ones.
- **Recovery**: Recovery code issued at first store lets you re-bind your token to a new IP if your host changes IP.
- **Key-bound auth**: `init` generates an Ed25519 key pair in `~/.memory01_key` (chmod 600) and registers the public key. Requests are signed automatically, so the token works from any IP — no recovery needed when your cloud IP changes.
- **Subscribe**: Subscription plans (Starter $2/500, Pro $9/mo, Enterprise $20/mo)
- **Health / Stats / Sample**: Free utilities

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
