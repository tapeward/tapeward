// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Solidity port of the OpenZeppelin merkle-tree JS StandardMerkleTree (sortLeaves: true) for tests:
///      leaves sorted by hash, stored at the end of the array in reverse order, node = keccak(sorted pair),
///      proof = siblings walking up from the leaf's tree index.
library StandardTree {

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @return tree full tree (tree[0] = root)
    /// @return treeIndex position of leaves[i] in `tree`
    function build(bytes32[] memory leaves)
        internal
        pure
        returns (bytes32[] memory tree, uint256[] memory treeIndex)
    {
        uint256 n = leaves.length;
        require(n > 0, "empty");
        uint256[] memory order = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            order[i] = i;
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 cur = order[i];
            uint256 j = i;
            while (j > 0 && leaves[order[j - 1]] > leaves[cur]) {
                order[j] = order[j - 1];
                --j;
            }
            order[j] = cur;
        }

        tree = new bytes32[](2 * n - 1);
        treeIndex = new uint256[](n);
        for (uint256 k; k < n; ++k) {
            uint256 pos = tree.length - 1 - k;
            tree[pos] = leaves[order[k]];
            treeIndex[order[k]] = pos;
        }
        for (uint256 i = tree.length - n; i > 0; --i) {
            tree[i - 1] = hashPair(tree[2 * i - 1], tree[2 * i]);
        }
    }

    function proof(bytes32[] memory tree, uint256 index) internal pure returns (bytes32[] memory p) {
        uint256 depth;
        for (uint256 i = index; i > 0; i = (i - 1) / 2) {
            ++depth;
        }
        p = new bytes32[](depth);
        uint256 k;
        for (uint256 i = index; i > 0; i = (i - 1) / 2) {
            p[k++] = tree[i % 2 == 1 ? i + 1 : i - 1];
        }
    }
}
