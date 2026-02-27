import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  network: process.env.HEDERA_NETWORK || "testnet",
  operatorId: process.env.OPERATOR_ID,
  operatorKey: process.env.OPERATOR_KEY,
  mirrorNode: process.env.MIRROR_NODE || "https://testnet.mirrornode.hedera.com",
};

export function assertEnv() {
  const missing = [];
  if (!CONFIG.operatorId) missing.push("OPERATOR_ID");
  if (!CONFIG.operatorKey) missing.push("OPERATOR_KEY");
  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}. Check .env file.`);
  }
}