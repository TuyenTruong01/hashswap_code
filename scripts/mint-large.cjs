const { ethers } = require("hardhat");

const FAUCET_ABI = [
  "function adminMint(address,uint256) external"
];

async function main() {
  const faucetAddr = "0xff63bB2Fe2a24C54bf11700a9125ee63633C3e0b";
  const [user] = await ethers.getSigners();

  const faucet = new ethers.Contract(faucetAddr, FAUCET_ABI, user);

  const amount = ethers.parseUnits("1000000", 18);

  console.log("Minting 1,000,000 each...");
  const tx = await faucet.adminMint(user.address, amount);
  await tx.wait();

  console.log("✅ Minted");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
