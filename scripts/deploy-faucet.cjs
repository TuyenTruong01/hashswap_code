require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // ⚠️ Đổi đúng địa chỉ token của bạn
  const TPI = "0xB21d98e7c364b7b947e9B02bB53a2d361557C1bC";
  const TXI = "0x03ee39B1e6Fb726429350199bf6056664c6cE3Ee";

  const DualFaucet = await ethers.getContractFactory("DualFaucet");
  const faucet = await DualFaucet.deploy(TPI, TXI);

  await faucet.waitForDeployment();

  console.log("Faucet deployed at:", await faucet.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});