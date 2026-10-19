// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {RaceBook} from "../src/RaceBook.sol";
import {MockFeed} from "./utils/MockFeed.sol";
import {StandardTree} from "./utils/StandardTree.sol";

contract RaceBookTest is Test {
    RaceBook rb;
    MockFeed[13] f;

    address owner = makeAddr("owner");
    address poster = makeAddr("poster");
    address alice = makeAddr("alice");

    bytes32 constant ID = bytes32("D-2026-10-20");
    uint64 constant LOCK = 1_800_000_000;
    uint64 constant PICKS = LOCK - 120;
    uint64 constant S0 = LOCK + 23_400; // +6.5 h
    uint64 constant S1 = LOCK + 2 days;
    uint256 constant DELAY = 10 minutes;

    // start / end answers (8 decimals): red mean 91.67 bp -> 91, blue mean -50 bp, ref +100 bp, spread 141
    int256[13] startPx = [
        int256(100e8), 100e8, 100e8, 100e8, 100e8, 100e8, 200e8, 200e8, 200e8, 200e8, 200e8, 200e8, 500e8
    ];
    int256[13] endPx = [
        int256(101e8), 102e8, 99e8, 100e8, 100.5e8, 103e8, 198e8, 200e8, 201e8, 196e8, 200e8, 199e8, 505e8
    ];
    int256[13] end1Px = [
        int256(90e8), 90e8, 90e8, 90e8, 90e8, 90e8, 210e8, 210e8, 210e8, 210e8, 210e8, 210e8, 495e8
    ];

    uint80[] startIds;
    uint80[] afterLockIds;
    uint80[] endIds;
    uint80[] afterEndIds;
    uint80[] end1Ids;

    event Anchored(bytes32 indexed id, uint32 indexed n, bytes32 root, uint32 count, string uri);
    event Settled(
        bytes32 indexed id,
        uint8 indexed scoreIndex,
        int64 redBp,
        int64 blueBp,
        int64 refBp,
        int64 spreadBp,
        address caller
    );
    event RoundOpened(bytes32 indexed id, uint64 picksClose, uint64 lockTime, uint64[] scoreTimes);
    event Snapshot(uint32 indexed n, bytes32 indexed hash, uint64 ts, string uri);
    event PosterChanged(address indexed previousPoster, address indexed newPoster);

    function setUp() public {
        vm.warp(LOCK - 2 days);
        address[] memory red = new address[](6);
        address[] memory blue = new address[](6);
        for (uint256 k; k < 13; ++k) {
            f[k] = new MockFeed();
            // a few old rounds, then the start round (latest <= LOCK), one after lock, the end round for S0,
            // one after S0, and the end round for S1
            f[k].push(startPx[k] - 1e8, LOCK - 3 days);
            f[k].push(startPx[k] + 1e8, LOCK - 1 days);
            startIds.push(f[k].push(startPx[k], LOCK - 600 - k));
            afterLockIds.push(f[k].push(startPx[k] + 2e8, LOCK + 60));
            endIds.push(f[k].push(endPx[k], S0 - 30));
            afterEndIds.push(f[k].push(endPx[k] + 1e8, S0 + 5));
            end1Ids.push(f[k].push(end1Px[k], S1 - 1 hours));
            if (k < 6) red[k] = address(f[k]);
            else if (k < 12) blue[k - 6] = address(f[k]);
        }
        rb = new RaceBook(owner, poster, red, blue, address(f[12]));
    }

    // ------------------------------------------------------------ helpers

    function _scores2() internal pure returns (uint64[] memory s) {
        s = new uint64[](2);
        s[0] = S0;
        s[1] = S1;
    }

    function _open() internal {
        vm.prank(poster);
        rb.openRound(ID, PICKS, LOCK, _scores2());
    }

    function _copy(uint80[] storage a) internal view returns (uint80[] memory b) {
        b = new uint80[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }

    function _settle0() internal {
        vm.warp(S0 + DELAY);
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
    }

    // ------------------------------------------------------------ constructor / owner

    function test_constructor_setsRolesAndFeeds() public view {
        assertEq(rb.owner(), owner);
        assertEq(rb.poster(), poster);
        (address[] memory red, address[] memory blue, address ref) = rb.feeds();
        assertEq(red.length, 6);
        assertEq(blue.length, 6);
        for (uint256 i; i < 6; ++i) {
            assertEq(red[i], address(f[i]));
            assertEq(blue[i], address(f[6 + i]));
        }
        assertEq(ref, address(f[12]));
    }

    function test_constructor_rejectsBadArgs() public {
        address[] memory six = new address[](6);
        for (uint256 i; i < 6; ++i) {
            six[i] = address(f[i]);
        }
        address[] memory five = new address[](5);
        for (uint256 i; i < 5; ++i) {
            five[i] = address(f[i]);
        }
        address[] memory withZero = new address[](6);
        for (uint256 i; i < 5; ++i) {
            withZero[i] = address(f[i]);
        }

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new RaceBook(address(0), poster, six, six, address(f[12]));
        vm.expectRevert(RaceBook.ZeroAddress.selector);
        new RaceBook(owner, address(0), six, six, address(f[12]));
        vm.expectRevert(RaceBook.ZeroAddress.selector);
        new RaceBook(owner, poster, six, six, address(0));
        vm.expectRevert(RaceBook.ZeroAddress.selector);
        new RaceBook(owner, poster, six, withZero, address(f[12]));
        vm.expectRevert(RaceBook.ZeroAddress.selector);
        new RaceBook(owner, poster, withZero, six, address(f[12]));
        vm.expectRevert(RaceBook.BadFeedCount.selector);
        new RaceBook(owner, poster, five, six, address(f[12]));
        vm.expectRevert(RaceBook.BadFeedCount.selector);
        new RaceBook(owner, poster, six, five, address(f[12]));
    }

    function test_setPoster() public {
        address p2 = makeAddr("p2");
        vm.expectEmit(true, true, false, false, address(rb));
        emit PosterChanged(poster, p2);
        vm.prank(owner);
        rb.setPoster(p2);
        assertEq(rb.poster(), p2);

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.NotPoster.selector, poster));
        rb.openRound(ID, PICKS, LOCK, _scores2());
        vm.prank(p2);
        rb.openRound(ID, PICKS, LOCK, _scores2());
    }

    function test_setPoster_onlyOwnerNonZero() public {
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, poster));
        rb.setPoster(alice);
        vm.prank(owner);
        vm.expectRevert(RaceBook.ZeroAddress.selector);
        rb.setPoster(address(0));
    }

    function test_renounceDisabled_twoStepTransfer() public {
        vm.prank(owner);
        vm.expectRevert(RaceBook.RenounceDisabled.selector);
        rb.renounceOwnership();

        vm.prank(owner);
        rb.transferOwnership(alice);
        assertEq(rb.owner(), owner);
        assertEq(rb.pendingOwner(), alice);
        vm.prank(alice);
        rb.acceptOwnership();
        assertEq(rb.owner(), alice);
    }

    // ------------------------------------------------------------ openRound

    function test_openRound_storesAndEmits() public {
        vm.expectEmit(true, false, false, true, address(rb));
        emit RoundOpened(ID, PICKS, LOCK, _scores2());
        _open();
        RaceBook.RoundView memory v = rb.round(ID);
        assertTrue(v.exists);
        assertEq(v.picksClose, PICKS);
        assertEq(v.lockTime, LOCK);
        assertEq(v.openedAt, block.timestamp);
        assertEq(v.scoreTimes.length, 2);
        assertEq(v.scoreTimes[0], S0);
        assertEq(v.scoreTimes[1], S1);
        assertEq(v.anchorCount, 0);
        assertEq(v.root, bytes32(0));
        assertFalse(v.startSet);
        assertEq(v.settled.length, 2);
        assertEq(rb.roundCount(), 1);
        assertEq(rb.roundIdAt(0), ID);
        assertFalse(rb.round(bytes32("nope")).exists);
    }

    function test_openRound_oneScoreTime() public {
        uint64[] memory s = new uint64[](1);
        s[0] = S0;
        vm.prank(poster);
        rb.openRound(ID, PICKS, LOCK, s);
        assertEq(rb.round(ID).scoreTimes.length, 1);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.BadScoreIndex.selector, 1));
        rb.result(ID, 1);
    }

    function test_openRound_nonPoster() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.NotPoster.selector, owner));
        rb.openRound(ID, PICKS, LOCK, _scores2());
    }

    function test_openRound_duplicateAndZeroId() public {
        _open();
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundExists.selector, ID));
        rb.openRound(ID, PICKS, LOCK, _scores2());
        vm.prank(poster);
        vm.expectRevert(RaceBook.ZeroId.selector);
        rb.openRound(bytes32(0), PICKS, LOCK, _scores2());
    }

    function test_openRound_badTimes() public {
        uint64[] memory none = new uint64[](0);
        uint64[] memory three = new uint64[](3);
        three[0] = S0;
        three[1] = S0 + 1;
        three[2] = S0 + 2;
        uint64[] memory atLock = new uint64[](1);
        atLock[0] = LOCK;
        uint64[] memory desc = new uint64[](2);
        desc[0] = S1;
        desc[1] = S0;
        uint64[] memory equal = new uint64[](2);
        equal[0] = S0;
        equal[1] = S0;

        vm.startPrank(poster);
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, PICKS, LOCK, none);
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, PICKS, LOCK, three);
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, PICKS, LOCK, atLock);
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, PICKS, LOCK, desc);
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, PICKS, LOCK, equal);
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, LOCK, LOCK, _scores2());
        vm.expectRevert(RaceBook.BadTimes.selector);
        rb.openRound(ID, LOCK + 1, LOCK, _scores2());
        vm.stopPrank();
    }

    // ------------------------------------------------------------ anchor

    function test_anchor_storesEmitsAndGrows() public {
        _open();
        vm.expectEmit(true, true, false, true, address(rb));
        emit Anchored(ID, 1, bytes32(uint256(1)), 5, "https://tapeward.live/api/round/D-2026-10-20/picks");
        vm.prank(poster);
        rb.anchor(ID, bytes32(uint256(1)), 5, "https://tapeward.live/api/round/D-2026-10-20/picks");

        vm.warp(block.timestamp + 1 hours);
        vm.prank(poster);
        rb.anchor(ID, bytes32(uint256(2)), 5, "u"); // equal count is fine (a pick was replaced)
        vm.prank(poster);
        rb.anchor(ID, bytes32(uint256(3)), 9, "u");

        RaceBook.RoundView memory v = rb.round(ID);
        assertEq(v.anchorCount, 3);
        assertEq(v.root, bytes32(uint256(3)));
        assertEq(v.count, 9);
        assertEq(v.lastAnchorAt, block.timestamp);
        RaceBook.Anchor memory a1 = rb.anchorAt(ID, 1);
        assertEq(a1.root, bytes32(uint256(1)));
        assertEq(a1.count, 5);
        assertEq(a1.at, LOCK - 2 days);
        assertEq(rb.anchorAt(ID, 4).root, bytes32(0));
    }

    function test_anchor_atLockOkAfterLockReverts() public {
        _open();
        vm.warp(LOCK);
        vm.prank(poster);
        rb.anchor(ID, bytes32(uint256(1)), 1, "u");
        vm.warp(LOCK + 1);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.AnchorAfterLock.selector, LOCK, LOCK + 1));
        rb.anchor(ID, bytes32(uint256(2)), 2, "u");
    }

    function test_anchor_countDecreaseReverts() public {
        _open();
        vm.startPrank(poster);
        rb.anchor(ID, bytes32(uint256(1)), 10, "u");
        vm.expectRevert(abi.encodeWithSelector(RaceBook.CountDecreased.selector, 9, 10));
        rb.anchor(ID, bytes32(uint256(2)), 9, "u");
        vm.stopPrank();
    }

    function test_anchor_guards() public {
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.UnknownRound.selector, ID));
        rb.anchor(ID, bytes32(uint256(1)), 1, "u");
        _open();
        vm.prank(poster);
        vm.expectRevert(RaceBook.ZeroRoot.selector);
        rb.anchor(ID, bytes32(0), 1, "u");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.NotPoster.selector, alice));
        rb.anchor(ID, bytes32(uint256(1)), 1, "u");
    }

    function testFuzz_anchor_nonPoster(address who) public {
        vm.assume(who != poster);
        _open();
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.NotPoster.selector, who));
        rb.anchor(ID, bytes32(uint256(1)), 1, "u");
    }

    // ------------------------------------------------------------ merkle / EIP-712

    function test_verify_picksTree() public {
        _open();
        uint256 n = 7;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = rb.leafHash(
                ID,
                address(uint160(0x1000 + i)),
                uint8(i % 3),
                uint8(i % 2),
                int32(int256(i * 37)) - 100,
                uint64(LOCK - 1000 + i)
            );
        }
        (bytes32[] memory tree, uint256[] memory idx) = StandardTree.build(leaves);
        vm.prank(poster);
        rb.anchor(ID, tree[0], uint32(n), "u");
        for (uint256 i; i < n; ++i) {
            bytes32[] memory p = StandardTree.proof(tree, idx[i]);
            assertTrue(rb.verify(ID, 1, leaves[i], p));
            assertFalse(rb.verify(ID, 2, leaves[i], p)); // no such anchor
            assertFalse(rb.verify(ID, 1, keccak256(abi.encode(leaves[i])), p));
        }
        bytes32 single = keccak256(abi.encode(ID, address(0x1000), uint8(0), uint8(0), int32(-100), uint64(LOCK - 1000)));
        assertFalse(rb.verify(ID, 1, single, StandardTree.proof(tree, idx[0])));
    }

    /// Known answers from typed-data.json "example".
    function test_typedDataExample() public view {
        bytes32 id = 0x442d323032362d31302d32300000000000000000000000000000000000000000;
        assertEq(id, bytes32("D-2026-10-20"));
        address picker = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        assertEq(
            rb.leafHash(id, picker, 0, 0, 120, 1792502880),
            0x49926d21c3752402d80f8845069e41ec2cdd239707ee0de22a86a79d2fcee325
        );
        bytes32 digest = rb.pickDigest(id, 0, 120, 0, 1792502880);
        assertEq(digest, 0x483b7c4200f2a5c70b51a8fad54171e3bd6781a1e338be09530d0f6a70f9936a);
        bytes memory sig =
            hex"e3e9caa934c8ae5ba3dfb9189bff594dc21966d5f65e4b7209fc35a3c787185018ec9072252cd95d82c615529c22a845f57517dbefc1eef5f597d476301d1ce21c";
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        assertEq(ecrecover(digest, v, r, s), picker);
        assertEq(rb.PICK_TYPEHASH(), 0xf3c5af7de644c729f50768352cffd36464af7a49980efda107d3767588c13da3);
    }

    function test_pickDigest_matchesVmSignature() public {
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        bytes32 digest = rb.pickDigest(ID, 1, -250, 2, 1_790_000_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(ecrecover(digest, v, r, s), signer);
        assertTrue(digest != rb.pickDigest(ID, 1, -250, 1, 1_790_000_000));
    }

    // ------------------------------------------------------------ snapshot

    function test_postSnapshot() public {
        bytes32 h = keccak256("snap");
        vm.expectEmit(true, true, false, true, address(rb));
        emit Snapshot(1, h, uint64(block.timestamp - 30), "https://tapeward.live/api/snapshot/x");
        vm.prank(poster);
        rb.postSnapshot(h, uint64(block.timestamp - 30), "https://tapeward.live/api/snapshot/x");
        assertEq(rb.snapshotCount(), 1);
        RaceBook.SnapshotData memory s = rb.snapshotAt(1);
        assertEq(s.hash, h);
        assertEq(s.ts, block.timestamp - 30);
        assertEq(s.postedAt, block.timestamp);
    }

    function test_postSnapshot_guards() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.NotPoster.selector, alice));
        rb.postSnapshot(keccak256("x"), 1, "u");
        vm.prank(poster);
        vm.expectRevert(RaceBook.ZeroRoot.selector);
        rb.postSnapshot(bytes32(0), 1, "u");
        uint64 future = uint64(block.timestamp + 1);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.FutureSnapshot.selector, future));
        rb.postSnapshot(keccak256("x"), future, "u");
    }

    // ------------------------------------------------------------ settle: happy path

    function test_settle_storesResultAndEmits() public {
        _open();
        vm.warp(S0 + DELAY);
        vm.expectEmit(true, true, false, true, address(rb));
        emit Settled(ID, 0, 91, -50, 100, 141, alice);
        vm.prank(alice); // anyone
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));

        RaceBook.ResultView memory r = rb.result(ID, 0);
        assertTrue(r.settled);
        assertEq(r.scoreTime, S0);
        assertEq(r.settledAt, S0 + DELAY);
        assertEq(r.redBp, 91);
        assertEq(r.blueBp, -50);
        assertEq(r.refBp, 100);
        assertEq(r.spreadBp, 141);
        for (uint256 k; k < 13; ++k) {
            assertEq(r.start[k].roundId, startIds[k]);
            assertEq(r.start[k].answer, startPx[k]);
            assertEq(r.start[k].updatedAt, LOCK - 600 - k);
            assertEq(r.end[k].roundId, endIds[k]);
            assertEq(r.end[k].answer, endPx[k]);
            assertEq(r.end[k].updatedAt, S0 - 30);
        }
        RaceBook.RoundView memory v = rb.round(ID);
        assertTrue(v.startSet);
        assertTrue(v.settled[0]);
        assertFalse(v.settled[1]);
        assertFalse(rb.result(ID, 1).settled);
        assertEq(rb.result(ID, 1).start[0].roundId, startIds[0]);
    }

    function test_settle_secondScoreUsesStoredStart() public {
        _open();
        _settle0();
        vm.warp(S1 + DELAY);
        // empty start array
        rb.settle(ID, 1, new uint80[](0), _copy(end1Ids));
        RaceBook.ResultView memory r = rb.result(ID, 1);
        // red: -10 % each -> -1000; blue: +5 % -> 500; ref: -1 % -> -100
        assertEq(r.redBp, -1000);
        assertEq(r.blueBp, 500);
        assertEq(r.refBp, -100);
        assertEq(r.spreadBp, -1500);
        assertEq(r.start[3].roundId, startIds[3]);
    }

    function test_settle_secondScoreWithSameStartOk_mismatchReverts() public {
        _open();
        _settle0();
        vm.warp(S1 + DELAY);
        uint80[] memory bad = _copy(startIds);
        bad[4] = afterLockIds[4];
        vm.expectRevert(
            abi.encodeWithSelector(RaceBook.StartRoundsMismatch.selector, 4, afterLockIds[4], startIds[4])
        );
        rb.settle(ID, 1, bad, _copy(end1Ids));
        uint80[] memory short = new uint80[](3);
        vm.expectRevert(RaceBook.BadRoundsLength.selector);
        rb.settle(ID, 1, short, _copy(end1Ids));
        rb.settle(ID, 1, _copy(startIds), _copy(end1Ids));
        assertTrue(rb.result(ID, 1).settled);
    }

    function test_settle_secondIndexFirst_setsStart() public {
        _open();
        vm.warp(S1 + DELAY);
        rb.settle(ID, 1, _copy(startIds), _copy(end1Ids));
        assertTrue(rb.round(ID).startSet);
        // index 0 can still be settled later with its own end rounds
        rb.settle(ID, 0, new uint80[](0), _copy(endIds));
        assertEq(rb.result(ID, 0).spreadBp, 141);
    }

    function test_settle_endEqualsStart_zeroReturn() public {
        // a feed that did not update between lock and score: end round == start round
        _open();
        f[0].set(endIds[0], 0, 0);
        f[0].set(afterLockIds[0], 0, 0);
        f[0].set(afterEndIds[0], 0, 0);
        f[0].set(end1Ids[0], 0, 0);
        uint80[] memory ends = _copy(endIds);
        ends[0] = startIds[0];
        vm.warp(S0 + DELAY);
        rb.settle(ID, 0, _copy(startIds), ends);
        // red: (0 + 200 - 100 + 0 + 50 + 300) / 6 = 75
        assertEq(rb.result(ID, 0).redBp, 75);
    }

    // ------------------------------------------------------------ settle: timing / indexes

    function test_settle_tooEarly() public {
        _open();
        vm.warp(S0 + DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.TooEarly.selector, S0 + DELAY, S0 + DELAY - 1));
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
        vm.warp(S0 + DELAY);
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
    }

    function test_settle_twiceReverts() public {
        _open();
        _settle0();
        vm.expectRevert(abi.encodeWithSelector(RaceBook.AlreadySettled.selector, ID, 0));
        rb.settle(ID, 0, new uint80[](0), _copy(endIds));
    }

    function test_settle_badIndexUnknownRoundBadLengths() public {
        vm.warp(S1 + DELAY);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.UnknownRound.selector, ID));
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
        uint64[] memory one = new uint64[](1);
        one[0] = S0;
        vm.prank(poster);
        rb.openRound(ID, PICKS, LOCK, one);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.BadScoreIndex.selector, 1));
        rb.settle(ID, 1, _copy(startIds), _copy(endIds));
        vm.expectRevert(RaceBook.BadRoundsLength.selector);
        rb.settle(ID, 0, _copy(startIds), new uint80[](12));
        vm.expectRevert(RaceBook.BadRoundsLength.selector);
        rb.settle(ID, 0, new uint80[](0), _copy(endIds));
    }

    // ------------------------------------------------------------ settle: wrong round ids

    function test_settle_startRoundAfterLock() public {
        _open();
        vm.warp(S0 + DELAY);
        uint80[] memory s = _copy(startIds);
        s[2] = afterLockIds[2];
        vm.expectRevert(
            abi.encodeWithSelector(RaceBook.RoundAfterT.selector, 2, afterLockIds[2], LOCK + 60, LOCK)
        );
        rb.settle(ID, 0, s, _copy(endIds));
    }

    function test_settle_startRoundNotLatest() public {
        _open();
        vm.warp(S0 + DELAY);
        uint80[] memory s = _copy(startIds);
        s[7] = startIds[7] - 1; // older round; the next one (real start) is also <= lock
        vm.expectRevert(
            abi.encodeWithSelector(RaceBook.RoundNotLatest.selector, 7, s[7], LOCK - 600 - 7, LOCK)
        );
        rb.settle(ID, 0, s, _copy(endIds));
    }

    function test_settle_endRoundNotLatest() public {
        _open();
        vm.warp(S0 + DELAY);
        uint80[] memory e = _copy(endIds);
        e[12] = afterLockIds[12];
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundNotLatest.selector, 12, e[12], S0 - 30, S0));
        rb.settle(ID, 0, _copy(startIds), e);
    }

    function test_settle_endRoundAfterT() public {
        _open();
        vm.warp(S0 + DELAY);
        uint80[] memory e = _copy(endIds);
        e[0] = afterEndIds[0];
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundAfterT.selector, 0, e[0], S0 + 5, S0));
        rb.settle(ID, 0, _copy(startIds), e);
    }

    function test_settle_missingRound() public {
        _open();
        vm.warp(S0 + DELAY);
        uint80[] memory e = _copy(endIds);
        e[5] = end1Ids[5] + 100; // does not exist
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundMissing.selector, 5, e[5]));
        rb.settle(ID, 0, _copy(startIds), e);
        e[5] = 0;
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundMissing.selector, 5, 0));
        rb.settle(ID, 0, _copy(startIds), e);
    }

    function test_settle_missingRoundRevertingFeed() public {
        _open();
        f[5].setRevertMissing(true);
        vm.warp(S0 + DELAY);
        uint80[] memory e = _copy(endIds);
        e[5] = end1Ids[5] + 100;
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundMissing.selector, 5, e[5]));
        rb.settle(ID, 0, _copy(startIds), e);
    }

    function test_settle_wrongReturnedIdRejected() public {
        _open();
        f[9].setWrongId(true);
        vm.warp(S0 + DELAY);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundMissing.selector, 9, startIds[9]));
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
    }

    function test_settle_nonPositiveAnswer() public {
        _open();
        f[3].set(endIds[3], 0, S0 - 30);
        vm.warp(S0 + DELAY);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundMissing.selector, 3, endIds[3]));
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
        f[3].set(endIds[3], -5, S0 - 30);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundMissing.selector, 3, endIds[3]));
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
    }

    function test_settle_stale() public {
        _open();
        // feed 6 has no update for more than 4 days before S0: rounds after its start are removed
        f[6].set(afterLockIds[6], 0, 0);
        f[6].set(endIds[6], 0, 0);
        f[6].set(afterEndIds[6], 0, 0);
        f[6].set(end1Ids[6], 0, 0);
        uint64[] memory one = new uint64[](1);
        one[0] = LOCK + 4 days + 1;
        vm.prank(poster);
        rb.openRound(bytes32("STALE"), PICKS, LOCK, one);
        vm.warp(LOCK + 4 days + 1 + DELAY);
        uint80[] memory e = new uint80[](13);
        for (uint256 k; k < 13; ++k) {
            e[k] = end1Ids[k];
        }
        e[6] = startIds[6];
        vm.expectRevert(
            abi.encodeWithSelector(RaceBook.RoundStale.selector, 6, startIds[6], LOCK - 606, LOCK + 4 days + 1)
        );
        rb.settle(bytes32("STALE"), 0, _copy(startIds), e);
    }

    function test_settle_stalenessBoundaryExactly4Days() public {
        // start round updatedAt = LOCK - 3 days for feed 0 is accepted when it is the latest (<= 4 days old)
        f[0].set(startIds[0] - 1, 0, 0);
        f[0].set(startIds[0], 0, 0);
        uint80 old = startIds[0] - 2; // updatedAt LOCK - 3 days
        uint64 lock2 = LOCK - 3 days + 4 days; // == LOCK + 1 day: still within 4 days of `old`
        f[0].set(old, 100e8, lock2 - 4 days);
        uint64[] memory one = new uint64[](1);
        one[0] = lock2 + 1;
        // make `old` the latest round <= lock2 by moving the after-lock rounds past it
        f[0].set(old + 1, 0, 0);
        f[0].set(old + 2, 0, 0);
        uint80 nxt = old + 1;
        f[0].set(nxt, 101e8, lock2 + 1);
        vm.prank(poster);
        rb.openRound(bytes32("EDGE"), lock2 - 120, lock2, one);
        vm.warp(lock2 + 1 + DELAY);
        // just check the start check of feed 0 through a full settle: other feeds use their latest-before rounds
        uint80[] memory s = new uint80[](13);
        uint80[] memory e = new uint80[](13);
        for (uint256 k; k < 13; ++k) {
            // for lock2 (= LOCK + 1 day) and lock2 + 1, the latest round of the other feeds is afterEndIds
            s[k] = afterEndIds[k];
            e[k] = afterEndIds[k];
        }
        s[0] = old;
        e[0] = nxt;
        rb.settle(bytes32("EDGE"), 0, s, e);
        assertEq(rb.result(bytes32("EDGE"), 0).start[0].updatedAt, lock2 - 4 days);

        // one second older -> stale
        f[0].set(old, 100e8, lock2 - 4 days - 1);
        uint64[] memory one2 = new uint64[](1);
        one2[0] = lock2 + 2;
        vm.prank(poster);
        rb.openRound(bytes32("EDGE2"), lock2 - 120, lock2, one2);
        vm.warp(lock2 + 2 + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(RaceBook.RoundStale.selector, 0, old, lock2 - 4 days - 1, lock2)
        );
        rb.settle(bytes32("EDGE2"), 0, s, e);
    }

    function test_settle_nextRoundAtExactlyT_notLatest() public {
        _open();
        f[1].set(afterEndIds[1], 50e8, S0); // next round updated exactly at T: it is the latest <= T
        vm.warp(S0 + DELAY);
        vm.expectRevert(abi.encodeWithSelector(RaceBook.RoundNotLatest.selector, 1, endIds[1], S0, S0));
        rb.settle(ID, 0, _copy(startIds), _copy(endIds));
        // and the round updated exactly at T is itself accepted
        uint80[] memory e = _copy(endIds);
        e[1] = afterEndIds[1];
        rb.settle(ID, 0, _copy(startIds), e);
        assertEq(rb.result(ID, 0).end[1].updatedAt, S0);
    }

    function test_settle_nextRoundRevertingOrMissingAccepted() public {
        _open();
        vm.warp(S1 + DELAY);
        // end1Ids are the newest rounds: round + 1 is missing (zeros) on most feeds and reverts on feed 4
        f[4].setRevertMissing(true);
        rb.settle(ID, 1, _copy(startIds), _copy(end1Ids));
        assertTrue(rb.result(ID, 1).settled);
    }

    // ------------------------------------------------------------ math

    function test_computeBasketBps_truncatesTowardZero() public view {
        int256[13] memory s;
        int256[13] memory e;
        for (uint256 k; k < 13; ++k) {
            s[k] = 3e8;
            e[k] = 3e8;
        }
        // red: one feed +1/3 of a bp... use 3e8 -> 3e8 + 1 => (1 * 1e22 / 3e8) = 33333333333333 (x1e-18 bp)
        e[0] = 3e8 + 1e4; // +0.333.. bp -> mean 0.0555 -> 0
        e[6] = 3e8 - 1e6; // -33.33 bp -> mean -5.555 -> -5 (toward zero, not -6)
        e[12] = 3e8 - 1e5; // -3.333 bp -> -3
        (int64 red, int64 blue, int64 ref, int64 spread) = rb.computeBasketBps(s, e);
        assertEq(red, 0);
        assertEq(blue, -5);
        assertEq(ref, -3);
        assertEq(spread, 5);
    }

    function test_computeBasketBps_highPrecisionMean() public view {
        // per-feed truncation to whole bp first would give (0+0+0+0+0+0)=0; exact mean of 6 x 0.9 bp = 0.9 -> 0;
        // 6 x 0.99 bp + one 1.0 => mean > 1 only with high precision
        int256[13] memory s;
        int256[13] memory e;
        for (uint256 k; k < 13; ++k) {
            s[k] = 1e8;
            e[k] = 1e8;
        }
        for (uint256 k; k < 6; ++k) {
            e[k] = 1e8 + 9999 + 1; // +1.0 bp each, exactly
        }
        e[0] = 1e8 + 10_000 + 9_999; // +1.9999 bp
        (int64 red,,,) = rb.computeBasketBps(s, e);
        // sum = 5 + 1.9999 = 6.9999 -> mean 1.16665 -> 1
        assertEq(red, 1);
        e[1] = 1e8 + 10_000 + 9_999;
        e[2] = 1e8 + 10_000 + 9_999;
        e[3] = 1e8 + 10_000 + 9_999;
        e[4] = 1e8 + 10_000 + 9_999;
        e[5] = 1e8 + 10_000 + 9_999;
        (red,,,) = rb.computeBasketBps(s, e);
        assertEq(red, 1); // mean 1.9999 -> 1
    }

    /// Reference model: mean of per-feed exact returns, truncated toward zero.
    function testFuzz_computeBasketBps_matchesModel(uint64[13] memory a, uint64[13] memory b) public view {
        int256[13] memory s;
        int256[13] memory e;
        for (uint256 k; k < 13; ++k) {
            s[k] = int256(uint256(bound(a[k], 1e6, 1e14)));
            e[k] = int256(uint256(bound(b[k], 1e6, 1e14)));
        }
        (int64 red, int64 blue, int64 ref, int64 spread) = rb.computeBasketBps(s, e);
        int256 r;
        int256 bl;
        for (uint256 k; k < 6; ++k) {
            r += (e[k] - s[k]) * 1e22 / s[k];
            bl += (e[6 + k] - s[6 + k]) * 1e22 / s[6 + k];
        }
        assertEq(red, SafeCast.toInt64(r / 6 / 1e18));
        assertEq(blue, SafeCast.toInt64(bl / 6 / 1e18));
        assertEq(ref, SafeCast.toInt64((e[12] - s[12]) * 1e4 / s[12]));
        assertEq(spread, red - blue);
        // swapping baskets negates the spread
        int256[13] memory s2;
        int256[13] memory e2;
        for (uint256 k; k < 6; ++k) {
            s2[k] = s[6 + k];
            e2[k] = e[6 + k];
            s2[6 + k] = s[k];
            e2[6 + k] = e[k];
        }
        s2[12] = s[12];
        e2[12] = e[12];
        (,,, int64 spread2) = rb.computeBasketBps(s2, e2);
        assertEq(spread2, -spread);
    }
}
