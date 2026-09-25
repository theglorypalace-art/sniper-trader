// Buy/sell pump.fun tokens (bonding curve + post-migration) via PumpPortal's
// local trade API. Jupiter cannot route pre-migration curve tokens — that is
// why the bot previously assessed everything and never bought at launch.
//
// Docs: https://pumpportal.fun/local-trading-api/trading-api/
// We request an unsigned tx, sign it ourselves, send via Helius RPC.
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { DRY_RUN, SLIPPAGE_BPS, PRIORITY_FEE_LAMPORTS } = require('../config');
const { getConnection, loadWallet } = require('../solana/wallet');

const TRADE_LOCAL_URL = process.env.PUMPPORTAL_TRADE_URL || 'https://pumpportal.fun/api/trade-local';

// Exit sells use higher slippage so TP/SL actually fill in thin curve liquidity.
const EXIT_SLIPPAGE_PCT = Number(process.env.EXIT_SLIPPAGE_PCT || 25);

function priorityFeeSol() {
  const lamports = Number(PRIORITY_FEE_LAMPORTS || 100000);
  return Math.max(0.00001, lamports / 1e9);
}

function buySlippagePct() {
  return Math.max(1, Math.round(Number(SLIPPAGE_BPS || 500) / 100));
}

/**
 * Read the wallet's raw token balance for `mint` (0 if no ATA / empty).
 */
async function getTokenBalanceRaw(mint) {
  const connection = getConnection();
  const wallet = loadWallet();
  const mintPk = new PublicKey(mint);
  const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPk });
  let total = 0n;
  for (const { account } of resp.value) {
    const info = account.data.parsed && account.data.parsed.info;
    if (!info || !info.tokenAmount) continue;
    total += BigInt(info.tokenAmount.amount || '0');
  }
  return total;
}

async function portalTrade({ action, mint, amount, denominatedInSol, slippage }) {
  const wallet = loadWallet();
  const body = {
    publicKey: wallet.publicKey.toBase58(),
    action,
    mint,
    amount: typeof amount === 'number' ? amount : String(amount),
    denominatedInSol: denominatedInSol ? 'true' : 'false',
    slippage: slippage != null ? slippage : buySlippagePct(),
    priorityFee: priorityFeeSol(),
    pool: 'auto',
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

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const j = await res.json();
    if (j.error || j.errors) throw new Error(`PumpPortal: ${JSON.stringify(j.error || j.errors)}`);
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
      quote: { outAmount: String(Math.floor(1e6 * sizeSol)) },
    };
  }

  const balBefore = await getTokenBalanceRaw(mint);
  const { tx, wallet } = await portalTrade({
    action: 'buy',
    mint,
    amount: sizeSol,
    denominatedInSol: true,
    slippage: buySlippagePct(),
  });
  const sent = await sendSigned(tx, wallet);

  // Wait briefly then read real balance — portal does not return outAmount.
  let tokenAmountRaw = 0n;
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    const bal = await getTokenBalanceRaw(mint);
    if (bal > balBefore) {
      tokenAmountRaw = bal - balBefore;
      break;
    }
    if (bal > 0n && balBefore === 0n) {
      tokenAmountRaw = bal;
      break;
    }
  }

  if (tokenAmountRaw === 0n) {
    // Last resort: total balance (may include prior dust)
    tokenAmountRaw = await getTokenBalanceRaw(mint);
  }

  console.log(`[pumpPortal] bought ${mint}: +${tokenAmountRaw.toString()} raw tokens for ${sizeSol} SOL (sig ${sent.signature})`);

  return {
    ...sent,
    sizeSol,
    tokenAmountRaw: tokenAmountRaw > 0n ? tokenAmountRaw.toString() : null,
    via: 'pumpPortal',
    quote: { outAmount: tokenAmountRaw > 0n ? tokenAmountRaw.toString() : '0' },
  };
}

/**
 * Always sell 100% of wallet holdings for this mint when amount unknown/zero.
 * Uses elevated exit slippage so TP/SL fills on thin curve books.
 */
async function sellOnPump(mint, tokenAmountRaw) {
  if (DRY_RUN) {
    console.log(`[pumpPortal] [DRY RUN] would sell 100% of ${mint}`);
    return { dryRun: true, signature: null, via: 'pumpPortal', quote: null };
  }

  const bal = await getTokenBalanceRaw(mint);
  if (bal === 0n) {
    const err = new Error('SellZeroAmount: wallet holds 0 tokens for this mint — nothing to sell');
    err.code = 'SELL_ZERO';
    throw err;
  }

  // Prefer "100%" so we never pass a stale/wrong raw amount that underflows to 0.
  const { tx, wallet } = await portalTrade({
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: false,
    slippage: EXIT_SLIPPAGE_PCT,
  });
  const sent = await sendSigned(tx, wallet);
  console.log(`[pumpPortal] sold 100% of ${mint} (had ${bal.toString()} raw) sig=${sent.signature}`);
  return { ...sent, via: 'pumpPortal', quote: null, soldRaw: bal.toString() };
}

module.exports = { buyOnPump, sellOnPump, getTokenBalanceRaw, portalTrade };
