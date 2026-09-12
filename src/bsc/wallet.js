const { ethers } = require('ethers');
const { BSC_RPC_URL, BSC_WALLET_PRIVATE_KEY, DRY_RUN } = require('../config');

let wallet = null;
let provider = null;

function getProvider() {
  if (!provider) provider = new ethers.JsonRpcProvider(BSC_RPC_URL);
  return provider;
}

function loadWallet() {
  if (wallet) return wallet;

  if (!BSC_WALLET_PRIVATE_KEY) {
    if (!DRY_RUN) {
      throw new Error('BSC_WALLET_PRIVATE_KEY is required when DRY_RUN=false.');
    }
    // Dry-run without a real key — throwaway wallet, holds no funds, never
    // sends anything real.
    wallet = ethers.Wallet.createRandom().connect(getProvider());
    console.warn('[bsc-wallet] DRY_RUN mode, no BSC_WALLET_PRIVATE_KEY set — using a throwaway wallet with no funds.');
    return wallet;
  }

  wallet = new ethers.Wallet(BSC_WALLET_PRIVATE_KEY, getProvider());
  return wallet;
}

async function getBnbBalance() {
  const w = loadWallet();
  const balance = await getProvider().getBalance(w.address);
  return Number(ethers.formatEther(balance));
}

module.exports = { getProvider, loadWallet, getBnbBalance };
