import fs from "fs";
import {
  TransferTransaction,
  AccountId,
  TokenId,
  PrivateKey,
  Hbar,
} from "@hashgraph/sdk";

import { getClient } from "../src/hederaClient.js";
import { CONFIG } from "../src/config.js";
import { mirrorGet } from "../src/mirror.js";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

// Parse operator private key (ECDSA raw hex OR DER OR auto)
function parseOperatorKey() {
  let k = String(process.env.OPERATOR_KEY || "").trim();
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

async function getTokenBalanceUnits(accountId, tokenId) {
  // mirror: /api/v1/accounts/{id}/tokens?limit=100
  const data = await mirrorGet(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  const row = (data.tokens || []).find((t) => t.token_id === tokenId);
  return row ? Number(row.balance) : 0;
}

// Uniswap v2 style quote with feeBps (e.g. 30 = 0.30%)
function getAmountOut(amountIn, reserveIn, reserveOut, feeBps = 30) {
  if (amountIn <= 0) return 0;
  if (reserveIn <= 0 || reserveOut <= 0) return 0;

  const feeFactor = 10000 - feeBps; // 9970 for 0.3%
  const amountInWithFee = Math.floor((amountIn * feeFactor) / 10000);

  // amountOut = (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee)
  const numerator = reserveOut * amountInWithFee;
  const denominator = reserveIn + amountInWithFee;
  return Math.floor(numerator / denominator);
}

async function main() {
  const client = getClient();

  const tokens = readJson("deployments_tokens.json");
  const pool = readJson("deployments_pool_husd_heurs.json");

  const tokenA = pool.pair.tokenA; // hUSD
  const tokenB = pool.pair.tokenB; // hEUR
  const poolId = pool.poolAccount.accountId;
  const poolKeyDer = pool.poolAccount.privateKeyDer;

  const decimals =
    tokens.tokens.find((t) => t.tokenId === tokenA)?.decimals ?? 6;
  const ONE = 10 ** decimals;

  // ===== CHỌN HƯỚNG SWAP Ở ĐÂY =====
  // Swap hUSD -> hEUR
  const tokenIn = tokenA;
  const tokenOut = tokenB;
  const symbolIn = "hUSD";
  const symbolOut = "hEUR";

  // ===== INPUT =====
  const amountInTokens = 100; // đổi 100 hUSD
  const amountIn = amountInTokens * ONE;

  const feeBps = 30; // 0.30%
  const slippageBps = 50; // 0.50% (minOut = out*(1-0.5%))

  // For demo: trader = operator (treasury) (đã associate cả 2 token)
  const traderId = CONFIG.operatorId;

  // ===== READ RESERVES (Mirror) =====
  const reserveIn = await getTokenBalanceUnits(poolId, tokenIn);
  const reserveOut = await getTokenBalanceUnits(poolId, tokenOut);

  console.log("\n=== HASH SWAP ATOMIC ===");
  console.log("Pool:", poolId);
  console.log(`Pair: ${symbolIn}(${tokenIn}) -> ${symbolOut}(${tokenOut})`);
  console.log("Pool reserves (units):", { reserveIn, reserveOut });
  console.log(`amountIn: ${amountInTokens} ${symbolIn} => units ${amountIn}`);

  const amountOut = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
  if (amountOut <= 0) throw new Error("amountOut is 0 (check reserves/amountIn)");

  const minOut = Math.floor((amountOut * (10000 - slippageBps)) / 10000);

  console.log(`quote amountOut (units): ${amountOut}`);
  console.log(
    `minOut (slippage ${slippageBps / 100}%): ${minOut} units (~${minOut / ONE} ${symbolOut})`
  );

  // ===== BUILD ATOMIC TRANSFER TX (4 lines) =====
  const tx = new TransferTransaction()
    // tokenIn: trader -> pool
    .addTokenTransfer(
      TokenId.fromString(tokenIn),
      AccountId.fromString(traderId),
      -amountIn
    )
    .addTokenTransfer(
      TokenId.fromString(tokenIn),
      AccountId.fromString(poolId),
      amountIn
    )
    // tokenOut: pool -> trader
    .addTokenTransfer(
      TokenId.fromString(tokenOut),
      AccountId.fromString(poolId),
      -amountOut
    )
    .addTokenTransfer(
      TokenId.fromString(tokenOut),
      AccountId.fromString(traderId),
      amountOut
    )
    .setMaxTransactionFee(new Hbar(5));

  const frozen = await tx.freezeWith(client);

  // Sign by trader (operator) + pool
  const operatorKey = parseOperatorKey();
  const poolKey = PrivateKey.fromStringDer(String(poolKeyDer).trim());

  const signed1 = await frozen.sign(operatorKey);
  const signed2 = await signed1.sign(poolKey);

  const submit = await signed2.execute(client);
  const receipt = await submit.getReceipt(client);

  console.log("\n✅ Swap status:", receipt.status.toString());
  console.log("txId:", submit.transactionId.toString());

  // Optional: show new reserves
  const newReserveIn = await getTokenBalanceUnits(poolId, tokenIn);
  const newReserveOut = await getTokenBalanceUnits(poolId, tokenOut);
  console.log("New pool reserves (units):", {
    newReserveIn,
    newReserveOut,
  });

  client.close();
}

main().catch((e) => {
  console.error("❌ Swap failed:", e?.message || e);
  process.exit(1);
});