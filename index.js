const config = require('./src/config');
const { PumpFunDetector } = require('./src/pumpfun/detector');
const { tryEnterPosition } = require('./src/trading/positionManager');
const { getSolBalance, loadWallet } = require('./src/solana/wallet');

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[unhandled-rejection]', msg);
});

async function main() {
  console.log('[boot] pump.fun sniper bot starting...');
  console.log(`[boot] DRY_RUN = ${config.DRY_RUN} ${config.DRY_RUN ? '(no real trades will be sent)' : '(REAL TRADES WILL BE SENT)'}`);

  const wallet = loadWallet();
  console.log(`[boot] wallet: ${wallet.publicKey.toBase58()}`);

  try {
    const balance = await getSolBalance();
    console.log(`[boot] SOL balance: ${balance}`);
  } catch (err) {
    console.warn('[boot] could not fetch balance yet:', err.message);
  }

  console.log(
    `[boot] strategy: ${config.CAPITAL_PCT}% capital per snipe, ` +
      `+${config.TAKE_PROFIT_PCT}% take-profit, ` +
      `${config.STOP_LOSS_PCT != null ? config.STOP_LOSS_PCT + '% stop-loss' : 'no stop-loss'}, ` +
      `max ${config.MAX_POSITION_SOL} SOL per position`
  );

  const detector = new PumpFunDetector(async ({ mint, signature }) => {
    console.log(`[launch] new pump.fun token detected: ${mint} (tx ${signature})`);
    await tryEnterPosition(mint);
  });

  detector.start();
  console.log('[boot] ✅ listening for new pump.fun launches...');
}

main().catch((err) => {
  console.error('[boot] fatal error:', err.message);
  process.exit(1);
});
