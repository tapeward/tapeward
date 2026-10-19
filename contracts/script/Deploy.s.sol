// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RaceBook} from "../src/RaceBook.sol";

interface IFeedMeta {
    function description() external view returns (string memory);
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Deploys RaceBook with owner, poster and the 13 feeds (from feeds.json) fixed in the constructor.
///         The deployer only pays gas and gets no rights.
/// Env:
///   OWNER       optional  owner wallet (setPoster, two-step ownership transfer); default below
///   POSTER      optional  openRound / anchor / postSnapshot (and settles); default below
///   FEEDS       optional  feeds JSON (default feeds.json)
///   FEED_CHECK_RPC optional  RPC for the feed checks (default: --rpc-url); set it to publicnode for anvil dry runs
///   DEPLOY_OUT  optional  output JSON path (default deployments/robinhood.json)
contract Deploy is Script {
    address constant DEFAULT_OWNER = 0x262336915b1D10f7b071EE555B885ae48E7E6D9a;
    address constant DEFAULT_POSTER = 0x9ed6dB374aEE462fA60432254bace118a90Fe1C9;
    address constant EXPECTED_DEPLOYER = 0xF4bEAb1FDd6829f670AcE5D94FD7C55256bD0FdA;

    function run() external returns (RaceBook rb) {
        address owner = vm.envOr("OWNER", DEFAULT_OWNER);
        address poster = vm.envOr("POSTER", DEFAULT_POSTER);
        address deployer = msg.sender;
        require(owner != address(0), "OWNER is zero");
        require(poster != address(0), "POSTER is zero");
        require(owner != deployer, "OWNER must not be the deployer");
        require(poster != deployer, "POSTER must not be the deployer");
        require(owner != poster, "OWNER and POSTER must differ");
        if (deployer != EXPECTED_DEPLOYER) console.log("warning: deployer is not the BRIEF deployer", deployer);
        if (block.chainid != 4663) console.log("warning: chain id is not 4663 (Robinhood Chain mainnet)");

        (address[] memory red, address[] memory blue, address ref) = _feeds();

        // Deploy first: publicnode keeps a block's state for only ~10 s, so the CREATE must run on the fresh
        // fork. The feed checks below go over plain JSON-RPC and still run before anything is broadcast
        // (forge simulates all of run() first; a failed check aborts the broadcast).
        vm.startBroadcast();
        rb = new RaceBook(owner, poster, red, blue, ref);
        vm.stopBroadcast();

        // block.number on Robinhood Chain (Arbitrum Orbit) is the L1 block; record the L2 head instead.
        uint256 startBlock = _l2BlockNumber();
        _checkFeeds();

        require(
            rb.owner() == owner && rb.poster() == poster && rb.pendingOwner() == address(0),
            "post-deploy check failed"
        );
        (address[] memory r2, address[] memory b2, address ref2) = rb.feeds();
        require(ref2 == ref, "feed check failed");
        for (uint256 i; i < 6; ++i) {
            require(r2[i] == red[i] && b2[i] == blue[i], "feed check failed");
        }
        console.log("RaceBook", address(rb));
        console.log("owner", owner);
        console.log("poster", poster);
        console.log("deployer", deployer);

        _write(rb, owner, poster, deployer, startBlock, red, blue, ref);
    }

    function _feedsJson() internal view returns (string memory) {
        return vm.readFile(vm.envOr("FEEDS", string("feeds.json")));
    }

    function _feeds() internal view returns (address[] memory red, address[] memory blue, address ref) {
        string memory j = _feedsJson();
        red = new address[](6);
        blue = new address[](6);
        for (uint256 i; i < 6; ++i) {
            string memory k = vm.toString(i);
            red[i] = vm.parseJsonAddress(j, string.concat(".red[", k, "].proxy"));
            blue[i] = vm.parseJsonAddress(j, string.concat(".blue[", k, "].proxy"));
        }
        ref = vm.parseJsonAddress(j, ".ref.proxy");
    }

    /// On chain 4663, checks each feed over plain JSON-RPC at "latest" (vm.rpc, not the script's fork):
    /// description() names the symbol, decimals() == 8, latest answer > 0 and updated within 4 days.
    function _checkFeeds() internal {
        if (block.chainid != 4663) {
            console.log("feed checks skipped (not chain 4663)");
            return;
        }
        string memory j = _feedsJson();
        for (uint256 i; i < 6; ++i) {
            string memory k = vm.toString(i);
            _checkFeed(
                vm.parseJsonAddress(j, string.concat(".red[", k, "].proxy")),
                vm.parseJsonString(j, string.concat(".red[", k, "].symbol"))
            );
            _checkFeed(
                vm.parseJsonAddress(j, string.concat(".blue[", k, "].proxy")),
                vm.parseJsonString(j, string.concat(".blue[", k, "].symbol"))
            );
        }
        _checkFeed(vm.parseJsonAddress(j, ".ref.proxy"), vm.parseJsonString(j, ".ref.symbol"));
    }

    function _call(address to, bytes memory data) internal returns (bytes memory) {
        string memory params =
            string.concat('[{"to":"', vm.toString(to), '","data":"', vm.toString(data), '"},"latest"]');
        string memory url = vm.envOr("FEED_CHECK_RPC", string(""));
        return bytes(url).length == 0 ? vm.rpc("eth_call", params) : vm.rpc(url, "eth_call", params);
    }

    function _checkFeed(address feed, string memory symbol) internal {
        string memory d = abi.decode(_call(feed, abi.encodeCall(IFeedMeta.description, ())), (string));
        require(_contains(d, symbol), string.concat("feed description mismatch: ", symbol, " vs ", d));
        uint8 dec = abi.decode(_call(feed, abi.encodeCall(IFeedMeta.decimals, ())), (uint8));
        require(dec == 8, string.concat("feed decimals != 8: ", symbol));
        (, int256 answer,, uint256 updatedAt,) = abi.decode(
            _call(feed, abi.encodeCall(IFeedMeta.latestRoundData, ())), (uint80, int256, uint256, uint256, uint80)
        );
        require(answer > 0 && updatedAt + 4 days >= vm.unixTime() / 1000, string.concat("feed stale: ", symbol));
        console.log("feed ok", symbol, d);
    }

    function _write(
        RaceBook rb,
        address owner,
        address poster,
        address deployer,
        uint256 startBlock,
        address[] memory red,
        address[] memory blue,
        address ref
    ) internal {
        string memory o = "deployment";
        vm.serializeAddress(o, "address", address(rb));
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", startBlock);
        vm.serializeAddress(o, "owner", owner);
        vm.serializeAddress(o, "poster", poster);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "redFeeds", red);
        vm.serializeAddress(o, "blueFeeds", blue);
        string memory json = vm.serializeAddress(o, "refFeed", ref);
        string memory out = vm.envOr("DEPLOY_OUT", string("deployments/robinhood.json"));
        vm.writeJson(json, out);
        console.log("wrote", out);
    }

    function _contains(string memory a, string memory b) internal pure returns (bool) {
        bytes memory x = bytes(a);
        bytes memory y = bytes(b);
        if (y.length > x.length) return false;
        for (uint256 i; i + y.length <= x.length; ++i) {
            bool m = true;
            for (uint256 j; j < y.length; ++j) {
                if (x[i + j] != y[j]) {
                    m = false;
                    break;
                }
            }
            if (m) return true;
        }
        return false;
    }

    function _l2BlockNumber() internal returns (uint256 n) {
        bytes memory raw = vm.rpc("eth_blockNumber", "[]");
        for (uint256 i; i < raw.length; ++i) {
            n = (n << 8) | uint8(raw[i]);
        }
    }
}
