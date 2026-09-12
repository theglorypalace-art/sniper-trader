const { ethers } = require('ethers');
const { PANCAKESWAP_ROUTER, WBNB_ADDRESS, BSC_SLIPPAGE_BPS, DRY_RUN } = require('../config');
const { getProvider } = require('./wallet');

// Verify these against PancakeSwap's current docs before relying on them —
// router ABIs are stable but not guaranteed forever. Addresses confirmed
// against BscScan at the time this was written:
// Router V2: 0x10ED43C718714eb63d5aA57B78B54704E256024E
// Factory V2: 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function getRouter(signerOrProvider) {
  return new ethers.Contract(PANCAKESWAP_ROUTER, ROUTER_ABI, signerOrProvider || getProvider());
}

function getTokenContract(address, signerOrProvider) {
  return new ethers.Contract(address, ERC20_ABI, signerOrProvider || getProvider());
}

async function getTokenDecimals(address) {
  return getTokenContract(address).decimals();
}

function applySlippage(amount) {
  return (amount * BigInt(10000 - BSC_SLIPPAGE_BPS)) / 10000n;
}

// Quotes buying `tokenAddress` with `bnbAmountWei` of BNB.
async function quoteBuy(tokenAddress, bnbAmountWei) {
  const router = getRouter();
  const amounts = await router.getAmountsOut(bnbAmountWei, [WBNB_ADDRESS, tokenAddress]);
  return amounts[amounts.length - 1];
}

// Quotes selling `tokenAmountRaw` of `tokenAddress` back to BNB. Used both
// for the initial safety check (can it be sold at all right now?) and for
// live position monitoring.
async function quoteSell(tokenAddress, tokenAmountRaw) {
  const router = getRouter();
  const amounts = await router.getAmountsOut(tokenAmountRaw, [tokenAddress, WBNB_ADDRESS]);
  return amounts[amounts.length - 1];
}

async function buyWithBnb(tokenAddress, bnbAmountWei, wallet) {
  const outAmount = await quoteBuy(tokenAddress, bnbAmountWei);
  if (DRY_RUN) {
    return { dryRun: true, outAmountRaw: outAmount, txHash: null };
  }

  const router = getRouter(wallet);
  const minOut = applySlippage(outAmount);
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minOut,
    [WBNB_ADDRESS, tokenAddress],
    wallet.address,
    deadline,
    { value: bnbAmountWei }
  );
  const receipt = await tx.wait();
  return { dryRun: false, outAmountRaw: outAmount, txHash: receipt.hash };
}

async function sellForBnb(tokenAddress, tokenAmountRaw, wallet) {
  const outAmount = await quoteSell(tokenAddress, tokenAmountRaw);
  if (DRY_RUN) {
    return { dryRun: true, outAmountRaw: outAmount, txHash: null };
  }

  const token = getTokenContract(tokenAddress, wallet);
  const router = getRouter(wallet);

  const allowance = await token.allowance(wallet.address, PANCAKESWAP_ROUTER);
  if (allowance < tokenAmountRaw) {
    const approveTx = await token.approve(PANCAKESWAP_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
  }

  const minOut = applySlippage(outAmount);
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
    tokenAmountRaw,
    minOut,
    [tokenAddress, WBNB_ADDRESS],
    wallet.address,
    deadline
  );
  const receipt = await tx.wait();
  return { dryRun: false, outAmountRaw: outAmount, txHash: receipt.hash };
}

module.exports = {
  getRouter,
  getTokenContract,
  getTokenDecimals,
  quoteBuy,
  quoteSell,
  buyWithBnb,
  sellForBnb,
};
