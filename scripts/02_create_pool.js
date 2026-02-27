import fs from "fs";
import { getClient } from "../src/hederaClient.js";
import { createPoolAccount, associateTokens } from "../src/hts.js";

function readTokens() {
  const raw = fs.readFileSync("deployments_tokens.json", "utf8");
  return JSON.parse(raw);
}

async function main() {
  const client = getClient();
  const tokens = readTokens();

  // ✅ pool pair đầu tiên: hUSD / hEUR
  const tokenA = tokens.tokens.find((x) => x.symbol === "hUSD")?.tokenId;
  const tokenB = tokens.tokens.find((x) => x.symbol === "hEUR")?.tokenId;

  if (!tokenA || !tokenB) throw new Error("Missing tokenId for hUSD/hEUR");

  console.log("Creating pool account for pair:", tokenA, tokenB);

  // 1) create pool account with some HBAR for fees
  const pool = await createPoolAccount(client, {
    initialHbar: 10,
    memo: "HashSwap Pool hUSD-hEUR",
  });

  console.log("✅ poolAccountId:", pool.accountId);
  console.log("   txId:", pool.txId);

  // 2) associate pool account with both tokens (must sign with pool key)
  console.log("Associating tokens to pool account...");
  const assoc = await associateTokens(client, {
    accountId: pool.accountId,
    accountKeyDer: pool.privateKeyDer,
    tokenIds: [tokenA, tokenB],
  });

  console.log("✅ associate status:", assoc.status);
  console.log("   txId:", assoc.txId);

  const out = {
    createdAt: new Date().toISOString(),
    pair: { tokenA, tokenB, symbolA: "hUSD", symbolB: "hEUR" },
    poolAccount: {
      accountId: pool.accountId,
      privateKeyDer: pool.privateKeyDer, // ⚠️ file local only, never push git
      publicKeyDer: pool.publicKeyDer,
    },
    tx: { createAccountTxId: pool.txId, associateTxId: assoc.txId },
  };

  fs.writeFileSync("deployments_pool_husd_heurs.json", JSON.stringify(out, null, 2));
  console.log("\nSaved -> deployments_pool_husd_heurs.json");

  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});