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
  Transaction,
} from "@hashgraph/sdk";

import { getClient } from "./src/hederaClient.js";
import { CONFIG } from "./src/config.js";
import { mirrorGet } from "./src/mirror.js";

/**
 * =======================
 * Helpers
 * =======================
 */
function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function mustRead(path, label) {
  try {
    return readJson(path);
  } catch {
    throw new Error(`Missing/invalid ${label}: ${path}`);
  }
}

function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function clampInt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.floor(x);
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function nowMs() {
  return Date.now();
}

/**
 * =======================
 * Operator Key Parse
 * =======================
 */
function parseOperatorKey() {
  let k = String(process.env.OPERATOR_KEY || "").trim();
  if (!k) throw new Error("Missing OPERATOR_KEY in .env");
  if (k.startsWith("0x") || k.startsWith("0X")) k = k.slice(2);

  // ECDSA raw hex commonly shown by portal (64 hex chars)
  if (/^[0-9a-fA-F]{64}$/.test(k) || /^[0-9a-fA-F]{66}$/.test(k)) {
    return PrivateKey.fromStringECDSA(k.toLowerCase());
  }

  // DER hex (starts with 30...)
  if (/^30[0-9a-fA-F]+$/.test(k)) {
    return PrivateKey.fromStringDer(k);
  }

  return PrivateKey.fromString(k);
}

/**
 * =======================
 * Mirror helpers
 * =======================
 */
async function getTokenBalanceUnits(accountId, tokenId) {
  const data = await mirrorGet(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  const row = (data.tokens || []).find((t) => t.token_id === tokenId);
  return row ? Number(row.balance) : 0;
}

async function getAssociatedTokenIds(accountId) {
  const data = await mirrorGet(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  return new Set((data.tokens || []).map((t) => t.token_id));
}

/**
 * =======================
 * AMM math (swap)
 * =======================
 */
function getAmountOut(amountIn, reserveIn, reserveOut, feeBps = 30) {
  if (amountIn <= 0) return 0;
  if (reserveIn <= 0 || reserveOut <= 0) return 0;

  const feeFactor = 10000 - feeBps;
  const amountInWithFee = Math.floor((amountIn * feeFactor) / 10000);

  const numerator = reserveOut * amountInWithFee;
  const denominator = reserveIn + amountInWithFee;
  return Math.floor(numerator / denominator);
}

/**
 * =======================
 * New: Multi-pool state + secrets
 * =======================
 */
function loadAppState() {
  const app = mustRead("deploy/state.json", "deploy/state.json");
  if (!app?.operatorId) app.operatorId = CONFIG.operatorId;
  if (!app?.mirror) app.mirror = CONFIG.mirrorNode;
  if (!app?.network) app.network = CONFIG.network;
  return app;
}

function loadSecrets() {
  return mustRead("deploy/secrets.json", "deploy/secrets.json");
}

function loadPositionsDb() {
  const p = mustRead("deploy/positions.json", "deploy/positions.json");
  if (!p.accounts) p.accounts = {};
  return p;
}

function savePositionsDb(db) {
  writeJson("deploy/positions.json", db);
}

const PENDING_DB_PATH = "deploy/pending.json";
function loadPendingDb() {
  try {
    const p = readJson(PENDING_DB_PATH);
    if (!p.items) p.items = {};
    return p;
  } catch {
    return { items: {} };
  }
}
function savePendingDb(db) {
  writeJson(PENDING_DB_PATH, db);
}

function getPoolByKey(app, poolKey) {
  const p = (app.pools || []).find((x) => x.poolKey === poolKey);
  if (!p) throw new Error(`Pool not found: ${poolKey}`);
  const tA = app.tokens?.[p.tokenA];
  const tB = app.tokens?.[p.tokenB];
  if (!tA || !tB) throw new Error(`Token mapping missing for pool ${poolKey}`);
  return { pool: p, tokenAInfo: tA, tokenBInfo: tB };
}

/**
 * Compatibility wrapper (keeps old /api/state shape)
 */
function loadStateCompat() {
  const app = loadAppState();
  const secrets = loadSecrets();

  const p0 = (app.pools || [])[0];
  if (!p0) throw new Error("No pools found in deploy/state.json");

  const { pool, tokenAInfo, tokenBInfo } = getPoolByKey(app, p0.poolKey);
  const poolKeyDer = secrets?.pools?.[pool.poolKey]?.poolKeyDer;
  if (!poolKeyDer) throw new Error(`Missing poolKeyDer for ${pool.poolKey} in deploy/secrets.json`);

  const tokensList = Object.entries(app.tokens || {}).map(([symbol, info]) => ({
    symbol,
    name: symbol,
    tokenId: info.tokenId,
    decimals: info.decimals ?? 6,
  }));

  const decimals = tokenAInfo.decimals ?? app.decimalsDefault ?? 6;

  return {
    network: app.network,
    operatorId: app.operatorId,
    mirror: app.mirror,
    decimals,
    pool: {
      id: pool.poolAccountId,
      tokenA: { id: tokenAInfo.tokenId, symbol: pool.tokenA },
      tokenB: { id: tokenBInfo.tokenId, symbol: pool.tokenB },
      feeBps: pool.feeBps ?? 30,
      poolKey: pool.poolKey,
    },
    pools: (app.pools || []).map((p) => ({
      poolKey: p.poolKey,
      poolAccountId: p.poolAccountId,
      tokenA: p.tokenA,
      tokenB: p.tokenB,
      feeBps: p.feeBps ?? 30,
    })),
    poolKeyDer,
    tokensList,
  };
}

/**
 * =======================
 * Liquidity math (internal units, UI does NOT show share)
 * =======================
 */
function isqrtBig(n) {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + n / x1) >> 1n;
  }
  return x0;
}

function calcMintUnits(amountAUnits, amountBUnits, reserveA, reserveB, totalUnits) {
  if (amountAUnits <= 0 || amountBUnits <= 0) return 0;
  if (totalUnits <= 0 || reserveA <= 0 || reserveB <= 0) {
    const u = isqrtBig(BigInt(amountAUnits) * BigInt(amountBUnits));
    return Number(u);
  }
  const u1 = Math.floor((amountAUnits * totalUnits) / reserveA);
  const u2 = Math.floor((amountBUnits * totalUnits) / reserveB);
  return Math.max(0, Math.min(u1, u2));
}

function calcBurnAmounts(units, reserveA, reserveB, totalUnits) {
  if (units <= 0 || totalUnits <= 0) return { outA: 0, outB: 0 };
  const outA = Math.floor((reserveA * units) / totalUnits);
  const outB = Math.floor((reserveB * units) / totalUnits);
  return { outA, outB };
}

/**
 * =======================
 * Reserves cache
 * =======================
 */
let cached = { at: 0, byPoolKey: {} };

async function getReservesCached(poolAccountId, tokenAId, tokenBId, poolKey, ttlMs = 1200) {
  const now = Date.now();
  const hit = cached.byPoolKey[poolKey];
  if (hit && now - hit.at < ttlMs) return hit.reserves;

  const [rA, rB] = await Promise.all([
    getTokenBalanceUnits(poolAccountId, tokenAId),
    getTokenBalanceUnits(poolAccountId, tokenBId),
  ]);

  const reserves = { reserveA: rA, reserveB: rB };
  cached.byPoolKey[poolKey] = { at: now, reserves };
  return reserves;
}

function clearReservesCache() {
  cached = { at: 0, byPoolKey: {} };
}

/**
 * =======================
 * Faucet cooldown storage
 * =======================
 */
const FAUCET_DB_PATH = "faucet_db.json";
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const FAUCET_AMOUNT_TOKENS = 20;

function loadFaucetDb() {
  try {
    return JSON.parse(fs.readFileSync(FAUCET_DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveFaucetDb(db) {
  fs.writeFileSync(FAUCET_DB_PATH, JSON.stringify(db, null, 2));
}

/**
 * =======================
 * Express app
 * =======================
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));

/**
 * =======================
 * Public Anti-Spam (Rate limit)
 * =======================
 * limiter: áp dụng chung
 * txLimiter: áp dụng cho endpoint tạo/ký/gửi tx (swap/faucet/build/submit)
 */
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});

const txLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 12,             // 12 tx-requests/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

/**
 * =======================
 * Routes: Health / State / Pools
 * =======================
 */
app.get("/api/health", async (req, res) => {
  try {
    const state = loadStateCompat();
    res.json({ ok: true, network: state.network, pool: state.pool.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/api/state", async (req, res) => {
  try {
    const state = loadStateCompat();
    const reserves = await getReservesCached(
      state.pool.id,
      state.pool.tokenA.id,
      state.pool.tokenB.id,
      state.pool.poolKey,
      0
    );

    res.json({
      network: state.network,
      operatorId: state.operatorId,
      mirror: state.mirror,
      decimals: state.decimals,

      pool: state.pool,
      pools: state.pools,
      reserves,

      tokens: state.tokensList,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/api/pools", async (req, res) => {
  try {
    const state = loadStateCompat();
    res.json({ ok: true, pools: state.pools });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/api/pool/state", async (req, res) => {
  try {
    const appState = loadAppState();
    const poolKey = safeStr(req.query.poolKey);
    if (!poolKey) return res.status(400).json({ ok: false, error: "missing poolKey" });

    const { pool, tokenAInfo, tokenBInfo } = getPoolByKey(appState, poolKey);

    const reserves = await getReservesCached(
      pool.poolAccountId,
      tokenAInfo.tokenId,
      tokenBInfo.tokenId,
      poolKey,
      0
    );

    res.json({
      ok: true,
      poolKey,
      poolId: pool.poolAccountId,
      tokenA: { symbol: pool.tokenA, tokenId: tokenAInfo.tokenId, decimals: tokenAInfo.decimals ?? 6 },
      tokenB: { symbol: pool.tokenB, tokenId: tokenBInfo.tokenId, decimals: tokenBInfo.decimals ?? 6 },
      feeBps: pool.feeBps ?? 30,
      reserves,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Swap quote (default pool)
 * =======================
 */
app.get("/api/quote", async (req, res) => {
  try {
    const state = loadStateCompat();
    const from = String(req.query.from || "hUSD");
    const to = String(req.query.to || "hEUR");
    const amountTokens = Number(req.query.amount || "0");
    const slippageBps = clampInt(req.query.slippageBps ?? 50);
    const feeBps = clampInt(req.query.feeBps ?? state.pool.feeBps ?? 30);

    const ONE = 10 ** state.decimals;
    const amountIn = Math.floor(amountTokens * ONE);
    if (amountIn <= 0) return res.status(400).json({ ok: false, error: "amount must be > 0" });

    const reserves = await getReservesCached(
      state.pool.id,
      state.pool.tokenA.id,
      state.pool.tokenB.id,
      state.pool.poolKey,
      0
    );

    const reserveA = reserves.reserveA;
    const reserveB = reserves.reserveB;

    let tokenIn, tokenOut, reserveIn, reserveOut;
    if (from === "hUSD" && to === "hEUR") {
      tokenIn = state.pool.tokenA.id; tokenOut = state.pool.tokenB.id;
      reserveIn = reserveA; reserveOut = reserveB;
    } else if (from === "hEUR" && to === "hUSD") {
      tokenIn = state.pool.tokenB.id; tokenOut = state.pool.tokenA.id;
      reserveIn = reserveB; reserveOut = reserveA;
    } else {
      return res.status(400).json({ ok: false, error: "unsupported pair" });
    }

    const amountOut = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    const minOut = Math.floor((amountOut * (10000 - slippageBps)) / 10000);

    res.json({
      ok: true,
      poolId: state.pool.id,
      from, to,
      decimals: state.decimals,
      feeBps, slippageBps,
      amountInTokens: amountTokens,
      amountInUnits: amountIn,
      amountOutUnits: amountOut,
      amountOutTokens: amountOut / ONE,
      minOutUnits: minOut,
      minOutTokens: minOut / ONE,
      reserves: { reserveA, reserveB },
      tokenIn, tokenOut,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Swap (backend-sign demo only for operator)
 * =======================
 */
app.post("/api/swap", txLimiter, async (req, res) => {
  try {
    const state = loadStateCompat();
    const client = getClient();

    const from = String(req.body?.from || "hUSD");
    const to = String(req.body?.to || "hEUR");
    const amountTokens = Number(req.body?.amount || 0);
    const slippageBps = clampInt(req.body?.slippageBps ?? 50);
    const feeBps = clampInt(req.body?.feeBps ?? state.pool.feeBps ?? 30);

    const ONE = 10 ** state.decimals;
    const amountIn = Math.floor(amountTokens * ONE);
    if (amountIn <= 0) return res.status(400).json({ ok: false, error: "amount must be > 0" });

    const reserves = await getReservesCached(
      state.pool.id,
      state.pool.tokenA.id,
      state.pool.tokenB.id,
      state.pool.poolKey,
      0
    );

    const reserveA = reserves.reserveA;
    const reserveB = reserves.reserveB;

    let tokenIn, tokenOut, reserveIn, reserveOut;
    if (from === "hUSD" && to === "hEUR") {
      tokenIn = state.pool.tokenA.id; tokenOut = state.pool.tokenB.id;
      reserveIn = reserveA; reserveOut = reserveB;
    } else if (from === "hEUR" && to === "hUSD") {
      tokenIn = state.pool.tokenB.id; tokenOut = state.pool.tokenA.id;
      reserveIn = reserveB; reserveOut = reserveA;
    } else {
      return res.status(400).json({ ok: false, error: "unsupported pair" });
    }

    const amountOut = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    if (amountOut <= 0) return res.status(400).json({ ok: false, error: "amountOut = 0 (bad reserves?)" });

    const minOut = Math.floor((amountOut * (10000 - slippageBps)) / 10000);
    if (amountOut > reserveOut) return res.status(400).json({ ok: false, error: "pool insufficient reserveOut" });

    // DEMO: trader = operator only
    const traderId = state.operatorId;

    const tx = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenIn), AccountId.fromString(traderId), -amountIn)
      .addTokenTransfer(TokenId.fromString(tokenIn), AccountId.fromString(state.pool.id), amountIn)
      .addTokenTransfer(TokenId.fromString(tokenOut), AccountId.fromString(state.pool.id), -amountOut)
      .addTokenTransfer(TokenId.fromString(tokenOut), AccountId.fromString(traderId), amountOut)
      .setMaxTransactionFee(new Hbar(5))
      .setTransactionMemo("HashSwap:swap:backend");

    const frozen = await tx.freezeWith(client);

    const operatorKey = parseOperatorKey();
    const poolKey = PrivateKey.fromStringDer(String(state.poolKeyDer).trim());

    const signed = await (await frozen.sign(operatorKey)).sign(poolKey);
    const submit = await signed.execute(client);
    const receipt = await submit.getReceipt(client);

    clearReservesCache();

    res.json({
      ok: true,
      status: receipt.status.toString(),
      txId: submit.transactionId.toString(),
      from, to,
      amountInTokens: amountTokens,
      amountInUnits: amountIn,
      amountOutUnits: amountOut,
      amountOutTokens: amountOut / ONE,
      minOutUnits: minOut,
      minOutTokens: minOut / ONE,
      feeBps, slippageBps,
      poolId: state.pool.id,
      tokenIn, tokenOut,
    });

    client.close();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Swap: Build unsigned tx (wallet will sign), store pending
 * =======================
 * body: { poolKey, accountId, from, to, amount, slippageBps }
 */
app.post("/api/tx/build/swap", txLimiter, async (req, res) => {
  try {
    const appState = loadAppState();

    const poolKey = safeStr(req.body?.poolKey) || (loadStateCompat().pool?.poolKey ?? "hUSD-hEUR");
    const accountId = safeStr(req.body?.accountId);
    const from = safeStr(req.body?.from || "hUSD");
    const to = safeStr(req.body?.to || "hEUR");
    const amountTokens = Number(req.body?.amount ?? 0);
    const slippageBps = clampInt(req.body?.slippageBps ?? 50);

    const { pool, tokenAInfo, tokenBInfo } = getPoolByKey(appState, poolKey);
    const feeBps = clampInt(req.body?.feeBps ?? pool.feeBps ?? 30);

    if (!accountId) throw new Error("Missing accountId");
    if (!Number.isFinite(amountTokens) || amountTokens <= 0) throw new Error("Invalid amount");

    const isAToB = (from === pool.tokenA && to === pool.tokenB);
    const isBToA = (from === pool.tokenB && to === pool.tokenA);
    if (!isAToB && !isBToA) throw new Error("unsupported pair for this pool");

    const decIn = (isAToB ? (tokenAInfo.decimals ?? 6) : (tokenBInfo.decimals ?? 6));
    const decOut = (isAToB ? (tokenBInfo.decimals ?? 6) : (tokenAInfo.decimals ?? 6));

    const ONE_IN = 10 ** decIn;
    const amountInUnits = Math.floor(amountTokens * ONE_IN);
    if (amountInUnits <= 0) throw new Error("amountInUnits computed as 0");

    const reserves = await getReservesCached(
      pool.poolAccountId,
      tokenAInfo.tokenId,
      tokenBInfo.tokenId,
      poolKey,
      0
    );

    const reserveA = reserves.reserveA;
    const reserveB = reserves.reserveB;

    const reserveIn = isAToB ? reserveA : reserveB;
    const reserveOut = isAToB ? reserveB : reserveA;

    if (reserveIn <= 0 || reserveOut <= 0) throw new Error("Pool not seeded (zero reserves)");

    const amountOutUnits = getAmountOut(amountInUnits, reserveIn, reserveOut, feeBps);
    if (amountOutUnits <= 0) throw new Error("amountOut computed as 0");
    if (amountOutUnits > reserveOut) throw new Error("pool insufficient reserveOut");

    const minOutUnits = Math.floor((amountOutUnits * (10000 - slippageBps)) / 10000);

    const tokenInId = isAToB ? tokenAInfo.tokenId : tokenBInfo.tokenId;
    const tokenOutId = isAToB ? tokenBInfo.tokenId : tokenAInfo.tokenId;

    const tx = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenInId), AccountId.fromString(accountId), -amountInUnits)
      .addTokenTransfer(TokenId.fromString(tokenInId), AccountId.fromString(pool.poolAccountId), amountInUnits)
      .addTokenTransfer(TokenId.fromString(tokenOutId), AccountId.fromString(pool.poolAccountId), -amountOutUnits)
      .addTokenTransfer(TokenId.fromString(tokenOutId), AccountId.fromString(accountId), amountOutUnits)
      .setMaxTransactionFee(new Hbar(5))
      .setTransactionMemo(`HashSwap:swap:${poolKey}`);

    const client = getClient();
    const frozen = await tx.freezeWith(client);
    client.close();

    const pendingId = `${poolKey}|${accountId}|swap|${nowMs()}`;
    const pend = loadPendingDb();
    pend.items[pendingId] = {
      createdAt: nowMs(),
      action: "swap",
      poolKey,
      accountId,
      poolAccountId: pool.poolAccountId,
      from,
      to,
      tokenInId,
      tokenOutId,
      amountInUnits,
      amountOutUnits,
      minOutUnits,
      decIn,
      decOut,
      feeBps,
      slippageBps,
    };
    savePendingDb(pend);

    res.json({
      ok: true,
      pendingId,
      poolKey,
      accountId,
      from,
      to,
      feeBps,
      slippageBps,
      amountInTokens: amountTokens,
      amountInUnits,
      amountOutUnits,
      amountOutTokens: amountOutUnits / (10 ** decOut),
      minOutUnits,
      minOutTokens: minOutUnits / (10 ** decOut),
      txBytesBase64: Buffer.from(frozen.toBytes()).toString("base64"),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Liquidity: Position
 * =======================
 */
app.get("/api/liquidity/position", async (req, res) => {
  try {
    const appState = loadAppState();
    const accountId = safeStr(req.query.accountId);
    const poolKey = safeStr(req.query.poolKey);
    if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });
    if (!poolKey) return res.status(400).json({ ok: false, error: "missing poolKey" });

    const { pool, tokenAInfo, tokenBInfo } = getPoolByKey(appState, poolKey);
    const db = loadPositionsDb();

    const pos = db.accounts?.[accountId]?.[poolKey] || { depositedAUnits: 0, depositedBUnits: 0, units: 0 };
    const decA = tokenAInfo.decimals ?? 6;
    const decB = tokenBInfo.decimals ?? 6;

    const reserves = await getReservesCached(
      pool.poolAccountId,
      tokenAInfo.tokenId,
      tokenBInfo.tokenId,
      poolKey,
      0
    );

    const totalUnits = Number(db.totalUnits?.[poolKey] ?? 0);
    const { outA, outB } = calcBurnAmounts(Number(pos.units || 0), reserves.reserveA, reserves.reserveB, totalUnits);

    res.json({
      ok: true,
      accountId,
      poolKey,
      depositedA: pos.depositedAUnits / Math.pow(10, decA),
      depositedB: pos.depositedBUnits / Math.pow(10, decB),
      depositedAUnits: pos.depositedAUnits,
      depositedBUnits: pos.depositedBUnits,
      units: pos.units,
      estimateRemoveAll: {
        amountA: outA / Math.pow(10, decA),
        amountB: outB / Math.pow(10, decB),
        amountAUnits: outA,
        amountBUnits: outB,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Liquidity: Build unsigned tx (wallet will sign), store pending
 * =======================
 */
app.post("/api/tx/build/liquidity/add", txLimiter, async (req, res) => {
  try {
    const appState = loadAppState();
    const poolKey = safeStr(req.body?.poolKey);
    const accountId = safeStr(req.body?.accountId);
    const amountA = Number(req.body?.amountA ?? 0);

    if (!poolKey) throw new Error("Missing poolKey");
    if (!accountId) throw new Error("Missing accountId");
    if (!Number.isFinite(amountA) || amountA <= 0) throw new Error("Invalid amountA");

    const { pool, tokenAInfo, tokenBInfo } = getPoolByKey(appState, poolKey);

    const decA = tokenAInfo.decimals ?? 6;
    const decB = tokenBInfo.decimals ?? 6;

    const ONE_A = 10 ** decA;
    const ONE_B = 10 ** decB;

    const amountAUnits = Math.floor(amountA * ONE_A);

    const reserves = await getReservesCached(
      pool.poolAccountId,
      tokenAInfo.tokenId,
      tokenBInfo.tokenId,
      poolKey,
      0
    );

    if (reserves.reserveA <= 0 || reserves.reserveB <= 0) {
      throw new Error("Pool not seeded yet (reserves are zero)");
    }

    const amountBUnits = Math.floor((amountAUnits * reserves.reserveB) / reserves.reserveA);
    if (amountBUnits <= 0) throw new Error("amountBUnits computed as 0");

    const positions = loadPositionsDb();
    if (!positions.totalUnits) positions.totalUnits = {};
    const totalUnits = Number(positions.totalUnits[poolKey] ?? 0);
    const mintUnits = calcMintUnits(amountAUnits, amountBUnits, reserves.reserveA, reserves.reserveB, totalUnits);
    if (mintUnits <= 0) throw new Error("mintUnits computed as 0");

    const tx = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenAInfo.tokenId), AccountId.fromString(accountId), -amountAUnits)
      .addTokenTransfer(TokenId.fromString(tokenAInfo.tokenId), AccountId.fromString(pool.poolAccountId), amountAUnits)
      .addTokenTransfer(TokenId.fromString(tokenBInfo.tokenId), AccountId.fromString(accountId), -amountBUnits)
      .addTokenTransfer(TokenId.fromString(tokenBInfo.tokenId), AccountId.fromString(pool.poolAccountId), amountBUnits)
      .setMaxTransactionFee(new Hbar(5))
      .setTransactionMemo(`HashSwap:liq:add:${poolKey}`);

    const client = getClient();
    const frozen = await tx.freezeWith(client);
    client.close();

    const pendingId = `${poolKey}|${accountId}|add|${nowMs()}`;
    const pend = loadPendingDb();
    pend.items[pendingId] = {
      createdAt: nowMs(),
      action: "liq_add",
      poolKey,
      accountId,
      poolAccountId: pool.poolAccountId,
      tokenAId: tokenAInfo.tokenId,
      tokenBId: tokenBInfo.tokenId,
      amountAUnits,
      amountBUnits,
      mintUnits,
      decA,
      decB,
    };
    savePendingDb(pend);

    res.json({
      ok: true,
      pendingId,
      poolKey,
      accountId,
      amountA,
      amountB: amountBUnits / ONE_B,
      amountAUnits,
      amountBUnits,
      txBytesBase64: Buffer.from(frozen.toBytes()).toString("base64"),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

app.post("/api/tx/build/liquidity/remove", txLimiter, async (req, res) => {
  try {
    const appState = loadAppState();
    const poolKey = safeStr(req.body?.poolKey);
    const accountId = safeStr(req.body?.accountId);
    const percent = Number(req.body?.percent ?? 0);

    if (!poolKey) throw new Error("Missing poolKey");
    if (!accountId) throw new Error("Missing accountId");
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error("Invalid percent (1..100)");

    const { pool, tokenAInfo, tokenBInfo } = getPoolByKey(appState, poolKey);

    const positions = loadPositionsDb();
    if (!positions.totalUnits) positions.totalUnits = {};
    const totalUnits = Number(positions.totalUnits[poolKey] ?? 0);
    if (totalUnits <= 0) throw new Error("Pool has no totalUnits");

    const userPos = positions.accounts?.[accountId]?.[poolKey];
    if (!userPos || Number(userPos.units || 0) <= 0) throw new Error("No liquidity position for this account");

    const userUnits = Number(userPos.units || 0);
    const burnUnits = Math.floor((userUnits * percent) / 100);
    if (burnUnits <= 0) throw new Error("burnUnits computed as 0");

    const reserves = await getReservesCached(
      pool.poolAccountId,
      tokenAInfo.tokenId,
      tokenBInfo.tokenId,
      poolKey,
      0
    );

    const { outA, outB } = calcBurnAmounts(burnUnits, reserves.reserveA, reserves.reserveB, totalUnits);
    if (outA <= 0 || outB <= 0) throw new Error("Remove amounts computed as 0");

    const tx = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenAInfo.tokenId), AccountId.fromString(pool.poolAccountId), -outA)
      .addTokenTransfer(TokenId.fromString(tokenAInfo.tokenId), AccountId.fromString(accountId), outA)
      .addTokenTransfer(TokenId.fromString(tokenBInfo.tokenId), AccountId.fromString(pool.poolAccountId), -outB)
      .addTokenTransfer(TokenId.fromString(tokenBInfo.tokenId), AccountId.fromString(accountId), outB)
      .setMaxTransactionFee(new Hbar(5))
      .setTransactionMemo(`HashSwap:liq:remove:${poolKey}`);

    const client = getClient();
    const frozen = await tx.freezeWith(client);
    client.close();

    const pendingId = `${poolKey}|${accountId}|remove|${nowMs()}`;
    const pend = loadPendingDb();
    pend.items[pendingId] = {
      createdAt: nowMs(),
      action: "liq_remove",
      poolKey,
      accountId,
      poolAccountId: pool.poolAccountId,
      tokenAId: tokenAInfo.tokenId,
      tokenBId: tokenBInfo.tokenId,
      burnUnits,
      outA,
      outB,
      percent,
    };
    savePendingDb(pend);

    res.json({
      ok: true,
      pendingId,
      poolKey,
      accountId,
      percent,
      outAUnits: outA,
      outBUnits: outB,
      txBytesBase64: Buffer.from(frozen.toBytes()).toString("base64"),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Wallet-signed tx submit:
 * wallet signs frozen tx -> send back -> backend adds pool+operator -> execute
 * =======================
 */
app.post("/api/tx/submit", txLimiter, async (req, res) => {
  try {
    const pendingId = safeStr(req.body?.pendingId);
    const signedTxBase64 = safeStr(req.body?.signedTxBase64);

    if (!pendingId) throw new Error("Missing pendingId");
    if (!signedTxBase64) throw new Error("Missing signedTxBase64");

    const pendDb = loadPendingDb();
    const p = pendDb.items[pendingId];
    if (!p) throw new Error("Pending item not found (expired?)");

    const signedBytes = Buffer.from(signedTxBase64, "base64");
    let tx = Transaction.fromBytes(signedBytes);

    const operatorKey = parseOperatorKey();
    const client = getClient();

    const secrets = loadSecrets();
    const poolKeyDer = secrets?.pools?.[p.poolKey]?.poolKeyDer;
    if (!poolKeyDer) throw new Error(`Missing poolKeyDer for ${p.poolKey} in deploy/secrets.json`);
    const poolKey = PrivateKey.fromStringDer(String(poolKeyDer).trim());

    // Sign by pool + operator (safe for swap/remove; harmless for add)
    tx = await (await tx.sign(poolKey)).sign(operatorKey);

    const submit = await tx.execute(client);
    const receipt = await submit.getReceipt(client);

    const status = receipt.status.toString();
    if (status !== "SUCCESS") {
      return res.status(400).json({ ok: false, error: `Tx status: ${status}`, txId: submit.transactionId.toString() });
    }

    // Update positions only for liquidity
    if (p.action === "liq_add" || p.action === "liq_remove") {
      const positions = loadPositionsDb();
      if (!positions.accounts) positions.accounts = {};
      if (!positions.totalUnits) positions.totalUnits = {};

      if (!positions.accounts[p.accountId]) positions.accounts[p.accountId] = {};
      if (!positions.accounts[p.accountId][p.poolKey]) {
        positions.accounts[p.accountId][p.poolKey] = { depositedAUnits: 0, depositedBUnits: 0, units: 0 };
      }

      const userPos = positions.accounts[p.accountId][p.poolKey];
      const totalUnits = Number(positions.totalUnits[p.poolKey] ?? 0);

      if (p.action === "liq_add") {
        userPos.depositedAUnits = Number(userPos.depositedAUnits || 0) + Number(p.amountAUnits);
        userPos.depositedBUnits = Number(userPos.depositedBUnits || 0) + Number(p.amountBUnits);
        userPos.units = Number(userPos.units || 0) + Number(p.mintUnits);

        positions.totalUnits[p.poolKey] = totalUnits + Number(p.mintUnits);
      } else if (p.action === "liq_remove") {
        userPos.units = Math.max(0, Number(userPos.units || 0) - Number(p.burnUnits));
        positions.totalUnits[p.poolKey] = Math.max(0, totalUnits - Number(p.burnUnits));
      }

      savePositionsDb(positions);
    } else if (p.action === "swap") {
      // swap: no positions update
    } else {
      throw new Error(`Unknown pending action: ${p.action}`);
    }

    // cleanup pending
    delete pendDb.items[pendingId];
    savePendingDb(pendDb);

    clearReservesCache();

    res.json({
      ok: true,
      status,
      txId: submit.transactionId.toString(),
      pendingId,
      action: p.action,
    });

    client.close();
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * =======================
 * Faucet routes
 * =======================
 */
app.get("/api/faucet/status", async (req, res) => {
  try {
    const state = loadStateCompat();
    const accountId = String(req.query.accountId || "").trim();
    if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

    const db = loadFaucetDb();
    const last = db[accountId]?.lastClaimAt || 0;
    const now = Date.now();
    const remainingMs = Math.max(0, last + COOLDOWN_MS - now);

    const associated = await getAssociatedTokenIds(accountId);
    const notAssociated = state.tokensList
      .filter((t) => !associated.has(t.tokenId))
      .map((t) => ({ symbol: t.symbol, tokenId: t.tokenId }));

    res.json({
      ok: true,
      accountId,
      canClaim: remainingMs === 0,
      remainingMs,
      cooldownMs: COOLDOWN_MS,
      nextClaimAt: last ? last + COOLDOWN_MS : null,
      faucetAmountTokens: FAUCET_AMOUNT_TOKENS,
      tokens: state.tokensList.map((t) => ({ symbol: t.symbol, tokenId: t.tokenId, decimals: t.decimals })),
      notAssociated,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post("/api/faucet/claim", txLimiter, async (req, res) => {
  try {
    const state = loadStateCompat();
    const client = getClient();

    const accountId = String(req.body?.accountId || "").trim();
    if (!accountId) return res.status(400).json({ ok: false, error: "missing accountId" });

    const db = loadFaucetDb();
    const last = db[accountId]?.lastClaimAt || 0;
    const now = Date.now();
    const remainingMs = Math.max(0, last + COOLDOWN_MS - now);
    if (remainingMs > 0) {
      return res.status(429).json({
        ok: false,
        error: "COOLDOWN",
        remainingMs,
        nextClaimAt: last + COOLDOWN_MS,
      });
    }

    const associated = await getAssociatedTokenIds(accountId);
    const notAssociated = state.tokensList.filter((t) => !associated.has(t.tokenId));
    if (notAssociated.length) {
      return res.status(400).json({
        ok: false,
        error: "ACCOUNT_NOT_ASSOCIATED",
        message: "Please associate tokens in your wallet first, then claim again.",
        notAssociated: notAssociated.map((t) => ({ symbol: t.symbol, tokenId: t.tokenId })),
      });
    }

    const tx = new TransferTransaction().setMaxTransactionFee(new Hbar(10));

    const transfers = [];
    for (const t of state.tokensList) {
      const ONE = 10 ** (t.decimals ?? 6);
      const amountUnits = FAUCET_AMOUNT_TOKENS * ONE;

      tx.addTokenTransfer(TokenId.fromString(t.tokenId), AccountId.fromString(state.operatorId), -amountUnits);
      tx.addTokenTransfer(TokenId.fromString(t.tokenId), AccountId.fromString(accountId), amountUnits);

      transfers.push({ symbol: t.symbol, tokenId: t.tokenId, amountTokens: FAUCET_AMOUNT_TOKENS, amountUnits });
    }

    const frozen = await tx.freezeWith(client);
    const operatorKey = parseOperatorKey();
    const signed = await frozen.sign(operatorKey);

    const submit = await signed.execute(client);
    const receipt = await submit.getReceipt(client);

    db[accountId] = { lastClaimAt: Date.now() };
    saveFaucetDb(db);

    res.json({
      ok: true,
      status: receipt.status.toString(),
      txId: submit.transactionId.toString(),
      accountId,
      cooldownMs: COOLDOWN_MS,
      nextClaimAt: db[accountId].lastClaimAt + COOLDOWN_MS,
      transfers,
    });

    client.close();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/", (req, res) => {
  res.type("text").send("HashSwap API is running. Try /api/health");
});

/**
 * =======================
 * Listen (Render compatible)
 * =======================
 */
const PORT = process.env.PORT || 8787;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`HashSwap API listening on http://0.0.0.0:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /api/health");
  console.log("  GET  /api/state");
  console.log("  GET  /api/pools");
  console.log("  GET  /api/pool/state?poolKey=hUSD-hEUR");
  console.log("  GET  /api/quote?from=hUSD&to=hEUR&amount=100");
  console.log("  POST /api/swap {from,to,amount,slippageBps}");
  console.log("  POST /api/tx/build/swap {poolKey,accountId,from,to,amount,slippageBps}");
  console.log("  GET  /api/liquidity/position?accountId=0.0.x&poolKey=hUSD-hEUR");
  console.log("  POST /api/tx/build/liquidity/add {poolKey,accountId,amountA}");
  console.log("  POST /api/tx/build/liquidity/remove {poolKey,accountId,percent}");
  console.log("  POST /api/tx/submit {pendingId,signedTxBase64}");
  console.log("  GET  /api/faucet/status?accountId=0.0.x");
  console.log("  POST /api/faucet/claim {accountId}");
});