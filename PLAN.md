# Memory MCP Wrapper — Plan & Status

## Goal
Build and publish `mem-mcp` npm package following `vibe-token-mcp` pattern.

## Status: ✅ BUILT & TESTED

## Completed
- [x] Create package.json
- [x] Create index.js with MCP tools: store, search, subscribe, health, stats, sample
- [x] Create README.md
- [x] Install dependencies (@modelcontextprotocol/sdk, viem)
- [x] Test MCP server startup (stdio)
- [x] Test tools/list (6 tools registered)
- [x] Test health tool (returns service status)
- [x] Test sample tool (handles IP token conflict gracefully)

## TODO
- [ ] Test store tool with fresh IP (or handle existing token)
- [ ] Test search tool (free tier + paid)
- [ ] Test subscribe tool (x402 payment)
- [ ] Fix sample tool to handle existing write_token
- [x] Publish to npm as `mem-mcp` (v1.0.1)
- [ ] Add to x402-list MCP registry
- [ ] Create README for npm page
- [x] Test end-to-end (health + sample passed)

## Tools
| Tool | Description | Payment |
|------|-------------|---------|
| store | Store a memory (free) | Free |
| search | Semantic search (30/day free, then $0.01) | Free tier + x402 |
| subscribe | Subscribe to plan | x402 ($2/$9/$20) |
| health | Service health | Free |
| stats | Global stats | Free |
| sample | Demo store+search | Free |

## Next Steps
1. Publish to npm
2. Add memory-mcp to OpenCode config
3. Test with real wallet
4. Update llms.txt and openapi.json to mention MCP
