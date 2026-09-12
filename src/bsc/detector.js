const { ethers } = require('ethers');
const { BSC_WSS_URL, PANCAKESWAP_FACTORY, WBNB_ADDRESS } = require('../config');

const FACTORY_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'];

// Subscribes to PancakeSwap V2 pair creations and calls onLaunch({ tokenAddress,
// pairAddress }) for every new WBNB-paired pool. Pairs quoted against
// anything other than WBNB (BUSD, USDT, etc.) are intentionally skipped —
// widen the check in handleEvent if you want those too.
//
// Note: ethers v6's WebSocketProvider exposes the underlying socket via
// `.websocket` for reconnect handling below. That's an internal-ish detail
// that could shift between ethers versions — if reconnects silently stop
// firing after an ethers upgrade, check this first.
class PancakeSwapDetector {
  constructor(onLaunch) {
    this.onLaunch = onLaunch;
    this.provider = null;
    this.contract = null;
    this.reconnectDelayMs = 1000;
  }

  start() {
    this.provider = new ethers.WebSocketProvider(BSC_WSS_URL);
    this.contract = new ethers.Contract(PANCAKESWAP_FACTORY, FACTORY_ABI, this.provider);

    this.contract.on('PairCreated', (token0, token1, pair) => {
      this.handleEvent(token0, token1, pair).catch((err) =>
        console.error('[pancakeswap-detector] onLaunch handler failed:', err.message)
      );
    });

    const ws = this.provider.websocket;
    if (ws && typeof ws.on === 'function') {
      ws.on('close', () => {
        console.warn('[pancakeswap-detector] disconnected, reconnecting...');
        setTimeout(() => this.start(), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
      });
      ws.on('error', (err) => {
        console.error('[pancakeswap-detector] websocket error:', err.message);
      });
    }

    console.log('[pancakeswap-detector] connected, watching PairCreated events...');
    this.reconnectDelayMs = 1000;
  }

  async handleEvent(token0, token1, pair) {
    const wbnb = WBNB_ADDRESS.toLowerCase();
    let tokenAddress = null;
    if (token0.toLowerCase() === wbnb) tokenAddress = token1;
    else if (token1.toLowerCase() === wbnb) tokenAddress = token0;
    if (!tokenAddress) return; // not a WBNB pair — skip

    await this.onLaunch({ tokenAddress, pairAddress: pair });
  }
}

module.exports = { PancakeSwapDetector };
