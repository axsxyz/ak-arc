import { parseAbi } from 'viem';

export const univ2FactoryAbi = parseAbi([
  // Last param is named on purpose: viem decodes args positionally (array) if any input is unnamed.
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
  'function getPair(address, address) view returns (address)',
]);

export const univ2PairAbi = parseAbi([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);
