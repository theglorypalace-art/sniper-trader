const { ethers } = require('ethers');
const { BSC_WSS_URL, PANCAKESWAP_FACTORY, WBNB_ADDRESS } = require('../config');
const runtime = require('../live/runtime');

const STALL_MS = Number(process.env.DETECTOR_STALL_MS || 60000);

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
    this.restarting = false;
    this.lastBlockAt = Date.now();
    this.connectStartedAt = Date.now();
    this.watchdog = null;
  }

  // BSC produces a block roughly every second, so a long gap in blocks means
  // the socket has silently died (PairCreated events alone are too irregular
  // to use as a heartbeat).
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (this.restarting) return;
      const silentFor = Date.now() - this.lastBlockAt;
      if (silentFor > STALL_MS) {
        runtime.setDetector('bsc', 'stalled');
        try {
          require('../telegram/bot').notify('⚠️ BSC feed went silent — reconnecting automatically.');
        } catch (_) {
          /* telegram is optional */
        }
        this.restart(`no blocks for ${Math.round(silentFor / 1000)}s`);
      }
    }, Math.min(15000, Math.max(1000, STALL_MS / 4)));
    if (this.watchdog.unref) this.watchdog.unref();
  }

  restart(reason) {
    if (this.restarting) return;
    this.restarting = true;
    console.warn(`[pancakeswap-detector] ${reason} — reconnecting...`);
    runtime.setDetector('bsc', 'reconnecting');
    try {
      if (this.provider) this.provider.destroy();
    } catch (_) {
      /* already closed */
    }
    setTimeout(() => {
      this.restarting = false;
      this.start();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
  }

  start() {
    runtime.setDetector('bsc', 'connecting');
    this.lastBlockAt = Date.now();
    this.connectStartedAt = Date.now();
    this.provider = new ethers.WebSocketProvider(BSC_WSS_URL);
    this.contract = new ethers.Contract(PANCAKESWAP_FACTORY, FACTORY_ABI, this.provider);
    this.startWatchdog();

    this.contract.on('PairCreated', (token0, token1, pair) => {
      this.handleEvent(token0, token1, pair).catch((err) =>
        console.error('[pancakeswap-detector] onLaunch handler failed:', err.message)
      );
    });

    // Heartbeat: every new block proves the feed is alive.
    this.provider.on('block', () => {
      this.lastBlockAt = Date.now();
      this.reconnectDelayMs = 1000;
      runtime.setDetector('bsc', 'connected'); // also refreshes "last event"
    });

    const ws = this.provider.websocket;
    if (ws && typeof ws.on === 'function') {
      ws.on('close', () => this.restart('disconnected'));
      ws.on('error', (err) => {
        console.error('[pancakeswap-detector] websocket error:', err.message);
      });
    }

    console.log('[pancakeswap-detector] connected, watching PairCreated events...');
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
