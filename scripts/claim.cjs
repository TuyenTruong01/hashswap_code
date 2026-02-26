const { ethers } = require("hardhat");

const FAUCET_ABI = [
  "function claimHOUSE() external",
  "function claimBICY() external"
];

async function main() {
  const faucetAddr = "0x8d1c7a5580992476aDdE8D9EC216360D1b7f31f8";
  const [user] = await ethers.getSigners();

  console.log("User:", user.address);

  const faucet = new ethers.Contract(faucetAddr, FAUCET_ABI, user);

  console.log("Claiming HOUSE...");
  let tx = await faucet.claimHOUSE();
  await tx.wait();

  console.log("Claiming BICY...");
  tx = await faucet.claimBICY();
  await tx.wait();

  console.log("✅ Claim complete");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
