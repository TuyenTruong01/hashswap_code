import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import rateLimit from "express-rate-limit";

import {
  AccountId,
  TokenId,
  PrivateKey,
  TransferTransaction,
  Hbar,
} from "@hashgraph/sdk";

import { getClient } from "./src/hederaClient.js";
import { CONFIG } from "./src/config.js";
import { mirrorGet } from "./src/mirror.js";

/**
 * ======================
 * Basic helpers
 * ======================
 */
function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function parseOperatorKey() {
  let k = String(process.env.OPERATOR_KEY || "").trim();
  if (!k) throw new Error("Missing OPERATOR_KEY");
  if (k.startsWith("0x")) k = k.slice(2);
  return PrivateKey.fromStringECDSA(k);
}

async function getAssociatedTokenIds(accountId) {
  const data = await mirrorGet(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  return new Set((data.tokens || []).map((t) => t.token_id));
}

/**
 * ======================
 * Load state
 * ======================
 */
function loadState() {
  const app = readJson("deploy/state.json");
  const tokensList = Object.entries(app.tokens || {}).map(([symbol, info]) => ({
    symbol,
    tokenId: info.tokenId,
    decimals: info.decimals ?? 6,
  }));

  return {
    network: app.network,
    operatorId: app.operatorId,
    mirror: app.mirror,
    pool: app.pools?.[0],
    tokensList,
  };
}

/**
 * ======================
 * Faucet config
 * ======================
 */
const FAUCET_DB = "faucet_db.json";
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const FAUCET_AMOUNT = 20;

function loadFaucetDb() {
  try {
    return JSON.parse(fs.readFileSync(FAUCET_DB, "utf8"));
  } catch {
    return {};
  }
}

function saveFaucetDb(db) {
  fs.writeFileSync(FAUCET_DB, JSON.stringify(db, null, 2));
}

/**
 * ======================
 * Express
 * ======================
 */
const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
});

const txLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
});

app.use(limiter);

/**
 * ======================
 * Public read APIs
 * ======================
 */
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/state", async (req, res) => {
  try {
    const state = loadState();
    res.json({
      network: state.network,
      operatorId: state.operatorId,
      mirror: state.mirror,
      pool: state.pool,
      tokens: state.tokensList,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * ======================
 * 🔴 DISABLED SWAP + LIQUID
 * ======================
 */
app.post("/api/swap", (req, res) => {
  res.status(403).json({
    ok: false,
    error: "Swap disabled in production-safe mode.",
  });
});

app.post("/api/tx/build/swap", (req, res) => {
  res.status(403).json({
    ok: false,
    error: "Swap build disabled.",
  });
});

app.post("/api/tx/build/liquidity/add", (req, res) => {
  res.status(403).json({
    ok: false,
    error: "Liquidity disabled.",
  });
});

app.post("/api/tx/build/liquidity/remove", (req, res) => {
  res.status(403).json({
    ok: false,
    error: "Liquidity disabled.",
  });
});

app.post("/api/tx/submit", (req, res) => {
  res.status(403).json({
    ok: false,
    error: "Backend submit disabled.",
  });
});

/**
 * ======================
 * 🟢 Faucet (Backend Only)
 * ======================
 */
app.get("/api/faucet/status", async (req, res) => {
  try {
    const state = loadState();
    const accountId = String(req.query.accountId || "").trim();
    if (!accountId) return res.status(400).json({ ok: false });

    const db = loadFaucetDb();
    const last = db[accountId]?.lastClaimAt || 0;
    const now = Date.now();
    const remaining = Math.max(0, last + COOLDOWN_MS - now);

    const associated = await getAssociatedTokenIds(accountId);
    const notAssociated = state.tokensList.filter(
      (t) => !associated.has(t.tokenId)
    );

    res.json({
      ok: true,
      canClaim: remaining === 0,
      remainingMs: remaining,
      faucetAmount: FAUCET_AMOUNT,
      notAssociated,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/faucet/claim", txLimiter, async (req, res) => {
  try {
    const state = loadState();
    const client = getClient();
    const accountId = String(req.body?.accountId || "").trim();
    if (!accountId) return res.status(400).json({ ok: false });

    const db = loadFaucetDb();
    const last = db[accountId]?.lastClaimAt || 0;
    const now = Date.now();
    if (now - last < COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: "Cooldown" });
    }

    const associated = await getAssociatedTokenIds(accountId);
    const notAssociated = state.tokensList.filter(
      (t) => !associated.has(t.tokenId)
    );

    if (notAssociated.length) {
      return res.status(400).json({
        ok: false,
        error: "Associate tokens first",
        notAssociated,
      });
    }

    const tx = new TransferTransaction();

    for (const t of state.tokensList) {
      const ONE = 10 ** t.decimals;
      const amount = FAUCET_AMOUNT * ONE;

      tx.addTokenTransfer(
        TokenId.fromString(t.tokenId),
        AccountId.fromString(state.operatorId),
        -amount
      );

      tx.addTokenTransfer(
        TokenId.fromString(t.tokenId),
        AccountId.fromString(accountId),
        amount
      );
    }

    const frozen = await tx.freezeWith(client);
    const signed = await frozen.sign(parseOperatorKey());
    const submit = await signed.execute(client);
    const receipt = await submit.getReceipt(client);

    db[accountId] = { lastClaimAt: Date.now() };
    saveFaucetDb(db);

    res.json({
      ok: true,
      status: receipt.status.toString(),
      txId: submit.transactionId.toString(),
    });

    client.close();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/", (req, res) => {
  res.send("HashSwap SAFE API running.");
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});