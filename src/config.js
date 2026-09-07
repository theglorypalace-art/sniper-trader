require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const DRY_RUN = process.env.DRY_RUN !== 'false'; // SAFE DEFAULT: true. Must explicitly set "false" to trade for real.

module.exports = {
  DRY_RUN,

  HELIUS_API_KEY: required('HELIUS_API_KEY'),
  // Helius RPC + WebSocket endpoints, built from your API key.
  HELIUS_RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  HELIUS_WSS_URL: `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,

  // Base58-encoded Solana private key for the DEDICATED bot wallet.
  // Required only when DRY_RUN=false. Never use your main wallet's key.
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || null,

  // pump.fun's mainnet program ID (verify this against current pump.fun
  // docs/explorer before going live — program IDs can change if the
  // protocol upgrades).
  PUMPFUN_PROGRAM_ID: process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  JUPITER_QUOTE_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',
  JUPITER_SWAP_URL: process.env.JUPITER_SWAP_URL || 'https://quote-api.jup.ag/v6/swap',
  SOL_MINT: 'So11111111111111111111111111111111111111112',

  // ---- Strategy ----
  CAPITAL_PCT: Number(process.env.CAPITAL_PCT || 5), // % of wallet SOL balance per snipe
  TAKE_PROFIT_PCT: Number(process.env.TAKE_PROFIT_PCT || 25), // sell trigger
  STOP_LOSS_PCT: process.env.STOP_LOSS_PCT != null ? Number(process.env.STOP_LOSS_PCT) : -50, // safety net; set to null/none to disable
  MAX_POSITION_SOL: Number(process.env.MAX_POSITION_SOL || 0.5), // hard cap regardless of CAPITAL_PCT
  PRICE_POLL_INTERVAL_MS: Number(process.env.PRICE_POLL_INTERVAL_MS || 4000),
  MAX_POSITION_AGE_MS: Number(process.env.MAX_POSITION_AGE_MS || 30 * 60 * 1000), // force-exit stale positions
  MAX_CONCURRENT_POSITIONS: Number(process.env.MAX_CONCURRENT_POSITIONS || 1),
  SLIPPAGE_BPS: Number(process.env.SLIPPAGE_BPS || 500), // 5% — thin new-launch liquidity needs room
  PRIORITY_FEE_LAMPORTS: Number(process.env.PRIORITY_FEE_LAMPORTS || 100000),
};
