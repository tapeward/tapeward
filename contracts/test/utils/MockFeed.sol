// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Chainlink proxy stand-in. Round ids carry phase 1 in the top bits like the real RC proxies
///      ((1 << 64) | n). Missing rounds return the real proxy's shape (phase base id, 0, 0, 0, phase base id),
///      or revert when `revertMissing` is set (older aggregators do that).
contract MockFeed {
    uint80 public constant PHASE_BASE = uint80(1 << 64);

    struct R {
        int256 answer;
        uint256 updatedAt;
    }

    mapping(uint80 => R) public rounds;
    uint80 public latest;
    bool public revertMissing;
    bool public wrongId;

    function setRevertMissing(bool v) external {
        revertMissing = v;
    }

    function setWrongId(bool v) external {
        wrongId = v;
    }

    /// @dev Appends round latest+1 and returns its id.
    function push(int256 answer, uint256 updatedAt) external returns (uint80 id) {
        id = latest == 0 ? PHASE_BASE + 1 : latest + 1;
        rounds[id] = R(answer, updatedAt);
        latest = id;
    }

    function set(uint80 id, int256 answer, uint256 updatedAt) external {
        rounds[id] = R(answer, updatedAt);
        if (id > latest) latest = id;
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        R memory r = rounds[id];
        if (r.updatedAt == 0) {
            if (revertMissing) revert("No data present");
            return (PHASE_BASE, 0, 0, 0, PHASE_BASE);
        }
        uint80 rid = wrongId ? id + 7 : id;
        return (rid, r.answer, r.updatedAt - 12, r.updatedAt, rid);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        R memory r = rounds[latest];
        return (latest, r.answer, r.updatedAt - 12, r.updatedAt, latest);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}
