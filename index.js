const config = require('./src/config');
const { getDailyCount } = require('./src/analysis/dailyLimiter');

const { PumpFunDetector } = require('./src/pumpfun/detector');
const { tryEnterPosition: trySolanaPosition } = require('./src/trading/positionManager');
const { getSolBalance, loadWallet: loadSolanaWallet } = require('./src/solana/wallet');

const { PancakeSwapDetector } = require('./src/bsc/detector');
const { tryEnterPosition: tryBscPosition } = require('./src/bsc/positionManager');
const { getBnbBalance, loadWallet: loadBscWallet } = require('./src/bsc/wallet');

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[unhandled-rejection]', msg);
});

async function bootSolana() {
  const wallet = loadSolanaWallet();
  console.log(`[boot] solana wallet: ${wallet.publicKey.toBase58()}`);
  try {
    const balance = await getSolBalance();
    console.log(`[boot] SOL balance: ${balance}`);
  } catch (err) {
    console.warn('[boot] could not fetch SOL balance yet:', err.message);
  }

  const detector = new PumpFunDetector(async ({ mint, signature }) => {
    console.log(`[launch] new pump.fun token detected: ${mint} (tx ${signature})`);
    await trySolanaPosition(mint);
  });
  detector.start();
  console.log('[boot] ✅ listening for new pump.fun launches (Solana)...');
}

async function bootBsc() {
  const wallet = loadBscWallet();
  console.log(`[boot] bsc wallet: ${wallet.address}`);
  try {
    const balance = await getBnbBalance();
    console.log(`[boot] BNB balance: ${balance}`);
  } catch (err) {
    console.warn('[boot] could not fetch BNB balance yet:', err.message);
  }

  const detector = new PancakeSwapDetector(async ({ tokenAddress, pairAddress }) => {
    console.log(`[launch] new PancakeSwap pair detected: token=${tokenAddress} pair=${pairAddress}`);
    await tryBscPosition(tokenAddress);
  });
  detector.start();
  console.log('[boot] ✅ listening for new PancakeSwap launches (BSC)...');
}

async function main() {
  console.log('[boot] meme coin scanner starting...');
  console.log(`[boot] DRY_RUN = ${config.DRY_RUN} ${config.DRY_RUN ? '(no real trades will be sent)' : '(REAL TRADES WILL BE SENT)'}`);
  console.log(`[boot] daily selectivity: max ${config.MAX_TOKENS_PER_DAY} recommended tokens/day (${getDailyCount()} used so far today)`);
  console.log(`[boot] chains enabled: solana=${config.ENABLE_SOLANA} bsc=${config.ENABLE_BSC}`);

  if (!config.ENABLE_SOLANA && !config.ENABLE_BSC) {
    throw new Error('Both ENABLE_SOLANA and ENABLE_BSC are disabled in .env — nothing to run.');
  }

  if (config.ENABLE_SOLANA) await bootSolana();
  if (config.ENABLE_BSC) await bootBsc();
}

main().catch((err) => {
  console.error('[boot] fatal error:', err.message);
  process.exit(1);
});
