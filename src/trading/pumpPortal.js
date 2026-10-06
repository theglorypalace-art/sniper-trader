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
  // pump.fun curves move fast — 15% is often too tight (TooMuchSolRequired 0x1772).
  // Floor at 25% unless env asks for more via SLIPPAGE_BPS.
  const fromEnv = Math.round(Number(SLIPPAGE_BPS || 2500) / 100);
  return Math.max(25, fromEnv);
}

function isTooMuchSolError(err) {
  const msg = String(err && err.message || err || '');
  return (
    /0x1772/i.test(msg) ||
    /TooMuchSol/i.test(msg) ||
    /Too much SOL required/i.test(msg) ||
    /slippage/i.test(msg)
  );
}

/**
 * Read the wallet's raw token balance for `mint` (0 if no ATA / empty / mint not indexed yet).
 * Brand-new pump.fun mints often make `{ mint }` filter RPC calls fail with
 * "could not find mint" — never throw; treat as 0 so the buy can still run.
 */
async function getTokenBalanceRaw(mint) {
  const connection = getConnection();
  const wallet = loadWallet();
  let mintPk;
  try {
    mintPk = new PublicKey(mint);
  } catch {
    return 0n;
  }

  // Path 1: filtered by mint (fast when mint is indexed)
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPk });
    let total = 0n;
    for (const { account } of resp.value) {
      const info = account.data.parsed && account.data.parsed.info;
      if (!info || !info.tokenAmount) continue;
      total += BigInt(info.tokenAmount.amount || '0');
    }
    return total;
  } catch (err) {
    // "could not find mint" / Token program id errors on brand-new launches
    console.warn(`[pumpPortal] mint-filtered balance lookup failed for ${mint}: ${err.message}`);
  }

  // Path 2: all token accounts for owner, match mint client-side (Token + Token-2022)
  try {
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    let total = 0n;
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      try {
        const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId });
        for (const { account } of resp.value) {
          const info = account.data.parsed && account.data.parsed.info;
          if (!info || info.mint !== mint) continue;
          total += BigInt((info.tokenAmount && info.tokenAmount.amount) || '0');
        }
      } catch (_) {
        /* ignore per-program failures */
      }
    }
    return total;
  } catch (err) {
    console.warn(`[pumpPortal] full balance scan failed for ${mint}: ${err.message}`);
    return 0n;
  }
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

  let balBefore = 0n;
  try {
    balBefore = await getTokenBalanceRaw(mint);
  } catch (_) {
    balBefore = 0n;
  }

  // Slippage ladder: curves move between quote and land → TooMuchSolRequired (0x1772).
  // Retry with higher slippage, then smaller size.
  const slipSteps = [
    { sol: sizeSol, slip: buySlippagePct() },
    { sol: sizeSol, slip: Math.max(40, buySlippagePct() + 15) },
    { sol: sizeSol * 0.6, slip: 50 },
    { sol: sizeSol * 0.4, slip: 50 },
  ];

  let sent = null;
  let usedSol = sizeSol;
  let lastErr = null;
  for (let i = 0; i < slipSteps.length; i += 1) {
    const step = slipSteps[i];
    if (!(step.sol > 0.001)) continue;
    try {
      console.log(`[pumpPortal] buy attempt ${i + 1}/${slipSteps.length}: ${step.sol.toFixed(4)} SOL @ ${step.slip}% slip`);
      const { tx, wallet } = await portalTrade({
        action: 'buy',
        mint,
        amount: step.sol,
        denominatedInSol: true,
        slippage: step.slip,
      });
      sent = await sendSigned(tx, wallet);
      usedSol = step.sol;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (isTooMuchSolError(err) && i < slipSteps.length - 1) {
        console.warn(`[pumpPortal] TooMuchSolRequired — retrying with more slippage / less size`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  if (!sent) throw new Error('buyOnPump: no successful send');

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
    tokenAmountRaw = await getTokenBalanceRaw(mint);
  }

  // Extra wait — RPC can lag behind confirmed tx
  if (tokenAmountRaw === 0n) {
    await new Promise((r) => setTimeout(r, 2000));
    tokenAmountRaw = await getTokenBalanceRaw(mint);
  }

  if (tokenAmountRaw === 0n) {
    const err = new Error(
      `Buy confirmed (sig ${sent.signature}) but wallet still holds 0 tokens of ${mint} — not opening a position`
    );
    err.code = 'BUY_ZERO';
    err.signature = sent.signature;
    throw err;
  }

  console.log(`[pumpPortal] bought ${mint}: +${tokenAmountRaw.toString()} raw tokens for ${usedSol} SOL (sig ${sent.signature})`);

  return {
    ...sent,
    sizeSol: usedSol,
    tokenAmountRaw: tokenAmountRaw.toString(),
    via: 'pumpPortal',
    quote: { outAmount: tokenAmountRaw.toString() },
  };
}

/**
 * Always sell 100% of wallet holdings for this mint when amount unknown/zero.
 * Uses elevated exit slippage so TP/SL fills on thin curve books.
 */
async function sellOnPump(mint, tokenAmountRaw, opts = {}) {
  if (DRY_RUN) {
    console.log(`[pumpPortal] [DRY RUN] would sell 100% of ${mint}`);
    return { dryRun: true, signature: null, via: 'pumpPortal', quote: null };
  }

  // Re-read balance every attempt — RPC lag caused many false SellZeroAmount.
  let bal = 0n;
  for (let i = 0; i < 4; i += 1) {
    bal = await getTokenBalanceRaw(mint);
    if (bal > 0n) break;
    await new Promise((r) => setTimeout(r, 700 + i * 400));
  }
  if (bal === 0n) {
    const err = new Error('SellZeroAmount: wallet holds 0 tokens for this mint — nothing to sell');
    err.code = 'SELL_ZERO';
    throw err;
  }

  const slip = Math.min(99, Math.max(10, Number(opts.slippage) || EXIT_SLIPPAGE_PCT));
  // Always sell 100% of wallet holdings for this mint (never stale partial amount).
  const { tx, wallet } = await portalTrade({
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: false,
    slippage: slip,
  });
  const sent = await sendSigned(tx, wallet);
  console.log(`[pumpPortal] sold 100% of ${mint} (had ${bal.toString()} raw, slip ${slip}%) sig=${sent.signature}`);
  return { ...sent, via: 'pumpPortal', quote: null, soldRaw: bal.toString() };
}

module.exports = { buyOnPump, sellOnPump, getTokenBalanceRaw, portalTrade };
