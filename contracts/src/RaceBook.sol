// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Minimal Chainlink AggregatorV3 read interface (proxy).
interface IAggregatorV3 {
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title RaceBook
/// @notice Public record of TAPEWARD rounds: two equal-weight baskets of Robinhood Chain stock-token price feeds
///         (RED vs BLUE, plus a reference feed) race from a round's lock time to its score time(s).
///         - The poster opens rounds, anchors merkle roots of free EIP-712 picks before lock, and posts hourly
///           hashes of the public reference-odds snapshot.
///         - Anyone can settle a round after a score time by naming, per feed, the Chainlink round that was the
///           latest one at that time. The contract checks those round ids with `getRoundData` and stores the
///           basket returns. Scores per wallet are computed off-chain from this data by a public script.
///         No funds, no payouts, no upgradeability. The owner can only change the poster.
contract RaceBook is Ownable2Step {
    using SafeCast for int256;
    using SafeCast for uint256;

    // ------------------------------------------------------------------ constants

    uint256 public constant BASKET_SIZE = 6;
    /// @notice Feed order everywhere (arrays of 13): red[0..5], blue[0..5], ref.
    uint256 public constant FEED_COUNT = 13;
    uint256 public constant MAX_SCORE_TIMES = 2;
    /// @notice A round used for settle must have `updatedAt >= T - MAX_STALENESS`.
    uint256 public constant MAX_STALENESS = 4 days;
    /// @notice `settle` for score time T is allowed from `T + SETTLE_DELAY`, so every round with
    ///         `updatedAt <= T` is already visible on the proxy.
    uint256 public constant SETTLE_DELAY = 10 minutes;

    bytes32 public constant PICK_TYPEHASH =
        keccak256("Pick(bytes32 round,uint8 side,int32 spreadBp,uint8 slot,uint64 signedAt)");
    /// @notice EIP-712 domain {name:"TAPEWARD", version:"1", chainId:4663}, no verifyingContract, so picks can be
    ///         signed before deploy. This contract does not check signatures; it only exposes the digest.
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    uint256 public constant PICK_CHAIN_ID = 4663;

    // ------------------------------------------------------------------ types

    struct FeedPoint {
        uint80 roundId;
        uint48 updatedAt;
        int128 answer;
    }

    struct Settlement {
        uint64 settledAt;
        int64 redBp;
        int64 blueBp;
        int64 refBp;
        int64 spreadBp;
        FeedPoint[13] end;
    }

    struct Anchor {
        bytes32 root;
        uint32 count;
        uint64 at;
    }

    struct RoundData {
        uint64 picksClose;
        uint64 lockTime;
        uint64 openedAt;
        uint8 scoreCount;
        bool startSet;
        uint32 anchorCount;
        uint64[2] scoreTimes;
        FeedPoint[13] start;
        Settlement[2] results;
    }

    /// @notice Return shape of `round(id)`.
    struct RoundView {
        bool exists;
        uint64 picksClose;
        uint64 lockTime;
        uint64 openedAt;
        uint64[] scoreTimes;
        uint32 anchorCount;
        bytes32 root;
        uint32 count;
        uint64 lastAnchorAt;
        bool startSet;
        bool[] settled;
    }

    /// @notice Return shape of `result(id, i)`.
    struct ResultView {
        bool settled;
        uint64 scoreTime;
        uint64 settledAt;
        int64 redBp;
        int64 blueBp;
        int64 refBp;
        int64 spreadBp;
        FeedPoint[13] start;
        FeedPoint[13] end;
    }

    struct SnapshotData {
        bytes32 hash;
        uint64 ts;
        uint64 postedAt;
    }

    // ------------------------------------------------------------------ storage

    address public poster;

    address[13] private _feeds;

    mapping(bytes32 id => RoundData) private _rounds;
    mapping(bytes32 id => mapping(uint32 n => Anchor)) private _anchors;
    bytes32[] private _roundIds;
    SnapshotData[] private _snapshots;

    // ------------------------------------------------------------------ events

    event PosterChanged(address indexed previousPoster, address indexed newPoster);
    event RoundOpened(bytes32 indexed id, uint64 picksClose, uint64 lockTime, uint64[] scoreTimes);
    /// @param n 1-based anchor number within the round ("root #n").
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
    event Snapshot(uint32 indexed n, bytes32 indexed hash, uint64 ts, string uri);

    // ------------------------------------------------------------------ errors

    error NotPoster(address caller);
    error ZeroAddress();
    error BadFeedCount();
    error RenounceDisabled();
    error ZeroId();
    error RoundExists(bytes32 id);
    error UnknownRound(bytes32 id);
    error BadTimes();
    error ZeroRoot();
    error AnchorAfterLock(uint64 lockTime, uint256 nowTs);
    error CountDecreased(uint32 count, uint32 previous);
    error BadScoreIndex(uint8 scoreIndex);
    error TooEarly(uint256 settleFrom, uint256 nowTs);
    error AlreadySettled(bytes32 id, uint8 scoreIndex);
    error BadRoundsLength();
    error StartRoundsMismatch(uint256 feed, uint80 given, uint80 stored);
    error RoundMissing(uint256 feed, uint80 roundId);
    error RoundAfterT(uint256 feed, uint80 roundId, uint256 updatedAt, uint256 t);
    error RoundStale(uint256 feed, uint80 roundId, uint256 updatedAt, uint256 t);
    error RoundNotLatest(uint256 feed, uint80 roundId, uint256 nextUpdatedAt, uint256 t);
    error FutureSnapshot(uint64 ts);

    // ------------------------------------------------------------------ constructor

    constructor(
        address owner_,
        address poster_,
        address[] memory redFeeds,
        address[] memory blueFeeds,
        address refFeed
    ) Ownable(owner_) {
        if (poster_ == address(0) || refFeed == address(0)) revert ZeroAddress();
        if (redFeeds.length != BASKET_SIZE || blueFeeds.length != BASKET_SIZE) revert BadFeedCount();
        for (uint256 i; i < BASKET_SIZE; ++i) {
            if (redFeeds[i] == address(0) || blueFeeds[i] == address(0)) revert ZeroAddress();
            _feeds[i] = redFeeds[i];
            _feeds[BASKET_SIZE + i] = blueFeeds[i];
        }
        _feeds[FEED_COUNT - 1] = refFeed;
        poster = poster_;
        emit PosterChanged(address(0), poster_);
    }

    modifier onlyPoster() {
        if (msg.sender != poster) revert NotPoster(msg.sender);
        _;
    }

    // ------------------------------------------------------------------ owner

    function setPoster(address newPoster) external onlyOwner {
        if (newPoster == address(0)) revert ZeroAddress();
        emit PosterChanged(poster, newPoster);
        poster = newPoster;
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ poster

    /// @notice Open a round. Times are unix seconds: picksClose < lockTime < scoreTimes[0] < scoreTimes[1].
    ///         Past times are accepted (a past round can still be settled; it just cannot be anchored).
    function openRound(bytes32 id, uint64 picksClose, uint64 lockTime, uint64[] calldata scoreTimes)
        external
        onlyPoster
    {
        if (id == bytes32(0)) revert ZeroId();
        RoundData storage r = _rounds[id];
        if (r.lockTime != 0) revert RoundExists(id);
        uint256 n = scoreTimes.length;
        if (n == 0 || n > MAX_SCORE_TIMES || picksClose >= lockTime) revert BadTimes();
        uint64 prev = lockTime;
        for (uint256 i; i < n; ++i) {
            if (scoreTimes[i] <= prev) revert BadTimes();
            prev = scoreTimes[i];
            r.scoreTimes[i] = scoreTimes[i];
        }
        r.picksClose = picksClose;
        r.lockTime = lockTime;
        r.openedAt = uint64(block.timestamp);
        r.scoreCount = uint8(n);
        _roundIds.push(id);
        emit RoundOpened(id, picksClose, lockTime, scoreTimes);
    }

    /// @notice Anchor the merkle root of the picks collected so far. Allowed until `lockTime` (inclusive).
    ///         `count` (number of leaves) never decreases. `uri` = where the leaves and proofs are published.
    function anchor(bytes32 id, bytes32 root, uint32 count, string calldata uri) external onlyPoster {
        RoundData storage r = _existing(id);
        if (block.timestamp > r.lockTime) revert AnchorAfterLock(r.lockTime, block.timestamp);
        if (root == bytes32(0)) revert ZeroRoot();
        uint32 n = r.anchorCount;
        if (n != 0) {
            uint32 previous = _anchors[id][n].count;
            if (count < previous) revert CountDecreased(count, previous);
        }
        unchecked {
            ++n;
        }
        r.anchorCount = n;
        _anchors[id][n] = Anchor({root: root, count: count, at: uint64(block.timestamp)});
        emit Anchored(id, n, root, count, uri);
    }

    /// @notice Record the hash of a public reference-odds snapshot (information only, never used for scoring).
    function postSnapshot(bytes32 hash, uint64 ts, string calldata uri) external onlyPoster {
        if (hash == bytes32(0)) revert ZeroRoot();
        if (ts > block.timestamp) revert FutureSnapshot(ts);
        _snapshots.push(SnapshotData({hash: hash, ts: ts, postedAt: uint64(block.timestamp)}));
        emit Snapshot(uint32(_snapshots.length), hash, ts, uri);
    }

    // ------------------------------------------------------------------ settle (anyone)

    /// @notice Settle score time `scoreIndex` of round `id`. Arrays are in feed order (red[6], blue[6], ref).
    ///         For each feed, the given Chainlink round must be the latest one at time T:
    ///         `updatedAt <= T`, `updatedAt >= T - 4 days`, and round `roundId + 1` is missing (reverts or has
    ///         updatedAt 0) or has `updatedAt > T`. Start rounds use T = lockTime and are stored on the first
    ///         settle of the round; later settles pass `startRounds` empty (or equal to the stored ones).
    function settle(bytes32 id, uint8 scoreIndex, uint80[] calldata startRounds, uint80[] calldata endRounds)
        external
    {
        RoundData storage r = _existing(id);
        if (scoreIndex >= r.scoreCount) revert BadScoreIndex(scoreIndex);
        uint256 t = r.scoreTimes[scoreIndex];
        if (block.timestamp < t + SETTLE_DELAY) revert TooEarly(t + SETTLE_DELAY, block.timestamp);
        Settlement storage s = r.results[scoreIndex];
        if (s.settledAt != 0) revert AlreadySettled(id, scoreIndex);
        if (endRounds.length != FEED_COUNT) revert BadRoundsLength();

        if (!r.startSet) {
            if (startRounds.length != FEED_COUNT) revert BadRoundsLength();
            uint256 lock = r.lockTime;
            for (uint256 k; k < FEED_COUNT; ++k) {
                r.start[k] = _checkedPoint(k, startRounds[k], lock);
            }
            r.startSet = true;
        } else if (startRounds.length != 0) {
            if (startRounds.length != FEED_COUNT) revert BadRoundsLength();
            for (uint256 k; k < FEED_COUNT; ++k) {
                uint80 stored = r.start[k].roundId;
                if (startRounds[k] != stored) revert StartRoundsMismatch(k, startRounds[k], stored);
            }
        }

        int256[13] memory starts;
        int256[13] memory ends;
        for (uint256 k; k < FEED_COUNT; ++k) {
            FeedPoint memory p = _checkedPoint(k, endRounds[k], t);
            s.end[k] = p;
            ends[k] = p.answer;
            starts[k] = r.start[k].answer;
        }

        (int64 redBp, int64 blueBp, int64 refBp, int64 spreadBp) = computeBasketBps(starts, ends);
        s.settledAt = uint64(block.timestamp);
        s.redBp = redBp;
        s.blueBp = blueBp;
        s.refBp = refBp;
        s.spreadBp = spreadBp;
        emit Settled(id, scoreIndex, redBp, blueBp, refBp, spreadBp, msg.sender);
    }

    /// @notice The scoring math, exposed so anyone can check it.
    ///         feedX = (end - start) * 1e22 / start  (basis points with 18 extra decimals, truncated toward zero)
    ///         basketBp = (sum of its 6 feedX / 6) / 1e18 (each division truncates toward zero)
    ///         refBp = (end - start) * 1e4 / start (truncated); spreadBp = redBp - blueBp.
    function computeBasketBps(int256[13] memory starts, int256[13] memory ends)
        public
        pure
        returns (int64 redBp, int64 blueBp, int64 refBp, int64 spreadBp)
    {
        int256 red;
        int256 blue;
        for (uint256 i; i < BASKET_SIZE; ++i) {
            red += _feedX(starts[i], ends[i]);
            blue += _feedX(starts[BASKET_SIZE + i], ends[BASKET_SIZE + i]);
        }
        int256 six = int256(BASKET_SIZE);
        redBp = (red / six / 1e18).toInt64();
        blueBp = (blue / six / 1e18).toInt64();
        refBp = (_feedX(starts[FEED_COUNT - 1], ends[FEED_COUNT - 1]) / 1e18).toInt64();
        spreadBp = (int256(redBp) - int256(blueBp)).toInt64();
    }

    // ------------------------------------------------------------------ views

    /// @notice Feeds in settle order.
    function feeds() external view returns (address[] memory red, address[] memory blue, address ref) {
        red = new address[](BASKET_SIZE);
        blue = new address[](BASKET_SIZE);
        for (uint256 i; i < BASKET_SIZE; ++i) {
            red[i] = _feeds[i];
            blue[i] = _feeds[BASKET_SIZE + i];
        }
        ref = _feeds[FEED_COUNT - 1];
    }

    function round(bytes32 id) external view returns (RoundView memory v) {
        RoundData storage r = _rounds[id];
        if (r.lockTime == 0) return v;
        v.exists = true;
        v.picksClose = r.picksClose;
        v.lockTime = r.lockTime;
        v.openedAt = r.openedAt;
        uint256 n = r.scoreCount;
        v.scoreTimes = new uint64[](n);
        v.settled = new bool[](n);
        for (uint256 i; i < n; ++i) {
            v.scoreTimes[i] = r.scoreTimes[i];
            v.settled[i] = r.results[i].settledAt != 0;
        }
        v.anchorCount = r.anchorCount;
        if (r.anchorCount != 0) {
            Anchor storage a = _anchors[id][r.anchorCount];
            v.root = a.root;
            v.count = a.count;
            v.lastAnchorAt = a.at;
        }
        v.startSet = r.startSet;
    }

    function result(bytes32 id, uint8 scoreIndex) external view returns (ResultView memory v) {
        RoundData storage r = _existing(id);
        if (scoreIndex >= r.scoreCount) revert BadScoreIndex(scoreIndex);
        Settlement storage s = r.results[scoreIndex];
        v.scoreTime = r.scoreTimes[scoreIndex];
        v.start = r.start;
        if (s.settledAt == 0) return v;
        v.settled = true;
        v.settledAt = s.settledAt;
        v.redBp = s.redBp;
        v.blueBp = s.blueBp;
        v.refBp = s.refBp;
        v.spreadBp = s.spreadBp;
        v.end = s.end;
    }

    /// @notice Anchor number `n` (1-based) of round `id`.
    function anchorAt(bytes32 id, uint32 n) external view returns (Anchor memory) {
        return _anchors[id][n];
    }

    function roundCount() external view returns (uint256) {
        return _roundIds.length;
    }

    function roundIdAt(uint256 i) external view returns (bytes32) {
        return _roundIds[i];
    }

    function snapshotCount() external view returns (uint256) {
        return _snapshots.length;
    }

    /// @notice Snapshot number `n` (1-based, as in the `Snapshot` event).
    function snapshotAt(uint256 n) external view returns (SnapshotData memory) {
        return _snapshots[n - 1];
    }

    /// @notice Leaf of the picks tree (OpenZeppelin StandardMerkleTree,
    ///         encoding ["bytes32","address","uint8","uint8","int32","uint64"]). side 0 = RED, 1 = BLUE.
    function leafHash(bytes32 id, address picker, uint8 slot, uint8 side, int32 spreadBp, uint64 signedAt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(id, picker, slot, side, spreadBp, signedAt))));
    }

    /// @notice True if `leaf` is in the tree of anchor `n` of round `id`.
    function verify(bytes32 id, uint32 n, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = _anchors[id][n].root;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// @notice EIP-712 digest a wallet signs for a pick (domain {name:"TAPEWARD", version:"1", chainId:4663}).
    function pickDigest(bytes32 id, uint8 side, int32 spreadBp, uint8 slot, uint64 signedAt)
        external
        pure
        returns (bytes32)
    {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TAPEWARD"), keccak256("1"), PICK_CHAIN_ID));
        bytes32 structHash = keccak256(abi.encode(PICK_TYPEHASH, id, side, spreadBp, slot, signedAt));
        return MessageHashUtils.toTypedDataHash(domain, structHash);
    }

    // ------------------------------------------------------------------ internal

    function _existing(bytes32 id) private view returns (RoundData storage r) {
        r = _rounds[id];
        if (r.lockTime == 0) revert UnknownRound(id);
    }

    function _feedX(int256 start, int256 end) private pure returns (int256) {
        return (end - start) * 1e22 / start;
    }

    function _read(address feed, uint80 roundId) private view returns (bool ok, int256 answer, uint256 updatedAt) {
        try IAggregatorV3(feed).getRoundData(roundId) returns (
            uint80 rid, int256 a, uint256, uint256 u, uint80
        ) {
            ok = rid == roundId && u != 0;
            answer = a;
            updatedAt = u;
        } catch {}
    }

    function _checkedPoint(uint256 k, uint80 roundId, uint256 t) private view returns (FeedPoint memory p) {
        address feed = _feeds[k];
        (bool ok, int256 answer, uint256 updatedAt) = _read(feed, roundId);
        if (!ok || answer <= 0) revert RoundMissing(k, roundId);
        if (updatedAt > t) revert RoundAfterT(k, roundId, updatedAt, t);
        if (updatedAt + MAX_STALENESS < t) revert RoundStale(k, roundId, updatedAt, t);
        if (roundId != type(uint80).max) {
            (bool nextOk,, uint256 nextUpdatedAt) = _read(feed, roundId + 1);
            if (nextOk && nextUpdatedAt <= t) revert RoundNotLatest(k, roundId, nextUpdatedAt, t);
        }
        p = FeedPoint({roundId: roundId, updatedAt: updatedAt.toUint48(), answer: answer.toInt128()});
    }
}
