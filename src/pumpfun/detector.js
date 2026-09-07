const WebSocket = require('ws');
const { HELIUS_WSS_URL, PUMPFUN_PROGRAM_ID } = require('../config');
const { getConnection } = require('../solana/wallet');

// Fetches the full transaction and finds the mint address that's new in
// this transaction (present in postTokenBalances but not preTokenBalances).
// This is more robust than hardcoding pump.fun's account ordering, which
// could change with protocol upgrades.
async function resolveLaunchedMint(signature) {
  const connection = getConnection();
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx || !tx.meta) return null;

  const preMints = new Set((tx.meta.preTokenBalances || []).map((b) => b.mint));
  const postMints = (tx.meta.postTokenBalances || []).map((b) => b.mint);
  const newMint = postMints.find((m) => !preMints.has(m));
  return newMint || null;
}

// Subscribes to pump.fun's on-chain program logs and calls onLaunch(info)
// for every new token creation event seen. This is a best-effort log
// parser — pump.fun's exact log format can change with protocol upgrades,
// so treat the parsing logic here as something to verify/adjust against
// real, current transactions before relying on it.
class PumpFunDetector {
  constructor(onLaunch) {
    this.onLaunch = onLaunch;
    this.ws = null;
    this.reconnectDelayMs = 1000;
  }

  start() {
    this.ws = new WebSocket(HELIUS_WSS_URL);

    this.ws.on('open', () => {
      console.log('[pumpfun-detector] connected, subscribing to program logs...');
      this.reconnectDelayMs = 1000;
      this.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: 'confirmed' }],
        })
      );
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== 'logsNotification') return;

      const result = msg.params && msg.params.result;
      const logs = result && result.value && result.value.logs;
      const signature = result && result.value && result.value.signature;
      if (!logs) return;

      // pump.fun's "create" instruction emits a log line containing
      // "Instruction: Create". Verify this string against a real recent
      // transaction on a Solana explorer before depending on it in
      // production — log wording is not a stable public API.
      const isCreate = logs.some((l) => l.includes('Instruction: Create'));
      if (!isCreate) return;

      this.handleLaunch(signature).catch((err) =>
        console.error('[pumpfun-detector] onLaunch handler failed:', err.message)
      );
    });

    this.ws.on('close', () => {
      console.warn('[pumpfun-detector] disconnected, reconnecting...');
      setTimeout(() => this.start(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    });

    this.ws.on('error', (err) => {
      console.error('[pumpfun-detector] websocket error:', err.message);
    });
  }

  async handleLaunch(signature) {
    const mint = await resolveLaunchedMint(signature);
    if (!mint) {
      console.warn(`[pumpfun-detector] could not resolve mint for signature ${signature}`);
      return;
    }
    await this.onLaunch({ signature, mint });
  }
}

module.exports = { PumpFunDetector, resolveLaunchedMint };
