# `.mem01` — Memory01 Code Memory format

A portable, linted-embedded code cell for agentic coding memory. One JSON object per cell (JSONL `.mem01`, Markdown front-matter optional). Linted + original preserved; syntax-aware; upsert by `path+symbol`.

```json
{
  "schema": "mem01-code@1",
  "language": "python",
  "path": "app.py",
  "symbol": "search_handler",
  "kind": "function",
  "code": "original verbatim",
  "linted_code": "formatted + linted (ruff/format, etc.); original NOT destroyed",
  "lint_status": "clean|fixed|errors",
  "lint_errors": [{"line": 12, "rule": "E501", "msg": "..."}],
  "fixes_applied": ["format", "unused-imports"],
  "tests": ["test_search.py::test_paid"],
  "doc": "docstring/summary",
  "hash": "sha256(code)",
  "deps": ["x402", "flask"],
  "calls": ["STORE.search", "_fac.settle"],
  "called_by": ["app"],
  "git_sha": "...",
  "agent": "...",
  "session": "...",
  "repo": "node01-dev/mem-mcp",
  "stored_at": "...",
  "updated_at": "...",
  "valid_from": "...", "valid_to": null, "recorded_at": "...",
  "searchable": true,
  "base": false
}
```
## Tools (mem-mcp)
`store_code`, `search_code`, `get_symbol`, `list_repo`, `forget_code`, `find_references`, `similar_code`, `repo_map`.
## Rules
no secrets; `credentials-location` not storing secrets; upsert `path+symbol`; base `code-style`,`project-rules`,`decisions`.
