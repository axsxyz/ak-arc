import { parseAbi } from 'viem';

/**
 * CCTP V2 event shapes. `MessageReceived` was independently verified against a real Arc mainnet mint
 * (see fixtures/mainnet-real/receipts.json "cctp_mint";
 * identifiers anonymized): the log carries 4 topics (3 indexed + topic0), not 3.
 * `finalityThresholdExecuted` is INDEXED on Arc's deployment — the previous guess (non-indexed) made
 * decodeEventLog's strict topic-count check fail on every real mint, silently (never thrown past decodeLog's
 * catch), so this event never decoded and `bridge_mint` was never produced — found by
 * src/tools/backtest-24h.ts's 24h backtest recording 0 bridge_mint events.
 * A bad guess here would only cost sourceDomain/destinationDomain enrichment, never the inflow/outflow signal
 * itself (that comes from the plain ERC-20 Transfer, see pipeline.ts onTransfer) — but this one is now verified,
 * not a guess.
 */
export const cctpMessageTransmitterAbi = parseAbi([
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
]);

export const cctpTokenMessengerAbi = parseAbi([
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
]);
