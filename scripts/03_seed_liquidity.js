import fs from "fs";
import { getClient } from "../src/hederaClient.js";
import { CONFIG } from "../src/config.js";
import { transferToken } from "../src/hts.js";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function main() {
  const client = getClient();

  const tokens = readJson("deployments_tokens.json");
  const pool = readJson("deployments_pool_husd_heurs.json");

  const tokenA = pool.pair.tokenA; // hUSD
  const tokenB = pool.pair.tokenB; // hEUR
  const poolAccountId = pool.poolAccount.accountId;

  // ====== CONFIG seed amounts (in smallest units of token, because HTS uses integer units)
  // decimals = 6 => 1 token = 1_000_000 units
  // Seed 10,000 hUSD and 10,000 hEUR:
  const DECIMALS = tokens.tokens.find((t) => t.tokenId === tokenA)?.decimals ?? 6;
  const ONE = 10 ** DECIMALS;

  const seedA_tokens = 100_000; // 10k hUSD
  const seedB_tokens = 100_000; // 10k hEUR

  const amountA = seedA_tokens * ONE;
  const amountB = seedB_tokens * ONE;

  console.log("Seeding liquidity to pool:", poolAccountId);
  console.log(`- TokenA (hUSD) ${tokenA}: ${seedA_tokens} => units ${amountA}`);
  console.log(`- TokenB (hEUR) ${tokenB}: ${seedB_tokens} => units ${amountB}`);

  // Transfer from operator treasury -> pool
  console.log("\nTransferring hUSD ...");
  const txA = await transferToken(client, {
    tokenId: tokenA,
    fromAccountId: CONFIG.operatorId,
    toAccountId: poolAccountId,
    amount: amountA,
    maxFeeHbar: 5,
  });
  console.log("✅", txA.status, txA.txId);

  console.log("\nTransferring hEUR ...");
  const txB = await transferToken(client, {
    tokenId: tokenB,
    fromAccountId: CONFIG.operatorId,
    toAccountId: poolAccountId,
    amount: amountB,
    maxFeeHbar: 5,
  });
  console.log("✅", txB.status, txB.txId);

  const out = {
    createdAt: new Date().toISOString(),
    poolAccountId,
    tokenA,
    tokenB,
    seed: {
      decimals: DECIMALS,
      tokenA: { symbol: "hUSD", tokens: seedA_tokens, units: amountA, txId: txA.txId },
      tokenB: { symbol: "hEUR", tokens: seedB_tokens, units: amountB, txId: txB.txId },
    },
  };

  fs.writeFileSync("deployments_seed_husd_heurs.json", JSON.stringify(out, null, 2));
  console.log("\nSaved -> deployments_seed_husd_heurs.json");

  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});