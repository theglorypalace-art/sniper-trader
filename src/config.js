require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const DRY_RUN = process.env.DRY_RUN !== 'false'; // SAFE DEFAULT: true. Must explicitly set "false" to trade for real.
const ENABLE_SOLANA = process.env.ENABLE_SOLANA !== 'false'; // default true
const ENABLE_BSC = process.env.ENABLE_BSC === 'true'; // default false — opt in once you're ready
const ENABLE_GRADUATION_WATCH = process.env.ENABLE_GRADUATION_WATCH !== 'false'; // default true — watch pre-migration tokens instead of discarding them

module.exports = {
  DRY_RUN,
  ENABLE_SOLANA,
  ENABLE_BSC,
  ENABLE_GRADUATION_WATCH,

  // ---- Solana / pump.fun ----
  HELIUS_API_KEY: ENABLE_SOLANA ? required('HELIUS_API_KEY') : process.env.HELIUS_API_KEY || null,
  HELIUS_RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`,
  HELIUS_WSS_URL: `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`,

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

  CAPITAL_PCT: Number(process.env.CAPITAL_PCT || 10), // DE-BULL: max ~10% of capital per trade
  MAX_POSITION_SOL: Number(process.env.MAX_POSITION_SOL || 0.5), // hard cap regardless of CAPITAL_PCT (0 = no cap)
  SOL_FEE_RESERVE: Number(process.env.SOL_FEE_RESERVE || 0.01), // SOL always left in the wallet for fees/rent, even at 100%
  MAX_CONCURRENT_POSITIONS: Number(process.env.MAX_CONCURRENT_POSITIONS || 1),
  SLIPPAGE_BPS: Number(process.env.SLIPPAGE_BPS || 1500), // 5% — thin new-launch liquidity needs room
  PRIORITY_FEE_LAMPORTS: Number(process.env.PRIORITY_FEE_LAMPORTS || 100000),

  // ---- BNB Smart Chain / PancakeSwap ----
  // Public free-tier RPC by default — fine for testing, but get a
  // dedicated key (Ankr/QuickNode/NodeReal/Chainstack) before trading real
  // funds, same reasoning as using Helius instead of a public Solana RPC.
  BSC_RPC_URL: process.env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com',
  BSC_WSS_URL: process.env.BSC_WSS_URL || 'wss://bsc-rpc.publicnode.com',

  // Hex-encoded (0x...) private key for a DEDICATED BSC bot wallet.
  // Required only when DRY_RUN=false and ENABLE_BSC=true. Never your main wallet.
  BSC_WALLET_PRIVATE_KEY: process.env.BSC_WALLET_PRIVATE_KEY || null,

  // PancakeSwap V2 mainnet addresses — confirmed against BscScan at the
  // time this was written. Verify before going live in case of a protocol
  // migration (e.g. a V3-only future).
  PANCAKESWAP_FACTORY: process.env.PANCAKESWAP_FACTORY || '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  PANCAKESWAP_ROUTER: process.env.PANCAKESWAP_ROUTER || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  WBNB_ADDRESS: process.env.WBNB_ADDRESS || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',

  BSC_CAPITAL_PCT: Number(process.env.BSC_CAPITAL_PCT || 10), // DE-BULL: ~10% of capital
  BSC_MAX_POSITION_BNB: Number(process.env.BSC_MAX_POSITION_BNB || 0.1), // 0 = no cap
  BNB_FEE_RESERVE: Number(process.env.BNB_FEE_RESERVE || 0.003), // BNB always left in the wallet for gas, even at 100%
  BSC_MAX_CONCURRENT_POSITIONS: Number(process.env.BSC_MAX_CONCURRENT_POSITIONS || 1),
  BSC_SLIPPAGE_BPS: Number(process.env.BSC_SLIPPAGE_BPS || 700), // fresh PancakeSwap pools are typically thinner than pump.fun's own curve

  // ---- Shared strategy / risk ----
  // TAKE_PROFIT_PCT / STOP_LOSS_PCT below are fallbacks only — the risk
  // engine (src/analysis/riskEngine.js) sets a per-token exit plan based
  // on that token's risk tier. These are only used if something bypasses
  // the risk engine entirely, which normal operation never does.
  TAKE_PROFIT_PCT: Number(process.env.TAKE_PROFIT_PCT || 25),
  STOP_LOSS_PCT: process.env.STOP_LOSS_PCT != null ? Number(process.env.STOP_LOSS_PCT) : -50,
  MAX_POSITION_AGE_MS: Number(process.env.MAX_POSITION_AGE_MS || 30 * 60 * 1000),
  PRICE_POLL_INTERVAL_MS: Number(process.env.PRICE_POLL_INTERVAL_MS || 4000),

  // How selective the scanner is — max tokens recommended/traded per UTC day.
  // (Fallback only if Supabase isn't configured — see src/live/liveConfig.js.)
  MAX_TOKENS_PER_DAY: Number(process.env.MAX_TOKENS_PER_DAY || 50),

  // ---- Live control layer (optional but recommended for 24/7 operation) ----
  // Without these, the bot still runs fine on static .env config — you
  // just lose live filter updates and the dashboard/Telegram feed.
  // Get URL + service_role key from Supabase project settings > API.
  // Use the service_role key here (server-side only, never expose it to a
  // browser/dashboard — the dashboard should use the anon key instead).
  SUPABASE_URL: process.env.SUPABASE_URL || null,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || null,

  // Create a bot via @BotFather on Telegram to get this token.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  // Your personal chat ID — the bot prints this when you send it /start.
  // Leave blank during setup, then lock it down once you have it.
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
};
