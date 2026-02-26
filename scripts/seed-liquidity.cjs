// scripts/seed-liquidity.cjs
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const [user] = await ethers.getSigners();
  console.log("User:", user.address);

  // ====== DEPLOY ADDRESSES (IoTeX Testnet) ======
  // DÁN TỪ OUTPUT deploy.cjs vào đây:
  const TPI = "0xB21d98e7c364b7b947e9B02bB53a2d361557C1bC";
  const TXI = "0x03ee39B1e6Fb726429350199bf6056664c6cE3Ee";
  const FAUCET = "0x1C87525CDB3027A24617496EF6d7447b95cE21da";
  const AMM_TPI_TXI = "0xb06DF8063B6582918f5Bfe1dEBf6beA03F51c534";
  // =============================================

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function mint(address to, uint256 amount) external",
  ];

  const AMM_ABI = [
    "function addLiquidity(uint256 amountA, uint256 amountB) external returns (uint256 sharesMinted)",
    "function reserves() view returns (uint256 rA, uint256 rB)",
  ];

  const tpi = new ethers.Contract(TPI, ERC20_ABI, user);
  const txi = new ethers.Contract(TXI, ERC20_ABI, user);
  const amm = new ethers.Contract(AMM_TPI_TXI, AMM_ABI, user);

  const dec = await tpi.decimals(); // 18
  console.log("Decimals:", Number(dec));

  // ====== CONFIG AMOUNTS (human units) ======
  // mint vào ví dev để có token seed + fund faucet
  const MINT_TO_USER_EACH = "1000000"; // 1,000,000 token mỗi loại
  const FUND_FAUCET_EACH  = "100000";  // nạp 100,000 vào faucet mỗi loại
  const SEED_TPI  = "200000";          // seed TPI vào pool
  const SEED_TXI  = "200000";          // seed TXI vào pool
  // ========================================

  const mintUser   = ethers.parseUnits(MINT_TO_USER_EACH, dec);
  const fundFaucet = ethers.parseUnits(FUND_FAUCET_EACH,  dec);
  const seedTpi    = ethers.parseUnits(SEED_TPI,  dec);
  const seedTxi    = ethers.parseUnits(SEED_TXI,  dec);

  // 1) Mint token vào ví dev (vì dev là owner token)
  console.log("\nMinting to dev wallet...");
  await (await tpi.mint(user.address, mintUser)).wait();
  await (await txi.mint(user.address, mintUser)).wait();
  console.log("✅ Mint done");

  // 2) Fund faucet: transfer vào FAUCET (faucet transfer model)
  console.log("\nFunding faucet...");
  await (await tpi.transfer(FAUCET, fundFaucet)).wait();
  await (await txi.transfer(FAUCET, fundFaucet)).wait();
  console.log("✅ Faucet funded");

  // helper approve-if-needed
  async function approveIfNeeded(token, spender, amount, label) {
    const allow = await token.allowance(user.address, spender);
    if (allow < amount) {
      console.log(`Approving ${label} -> ${spender} ...`);
      await (await token.approve(spender, amount)).wait();
    }
  }

  // 3) Seed liquidity: TPI/TXI pool
  console.log("\nSeeding liquidity: TPI/TXI");
  await approveIfNeeded(tpi, AMM_TPI_TXI, seedTpi, "TPI");
  await approveIfNeeded(txi, AMM_TPI_TXI, seedTxi, "TXI");
  await (await amm.addLiquidity(seedTpi, seedTxi)).wait();
  console.log("✅ Seeded TPI/TXI");

  // 4) Show reserves
  const r = await amm.reserves();
  console.log("\nReserves TPI/TXI:", r);

  console.log("\nDONE ✅");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});