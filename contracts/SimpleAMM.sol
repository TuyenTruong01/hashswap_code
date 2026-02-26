// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SimpleAMM {
    IERC20Like public immutable tokenA;
    IERC20Like public immutable tokenB;

    // 0.3% fee (997/1000)
    uint256 public constant FEE_NUM = 997;
    uint256 public constant FEE_DEN = 1000;

    // LP shares (internal)
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB, uint256 sharesMinted);
    event LiquidityRemoved(address indexed provider, uint256 amountA, uint256 amountB, uint256 sharesBurned);
    event Swapped(
        address indexed trader,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address a, address b) {
        require(a != address(0) && b != address(0), "ZERO_ADDRESS");
        require(a != b, "SAME_TOKEN");
        tokenA = IERC20Like(a);
        tokenB = IERC20Like(b);
    }

    function reserves() public view returns (uint256 rA, uint256 rB) {
        rA = tokenA.balanceOf(address(this));
        rB = tokenB.balanceOf(address(this));
    }

    // ---------- Math helpers ----------
    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    // Babylonian sqrt
    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y == 0) return 0;
        if (y <= 3) return 1;
        z = y;
        uint256 x = (y / 2) + 1;
        while (x < z) {
            z = x;
            x = (y / x + x) / 2;
        }
    }

    // Quote how much B is required to match amountA at current pool ratio
    function quoteB(uint256 amountA) public view returns (uint256 amountBRequired) {
        (uint256 rA, uint256 rB) = reserves();
        require(rA > 0 && rB > 0, "NO_LIQUIDITY");
        amountBRequired = (amountA * rB) / rA;
    }

    // ---------- Liquidity ----------
    function addLiquidity(uint256 amountA, uint256 amountB) external returns (uint256 sharesMinted) {
        require(amountA > 0 && amountB > 0, "BAD_AMOUNTS");

        (uint256 rA, uint256 rB) = reserves();

        if (totalShares == 0) {
            // first LP sets the initial price
            sharesMinted = _sqrt(amountA * amountB);
            require(sharesMinted > 0, "ZERO_SHARES");
        } else {
            // enforce ratio close to current reserves
            // shares minted proportional to contribution, pick min to prevent skew
            uint256 sharesA = (amountA * totalShares) / rA;
            uint256 sharesB = (amountB * totalShares) / rB;
            sharesMinted = _min(sharesA, sharesB);
            require(sharesMinted > 0, "ZERO_SHARES");
        }

        // pull tokens in
        require(tokenA.transferFrom(msg.sender, address(this), amountA), "TRANSFER_A_FAILED");
        require(tokenB.transferFrom(msg.sender, address(this), amountB), "TRANSFER_B_FAILED");

        // mint shares
        sharesOf[msg.sender] += sharesMinted;
        totalShares += sharesMinted;

        emit LiquidityAdded(msg.sender, amountA, amountB, sharesMinted);
    }

    function removeLiquidity(uint256 sharesBurned) external returns (uint256 amountA, uint256 amountB) {
        require(sharesBurned > 0, "BAD_SHARES");
        require(sharesOf[msg.sender] >= sharesBurned, "INSUFFICIENT_SHARES");

        (uint256 rA, uint256 rB) = reserves();
        require(rA > 0 && rB > 0, "NO_LIQUIDITY");
        require(totalShares > 0, "NO_SHARES");

        amountA = (rA * sharesBurned) / totalShares;
        amountB = (rB * sharesBurned) / totalShares;

        require(amountA > 0 && amountB > 0, "ZERO_OUT");

        // burn shares
        sharesOf[msg.sender] -= sharesBurned;
        totalShares -= sharesBurned;

        // transfer tokens out
        require(tokenA.transfer(msg.sender, amountA), "A_OUT_FAIL");
        require(tokenB.transfer(msg.sender, amountB), "B_OUT_FAIL");

        emit LiquidityRemoved(msg.sender, amountA, amountB, sharesBurned);
    }

    // ---------- Swap ----------
    function getAmountOut(uint256 amountIn, bool aToB) public view returns (uint256 out) {
        (uint256 rA, uint256 rB) = reserves();
        require(rA > 0 && rB > 0, "NO_LIQUIDITY");
        require(amountIn > 0, "INVALID_INPUT");

        uint256 amountInWithFee = amountIn * FEE_NUM;

        if (aToB) {
            out = (amountInWithFee * rB) / (rA * FEE_DEN + amountInWithFee);
        } else {
            out = (amountInWithFee * rA) / (rB * FEE_DEN + amountInWithFee);
        }
    }

    function swap(uint256 amountIn, uint256 minOut, bool aToB) external returns (uint256 out) {
        out = getAmountOut(amountIn, aToB);
        require(out >= minOut, "SLIPPAGE_TOO_HIGH");

        if (aToB) {
            require(tokenA.transferFrom(msg.sender, address(this), amountIn), "INPUT_FAIL");
            require(tokenB.transfer(msg.sender, out), "OUTPUT_FAIL");
            emit Swapped(msg.sender, address(tokenA), address(tokenB), amountIn, out);
        } else {
            require(tokenB.transferFrom(msg.sender, address(this), amountIn), "INPUT_FAIL");
            require(tokenA.transfer(msg.sender, out), "OUTPUT_FAIL");
            emit Swapped(msg.sender, address(tokenB), address(tokenA), amountIn, out);
        }
    }
}