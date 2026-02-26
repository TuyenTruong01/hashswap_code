// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DualFaucet {
    IERC20 public immutable tpi;
    IERC20 public immutable txi;

    address public admin;

    uint256 public constant CLAIM_AMOUNT = 100 * 1e18; // 100 tokens, decimals 18
    uint256 public constant COOLDOWN = 24 hours;

    // cooldown theo (user, token) => mỗi token claim độc lập
    mapping(address => mapping(address => uint256)) public lastClaimAt;

    modifier onlyAdmin() {
        require(msg.sender == admin, "NOT_ADMIN");
        _;
    }

    constructor(address tpi_, address txi_) {
        tpi = IERC20(tpi_);
        txi = IERC20(txi_);
        admin = msg.sender;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "ZERO_ADDRESS");
        admin = newAdmin;
    }

    function isSupported(address token) public view returns (bool) {
        return token == address(tpi) || token == address(txi);
    }

    function canClaim(address user, address token) public view returns (bool) {
        require(isSupported(token), "UNSUPPORTED_TOKEN");
        return block.timestamp >= lastClaimAt[user][token] + COOLDOWN;
    }

    function claim(address token) public {
        require(isSupported(token), "UNSUPPORTED_TOKEN");
        require(canClaim(msg.sender, token), "COOLDOWN");

        lastClaimAt[msg.sender][token] = block.timestamp;

        require(IERC20(token).transfer(msg.sender, CLAIM_AMOUNT), "TRANSFER_FAILED");
    }

    // helpers cho UI: 2 nút gọi thẳng
    function claimTPI() external { claim(address(tpi)); }
    function claimTXI() external { claim(address(txi)); }

    function rescue(address token, address to, uint256 amount) external onlyAdmin {
        require(to != address(0), "ZERO_ADDRESS");
        require(IERC20(token).transfer(to, amount), "TRANSFER_FAILED");
    }
}