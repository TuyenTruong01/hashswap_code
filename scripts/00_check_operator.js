import { PrivateKey, AccountId } from "@hashgraph/sdk";
import dotenv from "dotenv";
dotenv.config();

let k = String(process.env.OPERATOR_KEY || "").trim();
if (k.startsWith("0x") || k.startsWith("0X")) k = k.slice(2);

const id = AccountId.fromString(process.env.OPERATOR_ID);
const pk = PrivateKey.fromStringECDSA(k);

console.log("OPERATOR_ID:", id.toString());
console.log("ECDSA PublicKey:", pk.publicKey.toString());