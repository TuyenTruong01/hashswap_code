// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract CappedToken is ERC20 {
    uint256 public immutable cap;
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_,
        address owner_
    ) ERC20(name_, symbol_) {
        cap = cap_;
        owner = owner_;
    }

    // ❌ XÓA override decimals
    // → dùng mặc định của OpenZeppelin = 18

    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= cap, "CAP_EXCEEDED");
        _mint(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_ADDRESS");
        owner = newOwner;
    }
}