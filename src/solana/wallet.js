const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { WALLET_PRIVATE_KEY, HELIUS_RPC_URL, DRY_RUN } = require('../config');

// bs58 v5/v6 shipped as ESM-only, so require('bs58') under CommonJS
// returns { default: { encode, decode } } instead of exposing decode
// directly like v4 did — this normalizes both shapes so it keeps working
// whichever one npm actually installs.
const bs58Module = require('bs58');
const bs58 = typeof bs58Module.decode === 'function' ? bs58Module : bs58Module.default;

let keypair = null;

function loadWallet() {
  if (keypair) return keypair;

  if (!WALLET_PRIVATE_KEY) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false.');
    }
    // In dry-run without a real key, use a throwaway keypair purely so the
    // rest of the code (balance checks, logging) has something to work
    // with. It holds no funds and nothing is ever sent from it.
    keypair = Keypair.generate();
    console.warn('[wallet] DRY_RUN mode, no WALLET_PRIVATE_KEY set — using a throwaway keypair with no funds.');
    return keypair;
  }

  const secretKey = bs58.decode(WALLET_PRIVATE_KEY);
  keypair = Keypair.fromSecretKey(secretKey);
  return keypair;
}

function getConnection() {
  return new Connection(HELIUS_RPC_URL, 'confirmed');
}

async function getSolBalance() {
  const connection = getConnection();
  const wallet = loadWallet();
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

module.exports = { loadWallet, getConnection, getSolBalance, PublicKey };
