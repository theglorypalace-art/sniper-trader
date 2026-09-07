const { VersionedTransaction } = require('@solana/web3.js');
const {
  JUPITER_QUOTE_URL,
  JUPITER_SWAP_URL,
  SOL_MINT,
  SLIPPAGE_BPS,
  PRIORITY_FEE_LAMPORTS,
  DRY_RUN,
} = require('../config');
const { getConnection } = require('../solana/wallet');

// Verify this API surface against Jupiter's current docs before relying on
// it — swap-aggregator APIs are actively developed and versioned APIs do
// get deprecated. This targets the v6 quote/swap endpoints as of writing.
async function getQuote(inputMint, outputMint, amountLamports) {
  const url =
    `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function buildSwapTransaction(quote, walletPublicKey) {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
  const { swapTransaction } = await res.json();
  return swapTransaction;
}

// Executes a real on-chain swap. Never called when DRY_RUN is true — callers
// are responsible for checking that themselves, but this is a second
// safety check in case something upstream forgets to.
async function executeSwap(quote, wallet) {
  if (DRY_RUN) {
    throw new Error('executeSwap called while DRY_RUN=true — refusing to send a real transaction.');
  }

  const swapTxBase64 = await buildSwapTransaction(quote, wallet.publicKey);
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'));
  tx.sign([wallet]);

  const connection = getConnection();
  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

// Buys `solAmount` SOL worth of `mint`. Returns quote info even in dry run
// so callers can log/simulate what would have happened.
async function buySol(mint, solAmountLamports, wallet) {
  const quote = await getQuote(SOL_MINT, mint, solAmountLamports);
  if (DRY_RUN) {
    return { dryRun: true, quote, signature: null };
  }
  const signature = await executeSwap(quote, wallet);
  return { dryRun: false, quote, signature };
}

// Sells the full token amount back to SOL.
async function sellToSol(mint, tokenAmountRaw, wallet) {
  const quote = await getQuote(mint, SOL_MINT, tokenAmountRaw);
  if (DRY_RUN) {
    return { dryRun: true, quote, signature: null };
  }
  const signature = await executeSwap(quote, wallet);
  return { dryRun: false, quote, signature };
}

module.exports = { getQuote, buildSwapTransaction, executeSwap, buySol, sellToSol };
