import { getClient } from "../src/hederaClient.js";
import { AccountBalanceQuery } from "@hashgraph/sdk";
import { CONFIG } from "../src/config.js";

async function main() {
  const client = getClient();
  const bal = await new AccountBalanceQuery()
    .setAccountId(CONFIG.operatorId)
    .execute(client);

  console.log("✅ Operator balance:", bal.hbars.toString());
  client.close();
}

main().catch((e) => {
  console.error("❌ Ping failed:", e.message || e);
  process.exit(1);
});