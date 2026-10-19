// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {RaceBook, IAggregatorV3} from "../../src/RaceBook.sol";
import {SettleProbe} from "./SettleProbe.sol";

/// @notice Settles a past window against the 13 real Chainlink feeds on Robinhood Chain mainnet (4663).
/// @dev publicnode is not an archive node and drops a block's state after ~10 s, which is shorter than a local
///      forge fork needs for 13 feeds. So the test:
///        1. walks getRoundData over JSON-RPC at "latest" (vm.rpc) to find each feed's latest round at lock and
///           at score time, exactly like script/find-rounds.mjs and the server do;
///        2. runs deploy + openRound + settle on mainnet state inside ONE `eth_call` (SettleProbe init code,
///           nothing is broadcast), and decodes the stored result;
///        3. checks it against the answers read over RPC and the contract's own math.
///      Env: FORK_RPC (default publicnode), FORK_LOCK_AGO (default 6 h), FORK_SCORE_AGO (default 1 h).
///      Skips when the RPC is unreachable or the network fails mid-test; FORK_STRICT=1 fails instead.
contract RaceBookForkTest is Test {
    string constant FEEDS = "feeds.json";

    bool online;
    bool strict;
    string rpc;
    address[13] feedList;
    uint64 lock;
    uint64 score;

    function setUp() public {
        strict = vm.envOr("FORK_STRICT", false);
        rpc = vm.envOr("FORK_RPC", string("https://robinhood-rpc.publicnode.com"));
        try vm.rpc(rpc, "eth_chainId", "[]") returns (bytes memory cid) {
            online = cid.length > 0 && cid.length <= 32 && uint256(bytes32(cid) >> (256 - 8 * cid.length)) == 4663;
            if (!online) console.log("FORK_RPC is not chain 4663, skipping");
        } catch {
            console.log("fork RPC unreachable, skipping:", rpc);
        }
        string memory j = vm.readFile(FEEDS);
        for (uint256 i; i < 6; ++i) {
            feedList[i] = vm.parseJsonAddress(j, string.concat(".red[", vm.toString(i), "].proxy"));
            feedList[6 + i] = vm.parseJsonAddress(j, string.concat(".blue[", vm.toString(i), "].proxy"));
        }
        feedList[12] = vm.parseJsonAddress(j, ".ref.proxy");
    }

    function test_Fork_settlePastWindowWithRealRounds() public {
        vm.skip(!online);
        if (strict) {
            this.runSettle();
            return;
        }
        try this.runSettle() {}
        catch (bytes memory err) {
            // assertion failures and contract reverts are real failures; only network trouble is skipped
            if (err.length >= 4 && bytes4(err) == bytes4(keccak256("Error(string)"))) {
                string memory m = abi.decode(_tail(err), (string));
                console.log("fork run failed:", m);
                if (
                    !_contains(m, "revert") && !_contains(m, "assertion")
                        && (_contains(m, "rpc") || _contains(m, "request") || _contains(m, "timed out")
                            || _contains(m, "connect") || _contains(m, "429"))
                ) {
                    vm.skip(true);
                    return;
                }
            }
            assembly {
                revert(add(err, 32), mload(err))
            }
        }
    }

    function runSettle() external {
        uint256 nowTs = vm.unixTime() / 1000;
        lock = uint64(nowTs - vm.envOr("FORK_LOCK_AGO", uint256(6 hours)));
        score = uint64(nowTs - vm.envOr("FORK_SCORE_AGO", uint256(1 hours)));
        (uint80[] memory s, uint80[] memory e, int256[13] memory sa, int256[13] memory ea) = _find();
        RaceBook.ResultView memory r = _probe(s, e);
        _check(r, s, e, sa, ea);
    }

    function _probe(uint80[] memory s, uint80[] memory e) private returns (RaceBook.ResultView memory r) {
        address[] memory red = new address[](6);
        address[] memory blue = new address[](6);
        for (uint256 i; i < 6; ++i) {
            red[i] = feedList[i];
            blue[i] = feedList[6 + i];
        }
        bytes memory init = abi.encodePacked(
            type(SettleProbe).creationCode, abi.encode(vm.getCode("RaceBook.sol:RaceBook"), red, blue, feedList[12], lock, score, s, e)
        );
        bytes memory out =
            vm.rpc(rpc, "eth_call", string.concat('[{"data":"', vm.toString(init), '","gas":"0x2faf080"},"latest"]'));
        uint256 gasSettle;
        bool wrongRejected;
        bool lateRejected;
        uint256 blockTs;
        uint256 chainId;
        (r, gasSettle, wrongRejected, lateRejected, blockTs, chainId) =
            abi.decode(out, (RaceBook.ResultView, uint256, bool, bool, uint256, uint256));
        assertEq(chainId, 4663, "not Robinhood Chain mainnet");
        assertTrue(wrongRejected, "a too-old start round was accepted");
        assertTrue(lateRejected, "an end round after T was accepted");
        console.log("block.timestamp of the eth_call:", blockTs);
        console.log("gas settle (13 feeds, first settle, mainnet state):", gasSettle);
    }

    function _find()
        private
        returns (uint80[] memory s, uint80[] memory e, int256[13] memory sa, int256[13] memory ea)
    {
        s = new uint80[](13);
        e = new uint80[](13);
        for (uint256 k; k < 13; ++k) {
            s[k] = _findRpc(feedList[k], lock);
            e[k] = _findRpc(feedList[k], score);
            (, sa[k],) = _rpcRound(feedList[k], s[k]);
            (, ea[k],) = _rpcRound(feedList[k], e[k]);
        }
    }

    function _check(
        RaceBook.ResultView memory r,
        uint80[] memory s,
        uint80[] memory e,
        int256[13] memory sa,
        int256[13] memory ea
    ) private {
        assertTrue(r.settled);
        assertEq(r.scoreTime, score);
        // the contract's math, run locally on the answers read over RPC
        address[] memory six = new address[](6);
        for (uint256 i; i < 6; ++i) {
            six[i] = address(1);
        }
        RaceBook local = new RaceBook(address(this), address(this), six, six, address(1));
        (int64 red, int64 blue, int64 ref, int64 spread) = local.computeBasketBps(sa, ea);
        assertEq(r.redBp, red);
        assertEq(r.blueBp, blue);
        assertEq(r.refBp, ref);
        assertEq(r.spreadBp, spread);
        assertEq(r.spreadBp, r.redBp - r.blueBp);
        for (uint256 k; k < 13; ++k) {
            assertEq(r.start[k].roundId, s[k]);
            assertEq(r.end[k].roundId, e[k]);
            assertEq(int256(r.start[k].answer), sa[k]);
            assertEq(int256(r.end[k].answer), ea[k]);
            assertLe(r.start[k].updatedAt, lock);
            assertLe(r.end[k].updatedAt, score);
        }
        console.log("lock / score:", lock, score);
        console.log("redBp, blueBp, refBp, spreadBp:");
        console.logInt(r.redBp);
        console.logInt(r.blueBp);
        console.logInt(r.refBp);
        console.logInt(r.spreadBp);
    }

    // ---------------------------------------------------------------- RPC round walk (twin of find-rounds.mjs)

    function _rpcCall(address to, bytes memory data) private returns (bytes memory) {
        string memory params =
            string.concat('[{"to":"', vm.toString(to), '","data":"', vm.toString(data), '"},"latest"]');
        return vm.rpc(rpc, "eth_call", params);
    }

    function _rpcRound(address feed, uint80 id) private returns (uint80 rid, int256 answer, uint256 updatedAt) {
        bytes memory raw = _rpcCall(feed, abi.encodeCall(IAggregatorV3.getRoundData, (id)));
        (rid, answer,, updatedAt,) = abi.decode(raw, (uint80, int256, uint256, uint256, uint80));
        if (rid != id) updatedAt = 0;
    }

    function _okAt(address feed, uint80 id, uint256 t) private returns (bool) {
        (,, uint256 u) = _rpcRound(feed, id);
        return u != 0 && u <= t;
    }

    function _findRpc(address feed, uint256 t) private returns (uint80) {
        bytes memory raw = _rpcCall(feed, abi.encodeWithSignature("latestRoundData()"));
        (uint80 latest,,, uint256 lu,) = abi.decode(raw, (uint80, int256, uint256, uint256, uint80));
        if (lu <= t) return latest;
        uint80 phaseBase = (latest >> 64) << 64;
        uint80 hi = latest;
        uint80 lo;
        uint80 step = 1;
        while (true) {
            if (hi - phaseBase <= step) {
                require(_okAt(feed, phaseBase + 1, t), "no round <= t in current phase");
                lo = phaseBase + 1;
                break;
            }
            if (_okAt(feed, hi - step, t)) {
                lo = hi - step;
                break;
            }
            hi -= step;
            step *= 2;
        }
        while (hi - lo > 1) {
            uint80 mid = lo + (hi - lo) / 2;
            if (_okAt(feed, mid, t)) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function _tail(bytes memory err) private pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = err[i + 4];
        }
    }

    function _contains(string memory a, string memory b) private pure returns (bool) {
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
}
