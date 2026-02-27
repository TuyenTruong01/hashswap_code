import { getClient } from "../src/hederaClient.js";
import { CONFIG } from "../src/config.js";
import { createFungibleToken } from "../src/hts.js";
import fs from "fs";

async function main() {
  const client = getClient();

  const decimals = 6;
  const ONE = 10 ** decimals;

  // 👉 Token amount theo "human readable"
  const initialTokens = 1_000_000;      // 1 triệu token
  const maxTokens = 1_000_000_000;      // 1 tỷ token

  const tokensToCreate = [
    { name: "Hash USD", symbol: "hUSD" },
    { name: "Hash EUR", symbol: "hEUR" },
    { name: "Hash VND", symbol: "hVND" },
  ];

  const out = {
    network: CONFIG.network,
    operatorId: CONFIG.operatorId,
    createdAt: new Date().toISOString(),
    decimals,
    initialTokens,
    maxTokens,
    tokens: [],
  };

  for (const t of tokensToCreate) {
    console.log(`\nCreating token: ${t.name} (${t.symbol}) ...`);

    const r = await createFungibleToken(client, {
      name: t.name,
      symbol: t.symbol,
      decimals,

      // ✅ scale sang units (smallest denomination)
      initialSupply: initialTokens * ONE,
      maxSupply: maxTokens * ONE,

      treasuryAccountId: CONFIG.operatorId,
    });

    console.log(`✅ tokenId: ${r.tokenId}`);
    console.log(`   txId:    ${r.txId}`);

    out.tokens.push({
      ...t,
      tokenId: r.tokenId,
      txId: r.txId,
    });
  }

  fs.writeFileSync("deployments_tokens.json", JSON.stringify(out, null, 2));
  console.log("\nSaved -> deployments_tokens.json");

  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});