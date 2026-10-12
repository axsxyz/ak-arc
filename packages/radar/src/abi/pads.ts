import { parseAbi } from 'viem';

/**
 * PLACEHOLDER pad ABI — generic bonding-curve launchpad shape.
 * Replace/extend per pad once real CAs + verified ABIs arrive (see README "Adding a pad").
 * A pad adapter only has to map its logs onto `pad_token_created` / `pad_graduated` NormalizedEvents.
 */
export const genericPadAbi = parseAbi([
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol)',
  'event Graduated(address indexed token, address indexed pool, uint256 quoteRaised)',
]);
