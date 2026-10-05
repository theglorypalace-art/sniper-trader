const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const {
  WALLET_PRIVATE_KEY,
  HELIUS_RPC_URL,
  SOLANA_RPC_URL,
  SOLANA_RPC_FALLBACK,
  DRY_RUN,
} = require('../config');

const bs58Module = require('bs58');
const bs58 = typeof bs58Module.decode === 'function' ? bs58Module : bs58Module.default;

let keypair = null;
let rpcIndex = 0;
let last429At = 0;
const connections = [];

function rpcList() {
  const list = [];
  if (SOLANA_RPC_URL) list.push(SOLANA_RPC_URL);
  if (HELIUS_RPC_URL && HELIUS_RPC_URL.includes('api-key=') && !HELIUS_RPC_URL.endsWith('api-key=')) {
    list.push(HELIUS_RPC_URL);
  }
  if (SOLANA_RPC_FALLBACK) list.push(SOLANA_RPC_FALLBACK);
  // unique
  return [...new Set(list.filter(Boolean))];
}

function loadWallet() {
  if (keypair) return keypair;
  if (!WALLET_PRIVATE_KEY) {
    if (!DRY_RUN) throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false.');
    keypair = Keypair.generate();
    console.warn('[wallet] DRY_RUN — throwaway keypair');
    return keypair;
  }
  keypair = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
  return keypair;
}

function getConnection() {
  const urls = rpcList();
  if (!urls.length) throw new Error('No Solana RPC URL configured');
  // After recent 429, prefer fallback endpoints
  if (Date.now() - last429At < 5 * 60 * 1000 && urls.length > 1) {
    rpcIndex = Math.max(rpcIndex, 1);
  }
  const i = rpcIndex % urls.length;
  if (!connections[i]) {
    connections[i] = new Connection(urls[i], {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
    });
  }
  return connections[i];
}

function noteRpc429() {
  last429At = Date.now();
  rpcIndex += 1;
  console.warn(`[wallet] RPC 429 — rotating to next endpoint (index ${rpcIndex})`);
}

async function getSolBalance() {
  try {
    const connection = getConnection();
    const wallet = loadWallet();
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    if (/429|Too Many|rate/i.test(err.message)) {
      noteRpc429();
      const connection = getConnection();
      const wallet = loadWallet();
      const lamports = await connection.getBalance(wallet.publicKey);
      return lamports / LAMPORTS_PER_SOL;
    }
    throw err;
  }
}

module.exports = { loadWallet, getConnection, getSolBalance, PublicKey, noteRpc429 };
