async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const cap = ethers.parseUnits("1000000000", 18);

  const Token = await ethers.getContractFactory("CappedToken");

  const tpi = await Token.deploy("Tipi Token", "TPI", cap, deployer.address);
  await tpi.waitForDeployment();
  const TPI = await tpi.getAddress();
  console.log("TPI:", TPI);

  const txi = await Token.deploy("Tx Infrastructure", "TXI", cap, deployer.address);
  await txi.waitForDeployment();
  const TXI = await txi.getAddress();
  console.log("TXI:", TXI);

  const Faucet = await ethers.getContractFactory("DualFaucet");
  const faucet = await Faucet.deploy(TPI, TXI);
  await faucet.waitForDeployment();
  const FAUCET = await faucet.getAddress();
  console.log("FAUCET:", FAUCET);

  const AMM = await ethers.getContractFactory("SimpleAMM");
  const amm = await AMM.deploy(TPI, TXI);
  await amm.waitForDeployment();
  const AMM_TPI_TXI = await amm.getAddress();
  console.log("AMM_TPI_TXI:", AMM_TPI_TXI);

  console.log("\n=== COPY THESE ADDRESSES INTO seed-liquidity.cjs ===");
  console.log({ TPI, TXI, FAUCET, AMM_TPI_TXI });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});