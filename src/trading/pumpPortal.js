// Buy/sell pump.fun tokens (bonding curve + post-migration) via PumpPortal's
// local trade API. Jupiter cannot route pre-migration curve tokens — that is
// why the bot previously assessed everything and never bought at launch.
//
// Docs: https://pumpportal.fun/local-trading-api/trading-api/
// We request an unsigned tx, sign it ourselves, send via Helius RPC.
const {
  VersionedTransaction,
  Connection,
} = require('@solana/web3.js');
const { DRY_RUN, HELIUS_RPC_URL, SLIPPAGE_BPS, PRIORITY_FEE_LAMPORTS } = require('../config');
const { getConnection, loadWallet } = require('../solana/wallet');

const TRADE_LOCAL_URL = process.env.PUMPPORTAL_TRADE_URL || 'https://pumpportal.fun/api/trade-local';

function priorityFeeSol() {
  // PRIORITY_FEE_LAMPORTS is in lamports; portal wants SOL as a float.
  const lamports = Number(PRIORITY_FEE_LAMPORTS || 100000);
  return Math.max(0.00001, lamports / 1e9);
}

function slippagePct() {
  // SLIPPAGE_BPS e.g. 500 = 5%
  return Math.max(1, Math.round(Number(SLIPPAGE_BPS || 500) / 100));
}

/**
 * POST trade-local → unsigned VersionedTransaction bytes → sign → send.
 * action: 'buy' | 'sell'
 * amount: for buy = SOL amount (number); for sell = token amount or "100%"
 * denominatedInSol: true for buy-in-SOL, false for token amounts
 */
async function portalTrade({ action, mint, amount, denominatedInSol }) {
  const wallet = loadWallet();
  const body = {
    publicKey: wallet.publicKey.toBase58(),
    action,
    mint,
    amount: typeof amount === 'number' ? amount : String(amount),
    denominatedInSol: denominatedInSol ? 'true' : 'false',
    slippage: slippagePct(),
    priorityFee: priorityFeeSol(),
    pool: 'auto', // pump curve → pump-amm → raydium as needed
  };

  const res = await fetch(TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpPortal trade-local failed (${res.status}): ${text.slice(0, 300)}`);
  }

  // Response is raw serialized transaction bytes (arraybuffer) or sometimes JSON error
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const j = await res.json();
    if (j.error || j.errors) throw new Error(`PumpPortal: ${JSON.stringify(j.error || j.errors)}`);
    // some versions return base64 in JSON
    if (j.transaction) {
      const tx = VersionedTransaction.deserialize(Buffer.from(j.transaction, 'base64'));
      return { tx, wallet };
    }
    throw new Error(`PumpPortal unexpected JSON: ${JSON.stringify(j).slice(0, 200)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(buf);
  return { tx, wallet };
}

async function sendSigned(tx, wallet) {
  if (DRY_RUN) {
    return { dryRun: true, signature: null };
  }
  tx.sign([wallet]);
  const connection = getConnection();
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(signature, 'confirmed');
  return { dryRun: false, signature };
}

/**
 * Buy `solAmount` SOL worth of mint on pump.fun curve (or auto-routed pool).
 * Returns { dryRun, signature, sizeSol, tokenAmountRaw } — tokenAmountRaw may
 * be null if we cannot read the ATA yet; monitor will fall back to 100% sell.
 */
async function buyOnPump(mint, solAmount) {
  const sizeSol = Number(solAmount);
  if (!(sizeSol > 0)) throw new Error('buyOnPump: solAmount must be > 0');

  if (DRY_RUN) {
    console.log(`[pumpPortal] [DRY RUN] would buy ${sizeSol} SOL of ${mint}`);
    return {
      dryRun: true,
      signature: null,
      sizeSol,
      tokenAmountRaw: null,
      via: 'pumpPortal',
      // fake quote so positionManager can compute a placeholder entry price
      quote: { outAmount: String(Math.floor(1e6 * sizeSol)) },
    };
  }

  const { tx, wallet } = await portalTrade({
    action: 'buy',
    mint,
    amount: sizeSol,
    denominatedInSol: true,
  });
  const sent = await sendSigned(tx, wallet);
  return {
    ...sent,
    sizeSol,
    tokenAmountRaw: null, // filled by caller if needed via balance check
    via: 'pumpPortal',
    quote: { outAmount: '0' },
  };
}

/**
 * Sell tokens back. Prefer amountRaw if known; otherwise sell 100% of wallet balance.
 */
async function sellOnPump(mint, tokenAmountRaw) {
  if (DRY_RUN) {
    console.log(`[pumpPortal] [DRY RUN] would sell ${tokenAmountRaw ?? '100%'} of ${mint}`);
    return { dryRun: true, signature: null, via: 'pumpPortal' };
  }

  const amount =
    tokenAmountRaw != null && Number(tokenAmountRaw) > 0
      ? Number(tokenAmountRaw)
      : '100%';

  const { tx, wallet } = await portalTrade({
    action: 'sell',
    mint,
    amount,
    denominatedInSol: false,
  });
  const sent = await sendSigned(tx, wallet);
  return { ...sent, via: 'pumpPortal' };
}

module.exports = { buyOnPump, sellOnPump, portalTrade };
