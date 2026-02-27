import { Client, AccountId, PrivateKey } from "@hashgraph/sdk";
import { CONFIG, assertEnv } from "./config.js";

function parseOperatorKey(keyStr) {
  let k = String(keyStr || "").trim();

  // remove quotes if accidentally pasted
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }

  // remove 0x if any
  if (k.startsWith("0x") || k.startsWith("0X")) k = k.slice(2);

  // ✅ If it's raw HEX 64 chars -> likely ECDSA private key
  // (portal ECDSA private key is often shown as raw hex)
  if (/^[0-9a-fA-F]{64}$/.test(k) || /^[0-9a-fA-F]{66}$/.test(k)) {
    // Some keys may have leading "01" etc; SDK expects hex bytes, it can handle it
    return PrivateKey.fromStringECDSA(k.toLowerCase());
  }

  // ✅ DER-encoded hex (ED25519/ECDSA) often starts with 30...
  if (/^30[0-9a-fA-F]+$/.test(k)) {
    return PrivateKey.fromStringDer(k);
  }

  // fallback auto-detect
  return PrivateKey.fromString(k);
}

export function getClient() {
  assertEnv();

  const client =
    CONFIG.network === "mainnet" ? Client.forMainnet() :
    CONFIG.network === "previewnet" ? Client.forPreviewnet() :
    Client.forTestnet();

  const operatorId = AccountId.fromString(CONFIG.operatorId);
  const operatorKey = parseOperatorKey(CONFIG.operatorKey);

  client.setOperator(operatorId, operatorKey);
  return client;
}