import {
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  AccountCreateTransaction,
  TokenAssociateTransaction,
  TransferTransaction,
  Hbar,
  PrivateKey,
  AccountId,
  TokenId,
} from "@hashgraph/sdk";

/**
 * Create a simple fungible token (HTS).
 * @returns {Promise<{tokenId: string, txId: string}>}
 */
export async function createFungibleToken(
  client,
  {
    name,
    symbol,
    decimals = 6,
    initialSupply = 1_000_000,
    maxSupply = 1_000_000_000,
    treasuryAccountId,
    maxFeeHbar = 20,
  }
) {
  const tx = new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(decimals)
    .setInitialSupply(initialSupply)
    .setSupplyType(TokenSupplyType.Finite)
    .setMaxSupply(maxSupply)
    .setTreasuryAccountId(treasuryAccountId)
    .setMaxTransactionFee(new Hbar(maxFeeHbar));

  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);

  return {
    tokenId: receipt.tokenId.toString(),
    txId: submit.transactionId.toString(),
  };
}

/**
 * Create a Hedera account for a pool (holds reserves).
 * IMPORTANT: We generate an ECDSA key for pool account.
 * Returns accountId + privateKeyDer so you can store it locally.
 */
export async function createPoolAccount(
  client,
  {
    initialHbar = 10,
    memo = "HashSwap Pool Account",
    maxFeeHbar = 2,
  } = {}
) {
  const poolKey = PrivateKey.generateECDSA();

  const tx = new AccountCreateTransaction()
    .setKey(poolKey.publicKey)
    .setInitialBalance(new Hbar(initialHbar))
    .setAccountMemo(memo)
    .setMaxTransactionFee(new Hbar(maxFeeHbar));

  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);

  return {
    accountId: receipt.accountId.toString(),
    privateKeyDer: poolKey.toStringDer(),        // keep secret, never commit
    publicKeyDer: poolKey.publicKey.toStringDer(),
    txId: submit.transactionId.toString(),
  };
}

/**
 * Associate an account with tokens (must sign by that account's key).
 * accountKeyDer is DER-encoded private key string.
 */
export async function associateTokens(
  client,
  { accountId, accountKeyDer, tokenIds, maxFeeHbar = 2 } = {}
) {
  if (!accountId) throw new Error("associateTokens: missing accountId");
  if (!accountKeyDer) throw new Error("associateTokens: missing accountKeyDer");
  if (!tokenIds?.length) throw new Error("associateTokens: missing tokenIds");

  const key = PrivateKey.fromStringDer(String(accountKeyDer).trim());

  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(accountId))
    .setTokenIds(tokenIds.map((t) => TokenId.fromString(t)))
    .setMaxTransactionFee(new Hbar(maxFeeHbar));

  const frozen = await tx.freezeWith(client);
  const signed = await frozen.sign(key);

  const submit = await signed.execute(client);
  const receipt = await submit.getReceipt(client);

  return {
    status: receipt.status.toString(),
    txId: submit.transactionId.toString(),
  };
}

/**
 * Transfer tokens from operator -> toAccount (operator signs).
 * Uses TransferTransaction (token transfers).
 */
export async function transferToken(
  client,
  { tokenId, fromAccountId, toAccountId, amount, maxFeeHbar = 2 } = {}
) {
  if (!tokenId) throw new Error("transferToken: missing tokenId");
  if (!fromAccountId) throw new Error("transferToken: missing fromAccountId");
  if (!toAccountId) throw new Error("transferToken: missing toAccountId");
  if (typeof amount !== "number") throw new Error("transferToken: amount must be number");

  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(fromAccountId), -amount)
    .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(toAccountId), amount)
    .setMaxTransactionFee(new Hbar(maxFeeHbar));

  const submit = await tx.execute(client);
  const receipt = await submit.getReceipt(client);

  return {
    status: receipt.status.toString(),
    txId: submit.transactionId.toString(),
  };
}

/**
 * Transfer tokens from poolAccount -> user (must sign with pool key).
 * Use this when pool needs to send tokenOut back to user.
 */
export async function transferTokenSigned(
  client,
  {
    tokenId,
    fromAccountId,
    fromAccountKeyDer, // pool private key (DER)
    toAccountId,
    amount,
    maxFeeHbar = 2,
  } = {}
) {
  if (!fromAccountKeyDer) throw new Error("transferTokenSigned: missing fromAccountKeyDer");

  const key = PrivateKey.fromStringDer(String(fromAccountKeyDer).trim());

  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(fromAccountId), -amount)
    .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(toAccountId), amount)
    .setMaxTransactionFee(new Hbar(maxFeeHbar));

  const frozen = await tx.freezeWith(client);
  const signed = await frozen.sign(key);

  const submit = await signed.execute(client);
  const receipt = await submit.getReceipt(client);

  return {
    status: receipt.status.toString(),
    txId: submit.transactionId.toString(),
  };
}