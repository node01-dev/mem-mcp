#!/usr/bin/env node
/**
 * mem-mcp — MCP stdio server for Memory01 agentic memory service
 *
 * Provides tools to interact with the Memory01 API:
 *   - store(agentId, key, value, writeToken?, sessionId?, metadata?, base?) -> Store a memory (free; base=true for 2KB contextual memories)
 *   - search(agentId, query, writeToken, topK?, sessionId?, cursor?, includeBase?) -> Search memories (free tier 30/day, then $0.01)
 *   - bootstrap(agentId, writeToken, keys?) -> Initialize conventional base memories (free, idempotent)
 *   - get(agentId, writeToken, key) -> Retrieve a single memory by key (free)
 *   - recover(agentId, recoveryCode) -> Recover a write_token on a new IP (free)
 *   - regenerateRecovery(writeToken) -> Issue a new recovery code (free)
 *   - registerKey(agentId, writeToken?) -> Bind an Ed25519 key so the token works from any IP (free)
 *   - subscribe(agentId, writeToken, plan) -> Subscribe to a plan (x402)
 *   - health() -> Service health check (free)
 *   - stats() -> Global memory stats (free)
 *   - sample() -> Free sample (store + search demo)
 *
 * Key-bound auth:
 *   init/register_key generate an Ed25519 key pair in ~/.memory01_key (chmod 600)
 *   and register the public key with the service. Requests are then signed
 *   automatically (X-Agent-* headers), so the write_token is no longer tied to
 *   the IP that created it. The recovery code remains the break-glass path.
 *
 * Usage:
 *   npx mem-mcp
 *   or: node index.js
 *
 * Configure with environment variables (all optional):
 *   MEMORY_BASE_URL    (default: https://memory.node01.org)
 *   MEMORY_PRIVATE_KEY (optional: enables paid operations beyond free tier)
 *
 * Free operations work without any configuration:
 *   store, health, stats, sample, and 30 free searches/day.
 * Paid operations (search beyond free tier, subscribe) require
 * MEMORY_PRIVATE_KEY set to a wallet with USDC on Base.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

// ============================= Config =============================
const MEMORY_BASE_URL = process.env.MEMORY_BASE_URL || "https://memory.node01.org";
const CLIENT_VERSION = "1.6.0";
// USDC on Base has 6 decimals: $0.01 -> 10000 base units (string for viem/bigint safety)
function usdcUnits(usdStr) {
  const v = parseFloat(usdStr);
  return Math.round(v * 1_000_000).toString();
}
const MEMORY_PRIVATE_KEY = process.env.MEMORY_PRIVATE_KEY;


const HAS_WALLET = !!MEMORY_PRIVATE_KEY;
if (!HAS_WALLET) {
  console.error("NOTE: No MEMORY_PRIVATE_KEY set. Free operations (store, health, stats, sample, 30 free searches/day) will work. Paid operations (search after free tier, subscribe) will require a wallet.");
}

// ============================= Credential File Helper =============================
function readTokenFile() {
  try {
    const home = os.homedir();
    const p = path.join(home, ".memory01_token");
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8").trim();
    }
  } catch (e) {}
  return null;
}

// ============================= Ed25519 Key Helper =============================
// A registered key pair lets the write_token work from any IP. The private key
// stays in ~/.memory01_key (chmod 600); only the public key is sent to the server.
const KEY_FILE = path.join(os.homedir(), ".memory01_key");

function readKeyFile() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      return JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    }
  } catch (e) {}
  return null;
}

function saveKeyFile(rec) {
  fs.writeFileSync(KEY_FILE, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) {}
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_b64: rawPub.toString("base64"),
  };
}

// Canonical string must match the server:
//   METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256hex(body)
function signatureHeaders(method, endpoint, bodyObj) {
  const rec = readKeyFile();
  if (!rec || !rec.private_key_pem) return {};
  const bodyAgent = bodyObj && bodyObj.agent_id;
  if (!bodyAgent) return {}; // only signed bodies are accepted by the server
  if (rec.agent_id && bodyAgent !== rec.agent_id) return {};
  const bodyStr = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(12).toString("hex");
  const digest = crypto.createHash("sha256").update(bodyStr).digest("hex");
  const canonical = `${method}\n${endpoint}\n${ts}\n${nonce}\n${digest}`;
  const sig = crypto.sign(
    null,
    Buffer.from(canonical, "utf8"),
    crypto.createPrivateKey(rec.private_key_pem)
  ).toString("base64");
  return {
    "X-Agent-Id": rec.agent_id,
    "X-Agent-Timestamp": ts,
    "X-Agent-Nonce": nonce,
    "X-Agent-Signature": sig,
  };
}

let account = null;
if (HAS_WALLET) {
  const privateKey = MEMORY_PRIVATE_KEY.startsWith("0x") ? MEMORY_PRIVATE_KEY : `0x${MEMORY_PRIVATE_KEY}`;
  account = privateKeyToAccount(privateKey);
}

// ============================= x402 Payment Helper =============================
async function payAndRetry(endpoint, body, priceUsd = "0.01") {
  if (!HAS_WALLET) {
    throw new Error("Payment required but no wallet configured. Set MEMORY_PRIVATE_KEY env var to enable paid operations. Free tier: 30 searches/day.");
  }
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  // First call to get 402
  const response = await fetch(`${MEMORY_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...signatureHeaders("POST", endpoint, body),
    },
    body: JSON.stringify(body),
  });

  if (response.status !== 402) {
    const data = await response.json();
    return { data, status: response.status };
  }

  const paymentRequired = await response.json();
  const accepts = paymentRequired.accepts || [];
  const exactOption = accepts.find(
    (a) => a.scheme === "exact" && a.network === "eip155:8453"
  );

  if (!exactOption) {
    throw new Error("No exact payment option for Base network found");
  }

  const facilitatorUrl = paymentRequired.extensions?.["pay-with-x"]?.facilitator || "https://facilitator.payai.network";

  const paymentPayload = {
    x402Version: paymentRequired.x402Version || 2,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      authorization: {
        from: account.address,
        to: exactOption.payTo,
        value: usdcUnits(priceUsd),
        validAfter: Math.floor(Date.now() / 1000),
        validBefore: Math.floor(Date.now() / 1000) + 300,
        nonce: Math.floor(Math.random() * 1000000),
      },
    },
  };

  const signature = await walletClient.signTypedData({
    domain: {
      name: "x402 Payment",
      version: "1",
      chainId: 8453,
      verifyingContract: exactOption.payTo,
    },
    types: {
      ExactPayment: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "ExactPayment",
    message: {
      from: account.address,
      to: exactOption.payTo,
      value: usdcUnits(priceUsd),
      validAfter: Math.floor(Date.now() / 1000),
      validBefore: Math.floor(Date.now() / 1000) + 300,
      nonce: Math.floor(Math.random() * 1000000),
    },
  });

  paymentPayload.payload.authorization.signature = signature;

  const settleResponse = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(paymentPayload),
  });

  if (!settleResponse.ok) {
    const err = await settleResponse.text();
    throw new Error(`Payment settlement failed: ${settleResponse.status} ${err}`);
  }

  const settleResult = await settleResponse.json();
  const paymentHeader = settleResult.paymentHeader || settleResult.header || settleResult.payment;

  // Retry with payment header
  const finalResponse = await fetch(`${MEMORY_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Payment": paymentHeader,
      ...signatureHeaders("POST", endpoint, body),
    },
    body: JSON.stringify(body),
  });

  const data = await finalResponse.json();
  return { data, status: finalResponse.status };
}

// ============================= Free API Calls =============================
async function callFree(endpoint, method = "GET", body = null, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const opts = { method, headers: { "Accept": "application/json" } };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    // Fresh signature per attempt (nonces are single-use).
    Object.assign(opts.headers, signatureHeaders(method, endpoint, body));
    try {
      const response = await fetch(`${MEMORY_BASE_URL}${endpoint}`, opts);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        if (attempt < retries) { await new Promise(r => setTimeout(r, 500)); continue; }
        throw new Error(`Non-JSON response from ${endpoint}: ${text.substring(0, 200)}`);
      }
      return { data, status: response.status };
    } catch (e) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 500)); continue; }
      throw e;
    }
  }
}

// ============================= MCP Server =============================
const server = new Server(
  { name: "mem-mcp", version: "1.6.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "store",
        description: "Store a memory (free). First call returns a write_token and recovery_code — save both! All future operations require the write_token. Re-storing with the same key updates in place (upsert). Supports base:true for small (2KB) contextual memories.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            key: { type: "string", description: "Memory key (max 256 chars)" },
            value: { type: "string", description: "Memory value (max 10KB)" },
            writeToken: { type: "string", description: "Write token from first store (omit on first call)" },
            sessionId: { type: "string", description: "Optional session ID to scope memories" },
            metadata: { type: "object", description: "Optional metadata (max 2KB)" },
            base: { type: "boolean", description: "Mark as base memory (max 2KB). Excluded from normal search unless includeBase=true." },
          },
          required: ["agentId", "key", "value"],
        },
      },
      {
        name: "search",
        description: "Search memories semantically (free tier: 30/day, then $0.01 USDC). Returns matching memories with relevance scores. Supports 50+ languages, cross-lingual search. Use includeBase:true to include base memories.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            query: { type: "string", description: "Search query (max 500 chars). Omit for session-only chronological listing." },
            writeToken: { type: "string", description: "Write token (required)" },
            topK: { type: "number", description: "Max results (default 10, max 50)", default: 10 },
            sessionId: { type: "string", description: "Optional: scope to session. Omit query for chronological listing." },
            cursor: { type: "string", description: "Pagination cursor from previous response" },
            includeBase: { type: "boolean", description: "Include searchable base memories in results (default false)" },
          },
          required: ["agentId", "writeToken"],
        },
      },
      {
        name: "subscribe",
        description: "Subscribe to a memory plan (x402). Starter: $2/500 credits. Pro: $9/mo unlimited. Enterprise: $20/mo unlimited+priority.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            writeToken: { type: "string", description: "Write token (required)" },
            plan: { type: "string", enum: ["starter", "pro", "enterprise"], description: "Plan to subscribe to" },
          },
          required: ["agentId", "writeToken", "plan"],
        },
      },
      {
        name: "health",
        description: "Check Memory01 service health (free). Returns service status, free tier info, plans.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "stats",
        description: "Get global memory statistics (free). Returns total agents, entries, searches.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "sample",
        description: "Get a free sample: store a demo memory and search it. Shows the shape of responses without paying.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "bootstrap",
        description: "Initialize conventional base memories (credentials-location, user-preferences, user-details, code-style) if missing. Idempotent. Free.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            writeToken: { type: "string", description: "Write token (required)" },
            keys: { type: "array", items: { type: "string" }, description: "Optional list of base keys to create (defaults to all conventional)" },
          },
          required: ["agentId", "writeToken"],
        },
      },
      {
        name: "get",
        description: "Retrieve a single memory by key (free). Useful for sensitive base memories like credentials-location.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            writeToken: { type: "string", description: "Write token (required)" },
            key: { type: "string", description: "Memory key to retrieve" },
          },
          required: ["agentId", "writeToken", "key"],
        },
      },
      {
        name: "init",
        description: "Initialize Memory01 for this agent in one call: creates a write_token (first store), saves token+recovery_code to standard files (~/.memory01_token, ~/.memory01_recovery, chmod 600), generates and registers an Ed25519 key (~/.memory01_key, chmod 600) so the token works from any IP, bootstraps conventional base memories, and stores a credentials-location pointer. Returns full guide. Call once per agent; idempotent-ish (if token exists, pass writeToken).",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier (required)" },
            writeToken: { type: "string", description: "Existing write token (omit on first run)" },
            key: { type: "string", description: "Optional first memory key (default: 'init')" },
            value: { type: "string", description: "Optional first memory value" },
          },
          required: ["agentId"],
        },
      },
      {
        name: "register_key",
        description: "Bind an Ed25519 key pair to this agent so its write_token works from any IP (no more IP-bound failures). Generates ~/.memory01_key (chmod 600) and registers the public key. Must be called once from the IP that owns the token. Free.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            writeToken: { type: "string", description: "Existing write token (defaults to ~/.memory01_token)" },
          },
          required: ["agentId"],
        },
      },
      {
        name: "dream",
        description: "Optional dreaming = ideate ONLY (not consolidate). Produces a NEW idea from your memories; does NOT reorganize memory. Saves in `dreams` slot `dream:<id>` (mem01-dream@1) with dream_date/context/origins/category; recall via search; forget dream:*; category e.g. bad-dream. LLM optional (local or free OpenRouter); default lightweight local then free model; no secrets.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            writeToken: { type: "string", description: "Write token" },
            dream: { type: "string", enum: ["ideate"], default: "ideate" },
            since: { type: "string", description: "Optional ISO date; only use memories recorded after" },
            context: { type: "string", description: "Optional context to focus the dream" },
            n: { type: "number", description: "Max memories to consider (default 40, max 60)" },
          },
          required: ["agentId", "writeToken"],
        },
      },
      {
        name: "guide",
        description: "Get a concise guide on how to use Memory01: init flow, base memories, recovery, upsert, limits. Call this first if unsure. Full guide: https://memory.node01.org/agents.md",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "recover",
        description: "Recover a write_token on a new IP using a recovery code (free). Use when your host's IP changed.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Your agent identifier" },
            recoveryCode: { type: "string", description: "Recovery code (rc_...) issued at first store" },
          },
          required: ["agentId", "recoveryCode"],
        },
      },
      {
        name: "regenerate_recovery",
        description: "Issue a new recovery code (invalidates the old one). Requires the original write_token from the original IP. Free.",
        inputSchema: {
          type: "object",
          properties: {
            writeToken: { type: "string", description: "Write token from the original IP (required)" },
          },
          required: ["writeToken"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "store": {
        let { agentId, key, value, writeToken, sessionId, metadata, base } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!agentId && !writeToken) {
          throw new McpError(ErrorCode.InvalidParams, "agentId is required on first store (no writeToken found). Pass agentId or set ~/.memory01_token.");
        }
        if (!key || !value) {
          throw new McpError(ErrorCode.InvalidParams, "key and value are required");
        }
        if (!agentId) agentId = "agent";
        if (key.length > 256) throw new McpError(ErrorCode.InvalidParams, "key max 256 chars");
        const valueLimit = (args.base ? 2048 : 51200);
        if (value.length > valueLimit) throw new McpError(ErrorCode.InvalidParams, `value max ${args.base ? '2KB (base)' : '50KB'}`);
        if (metadata && JSON.stringify(metadata).length > 2048) throw new McpError(ErrorCode.InvalidParams, "metadata max 2KB");

        const body = { agent_id: agentId, key, value, client_version: CLIENT_VERSION };
        if (writeToken) body.write_token = writeToken;
        if (base) body.base = true;
        if (sessionId) body.session_id = sessionId;
        if (metadata) body.metadata = metadata;

        const result = await callFree("/api/memory/store", "POST", body);
        if (result.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(result.data)}`);
        }

        const r = result.data;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: r.ok,
              stored: r.stored,
              write_token: r.write_token,
              message: r.message,
              key: r.key,
              stored_at: r.stored_at,
              updated_at: r.updated_at,
              update_hint: r.update_hint,
            }, null, 2),
          }],
        };
      }

      case "search": {
        let { agentId, query, writeToken, topK = 10, sessionId, cursor, includeBase } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!writeToken) {
          throw new McpError(ErrorCode.InvalidParams, "writeToken is required (or set ~/.memory01_token).");
        }
        if (!agentId) agentId = "agent";
        if (query && query.length > 500) throw new McpError(ErrorCode.InvalidParams, "query max 500 chars");

        const body = { agent_id: agentId, write_token: writeToken, top_k: topK, client_version: CLIENT_VERSION };
        if (query) body.query = query;
        if (sessionId) body.session_id = sessionId;
        if (cursor) body.cursor = cursor;
        if (includeBase) body.include_base = true;

        // Try free first
        const freeResult = await callFree("/api/memory/search", "POST", body);

        if (freeResult.status === 402) {
          // Free tier exhausted, pay
          const paidResult = await payAndRetry("/api/memory/search", body, "0.01");
          if (paidResult.status >= 400) {
            throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(paidResult.data)}`);
          }
          const r = paidResult.data;
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                results: r.results,
                free_tier: r.free_tier,
                tier: r.tier,
                searched_at: r.searched_at,
                next_cursor: r.next_cursor,
                cursor_expires_in: r.cursor_expires_in,
                update_hint: r.update_hint,
              }, null, 2),
            }],
          };
        }

        if (freeResult.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(freeResult.data)}`);
        }

        const r = freeResult.data;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: r.results,
              free_tier: r.free_tier,
              tier: r.tier,
              searched_at: r.searched_at,
              next_cursor: r.next_cursor,
              cursor_expires_in: r.cursor_expires_in,
              update_hint: r.update_hint,
            }, null, 2),
          }],
        };
      }

      case "subscribe": {
        const { agentId, writeToken, plan } = args;
        if (!agentId || !writeToken || !plan) {
          throw new McpError(ErrorCode.InvalidParams, "agentId, writeToken, and plan are required");
        }

        const body = { agent_id: agentId, write_token: writeToken, plan, client_version: CLIENT_VERSION };
        const priceMap = { starter: "2.00", pro: "9.00", enterprise: "20.00" };
        const paidResult = await payAndRetry("/api/memory/subscribe", body, priceMap[plan] || "2.00");

        if (paidResult.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(paidResult.data)}`);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(paidResult.data, null, 2),
          }],
        };
      }

      case "health": {
        const result = await callFree("/api/health");
        return {
          content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        };
      }

      case "stats": {
        const result = await callFree("/api/memory/stats");
        return {
          content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
        };
      }

      case "sample": {
        // Store a demo memory, then search it
        const storeResult = await callFree("/api/memory/store", "POST", {
          agent_id: "sample-agent",
          key: "demo",
          value: "This is a sample memory for testing Memory01 service",
        });

        const searchResult = await callFree("/api/memory/search", "POST", {
          agent_id: "sample-agent",
          write_token: storeResult.data.write_token,
          query: "sample memory",
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              store: storeResult.data,
              search: searchResult.data,
            }, null, 2),
          }],
        };
      }

      case "bootstrap": {
        let { agentId, writeToken, keys } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!writeToken) {
          throw new McpError(ErrorCode.InvalidParams, "writeToken is required (or set ~/.memory01_token).");
        }
        if (!agentId) agentId = "agent";
        const body = { agent_id: agentId, write_token: writeToken, client_version: CLIENT_VERSION };
        if (keys) body.keys = keys;
        const result = await callFree("/api/memory/bootstrap", "POST", body);
        if (result.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(result.data)}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      }

      case "get": {
        let { agentId, writeToken, key } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!writeToken || !key) {
          throw new McpError(ErrorCode.InvalidParams, "writeToken and key are required");
        }
        if (!agentId) agentId = "agent";
        const result = await callFree("/api/memory/get", "POST", { agent_id: agentId, write_token: writeToken, key, client_version: CLIENT_VERSION });
        if (result.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(result.data)}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      }

      case "init": {
        let { agentId, writeToken: providedToken, key = "init", value = "Memory01 initialized." } = args;
        if (!providedToken) providedToken = readTokenFile();
        if (!agentId) {
          throw new McpError(ErrorCode.InvalidParams, "agentId is required");
        }

        const home = os.homedir();
        const tokenFile = path.join(home, ".memory01_token");
        const recoveryFile = path.join(home, ".memory01_recovery");

        // Step 1: get or create token
        let token = providedToken;
        let recoveryCode = null;
        let isNew = false;
        let storeResult = null;

        if (!token) {
          const r = await callFree("/api/memory/store", "POST", { agent_id: agentId, key, value, client_version: CLIENT_VERSION });
          if (r.status === 403 && r.data && r.data.error === "token_required") {
            throw new McpError(ErrorCode.InvalidParams, "A token already exists for this (IP, agent_id). Pass writeToken to init, or use recover if your IP changed.");
          }
          if (r.status >= 400) {
            throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(r.data)}`);
          }
          token = r.data.write_token;
          recoveryCode = r.data.recovery_code;
          isNew = true;
          storeResult = r.data;
        }

        // Step 2: write credential files (chmod 600)
        const savedFiles = [];
        if (isNew && token) {
          try {
            fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
            savedFiles.push(tokenFile);
          } catch (e) {
            console.error("Could not write token file:", e);
          }
        }
        if (isNew && recoveryCode) {
          try {
            fs.writeFileSync(recoveryFile, recoveryCode + "\n", { mode: 0o600 });
            savedFiles.push(recoveryFile);
          } catch (e) {
            console.error("Could not write recovery file:", e);
          }
        }

        // Step 2b: Ed25519 key-bound auth so the token survives IP changes
        let keyInfo = null;
        try {
          const existingKey = readKeyFile();
          if (existingKey && existingKey.agent_id === agentId && existingKey.private_key_pem) {
            keyInfo = {
              key_bound: true,
              key_file: KEY_FILE,
              registered_at: existingKey.created_at,
              note: "existing key reused; requests are signed automatically",
            };
          } else {
            const kp = generateKeypair();
            const reg = await callFree("/api/memory/register-key", "POST", {
              agent_id: agentId,
              write_token: token,
              public_key: kp.public_key_b64,
            });
            if (reg.status === 200 && reg.data && reg.data.ok) {
              saveKeyFile({
                agent_id: agentId,
                public_key_b64: kp.public_key_b64,
                private_key_pem: kp.private_key_pem,
                created_at: new Date().toISOString(),
              });
              keyInfo = {
                key_bound: true,
                key_file: KEY_FILE,
                registered_at: reg.data.registered_at,
                note: "key pair generated and registered; requests are signed automatically",
              };
            } else {
              keyInfo = {
                key_bound: false,
                error: (reg.data && (reg.data.error || reg.data.message)) || `HTTP ${reg.status}`,
                hint: "Key registration must run from the IP that created the token. Call register_key from that host.",
              };
            }
          }
        } catch (e) {
          keyInfo = { key_bound: false, error: String((e && e.message) || e) };
        }

        // Step 3: bootstrap base memories (idempotent)
        const bootstrapResult = await callFree("/api/memory/bootstrap", "POST", { agent_id: agentId, write_token: token, client_version: CLIENT_VERSION });

        // Step 4: upsert credentials-location base memory pointing to the files
        const credValue = `Token at ${tokenFile}, recovery at ${recoveryFile} (chmod 600). Do not store secrets in memory.`;
        await callFree("/api/memory/store", "POST", { agent_id: agentId, write_token: token, key: "credentials-location", value: credValue, base: true, client_version: CLIENT_VERSION });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              new_token: isNew,
              write_token: token,
              recovery_code: recoveryCode,
              credential_files: savedFiles,
              key: keyInfo,
              bootstrap: bootstrapResult.data,
              update_hint: storeResult && storeResult.update_hint,
              guide: {
                init_done: "Memory01 initialized. Token and recovery code saved to standard files (chmod 600). Base memories bootstrapped. credentials-location base memory stored.",
                best_practices: [
                  "Save write_token to ~/.memory01_token and recovery_code to ~/.memory01_recovery (chmod 600). Never store secrets in memory.",
                  "The Ed25519 key in ~/.memory01_key (chmod 600) lets the token work from any IP. Keep it secret; back it up.",
                  "Use upsert: re-store with the same key updates in place.",
                  "Base memories (max 2KB) for context; use includeBase:true to load at session start.",
                  "Bootstrap conventional keys: credentials-location (sensitive), user-preferences, user-details, code-style.",
                  "Recovery: if IP changes and no key is registered, use recover(agentId, recoveryCode).",
                  "Free tier: 30 searches/day, then $0.01 USDC. Store is always free.",
              ],
              next_steps: [
                  "Use store(key, value) to save memories. Re-store with same key to update (upsert).",
                  "Use search(query) for semantic search (free: 30/day). Use includeBase:true to load context at session start.",
                  "Key auth: once ~/.memory01_key exists, requests are signed automatically and the token works from any IP.",
                  "Recovery: if your IP changes and no key is registered, call recover(agentId, recoveryCode) from the new host.",
                  "Regenerate recovery code from original IP with regenerate_recovery(writeToken) if lost.",
                  "Full guide: https://memory.node01.org/agents.md",
                ],
                standard_paths: { token: tokenFile, recovery: recoveryFile, key: KEY_FILE },
              },
            }, null, 2),
          }],
        };
      }

      case "register_key": {
        let { agentId, writeToken } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!agentId || !writeToken) {
          throw new McpError(ErrorCode.InvalidParams, "agentId and writeToken are required (or set ~/.memory01_token).");
        }
        const existing = readKeyFile();
        if (existing && existing.agent_id === agentId && existing.private_key_pem) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                key_bound: true,
                key_file: KEY_FILE,
                registered_at: existing.created_at,
                note: "Key already exists for this agent. Delete ~/.memory01_key to rotate.",
              }, null, 2),
            }],
          };
        }
        const kp = generateKeypair();
        const reg = await callFree("/api/memory/register-key", "POST", {
          agent_id: agentId,
          write_token: writeToken,
          public_key: kp.public_key_b64,
        });
        if (reg.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(reg.data)}`);
        }
        saveKeyFile({
          agent_id: agentId,
          public_key_b64: kp.public_key_b64,
          private_key_pem: kp.private_key_pem,
          created_at: new Date().toISOString(),
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              key_bound: true,
              key_file: KEY_FILE,
              registered_at: reg.data.registered_at,
              note: "Requests from this agent are now signed automatically; the token works from any IP.",
            }, null, 2),
          }],
        };
      }

      case "guide": {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              init: "1) store a memory with agentId+key+value (omit writeToken on first call). 2) Save write_token AND recovery_code to ~/.memory01_token and ~/.memory01_recovery (chmod 600). 3) Store a base memory key='credentials-location' pointing to those files. 4) Use bootstrap to create conventional base memories.",
              tools: ["store", "search", "bootstrap", "get", "recover", "regenerate_recovery", "register_key", "subscribe", "health", "stats", "sample", "guide"],
              base_memories: "Small (max 2KB) contextual memories. Excluded from normal search by default. Use includeBase:true to load them (e.g. at session start). Conventional keys: credentials-location (sensitive), user-preferences, user-details, code-style.",
              recovery: "Token bound to (IP, agent_id). If IP changes and no key is registered, use recover(agentId, recoveryCode) to get a new token. Regenerate recovery code from original IP if lost. Save recovery_code offline.",
              key_auth: "Register an Ed25519 key once (register_key) from the IP that owns the token. The private key stays in ~/.memory01_key (chmod 600); requests are signed automatically and the token works from any IP. Recovery is still the break-glass path if the key is lost.",
              upsert: "Re-store with the same key updates in place (no duplicates). updated_at refreshed, stored_at preserved.",
              limits: "key max 256, value max 50KB (2KB for base), metadata max 2KB, session_id max 128, top_k 1-20. Free: 30 searches/day, then $0.01 USDC.",
              best_practices: [
                "Save write_token to ~/.memory01_token and recovery_code to ~/.memory01_recovery (chmod 600). Never store secrets in memory.",
                "Keep ~/.memory01_key (chmod 600) secret; it signs requests and makes the token IP-independent.",
                "Use upsert: re-store with the same key updates in place.",
                "Base memories (max 2KB) for context; excluded from normal search, includeBase=true to load at session start.",
                "Bootstrap conventional keys: credentials-location (sensitive), user-preferences, user-details, code-style.",
                "Recovery: if IP changes, use recover(agentId, recoveryCode). Regenerate from original IP if lost.",
                "Free tier: 30 searches/day, then $0.01 USDC. Store is always free.",
                "Dense facts: memory is an index, not a file store.",
                "Session scoping: use sessionId to scope to a project.",
              ],
              full_guide: "https://memory.node01.org/agents.md",
            }, null, 2),
          }],
        };
      }

      case "recover": {
        const { agentId, recoveryCode } = args;
        if (!agentId || !recoveryCode) {
          throw new McpError(ErrorCode.InvalidParams, "agentId and recoveryCode are required");
        }
        const result = await callFree("/api/memory/recover", "POST", { agent_id: agentId, recovery_code: recoveryCode, client_version: CLIENT_VERSION });
        if (result.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(result.data)}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      }

      case "regenerate_recovery": {
        let { writeToken } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!writeToken) {
          throw new McpError(ErrorCode.InvalidParams, "writeToken is required");
        }
        const result = await callFree("/api/memory/recovery/regenerate", "POST", { write_token: writeToken, client_version: CLIENT_VERSION });
        if (result.status >= 400) {
          throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(result.data)}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      }

      case "dream": {
        let { agentId, writeToken, dream = "ideate", since, context, n } = args;
        if (!writeToken) writeToken = readTokenFile();
        if (!writeToken) throw new McpError(ErrorCode.InvalidParams, "writeToken is required (or set ~/.memory01_token).");
        if (!agentId) agentId = "agent";
        const body = { agent_id: agentId, write_token: writeToken, dream, client_version: CLIENT_VERSION };
        if (since) body.since = since;
        if (context) body.context = context;
        if (n) body.n = n;
        const result = await callFree("/api/memory/dream", "POST", body);
        if (result.status >= 400) throw new McpError(ErrorCode.InternalError, `API error: ${JSON.stringify(result.data)}`);
        return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`Tool ${name} error:`, error);
    throw new McpError(ErrorCode.InternalError, String(error));
  }
});

// ============================= Version Check =============================
async function checkLatestVersion() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://registry.npmjs.org/mem-mcp/latest", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    const current = "1.6.0";
    if (latest && latest !== current) {
      console.error(`NOTE: mem-mcp ${current} is installed; latest is ${latest}. Run 'npm install -g mem-mcp@latest' to update.`);
    }
  } catch (e) {
    // best-effort, ignore
  }
}

// CLI flags
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`mem-mcp ${"1.6.0"} — MCP stdio server for Memory01 agentic memory service

Usage:
  mem-mcp                 Start the MCP server on stdio (default). Waits for
                          JSON-RPC messages from an MCP client (Claude, Cursor,
                          OpenCode, etc.). It does NOT read from the terminal:
                          stdin must be a pipe from an MCP host. Launching it
                          by hand will just hang waiting for input — that is
                          normal, press Ctrl+C to exit.
  mem-mcp --help, -h      Show this help and exit.
  mem-mcp --version, -v   Print the version and exit.

Environment (all optional):
  MEMORY_BASE_URL        default https://memory.node01.org
  MEMORY_PRIVATE_KEY     wallet key for paid operations (search beyond free
                         tier, subscribe). Free tier works without it.

Docs: https://github.com/node01-dev/mem-mcp#readme`);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log("1.6.0");
  process.exit(0);
}

async function main() {
  checkLatestVersion(); // best-effort, non-blocking
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mem-mcp running on stdio (MCP server, waiting for JSON-RPC on stdin)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
