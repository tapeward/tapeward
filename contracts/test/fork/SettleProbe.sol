// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RaceBook} from "../../src/RaceBook.sol";

/// @dev Executed as the init code of a single `eth_call` on Robinhood Chain mainnet (nothing is deployed):
///      deploys a RaceBook against the real feeds, opens a round over a past window, checks that a wrong start
///      round is rejected, settles with the given round ids, and returns the result as ABI-encoded bytes.
///      One RPC call = one consistent block, so it works on non-archive RPCs (publicnode).
contract SettleProbe {
    bytes32 constant ID = bytes32("FORK-TEST");

    /// @param raceBookCode RaceBook creation code (without constructor args). Passed in instead of `new RaceBook`
    ///        because forge rewrites `new` in test sources into a cheatcode call that does not exist on chain.
    constructor(
        bytes memory raceBookCode,
        address[] memory red,
        address[] memory blue,
        address ref,
        uint64 lock,
        uint64 score,
        uint80[] memory s,
        uint80[] memory e
    ) {
        bytes memory init = abi.encodePacked(raceBookCode, abi.encode(address(this), address(this), red, blue, ref));
        RaceBook rb;
        assembly {
            rb := create(0, add(init, 32), mload(init))
        }
        require(address(rb) != address(0), "deploy failed");
        uint64[] memory st = new uint64[](1);
        st[0] = score;
        rb.openRound(ID, lock - 120, lock, st);

        // a start id one round too old must be rejected (only meaningful if that round exists)
        bool wrongRejected = true;
        if (s[0] > ((s[0] >> 64) << 64) + 1) {
            uint80[] memory bad = new uint80[](s.length);
            for (uint256 k; k < s.length; ++k) {
                bad[k] = s[k];
            }
            bad[0] = s[0] - 1;
            try rb.settle(ID, 0, bad, e) {
                wrongRejected = false;
            } catch {}
        }
        // an end id one round too new (after T) must be rejected when it exists
        bool lateRejected = true;
        {
            uint80[] memory late = new uint80[](e.length);
            for (uint256 k; k < e.length; ++k) {
                late[k] = e[k];
            }
            late[12] = e[12] + 1;
            try rb.settle(ID, 0, s, late) {
                lateRejected = false;
            } catch {}
        }

        uint256 g = gasleft();
        rb.settle(ID, 0, s, e);
        g -= gasleft();

        RaceBook.ResultView memory r = rb.result(ID, 0);
        bytes memory out = abi.encode(r, g, wrongRejected, lateRejected, block.timestamp, block.chainid);
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
