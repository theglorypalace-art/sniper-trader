const WebSocket = require('ws');
const { HELIUS_WSS_URL, PUMPFUN_PROGRAM_ID } = require('../config');
const { getConnection } = require('../solana/wallet');
const runtime = require('../live/runtime');

// pump.fun's program-log stream carries every trade, so it is never quiet for
// long. If nothing at all arrives for this long, the socket has silently died
// (they can stall without ever raising a 'close' event) — force a reconnect.
const STALL_MS = Number(process.env.DETECTOR_STALL_MS || 60000);
const CONNECT_TIMEOUT_MS = 30000;

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
    this.lastMsgAt = Date.now();
    this.connectStartedAt = Date.now();
    this.watchdog = null;
  }

  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      const silentFor = Date.now() - this.lastMsgAt;
      const stalledOpen = ws.readyState === WebSocket.OPEN && silentFor > STALL_MS;
      const stuckConnecting = ws.readyState === WebSocket.CONNECTING && Date.now() - this.connectStartedAt > CONNECT_TIMEOUT_MS;
      if (!stalledOpen && !stuckConnecting) return;

      console.warn(`[pumpfun-detector] feed stalled (${Math.round(silentFor / 1000)}s of silence) — forcing reconnect`);
      runtime.setDetector('solana', 'stalled');
      try {
        require('../telegram/bot').notify('⚠️ Solana feed went silent — reconnecting automatically.');
      } catch (_) {
        /* telegram is optional */
      }
      this.lastMsgAt = Date.now(); // don't re-trigger before the reconnect completes
      try {
        ws.terminate(); // fires 'close' -> the reconnect below
      } catch (_) {
        /* already gone */
      }
    }, Math.min(15000, Math.max(1000, STALL_MS / 4)));
    if (this.watchdog.unref) this.watchdog.unref();
  }

  start() {
    runtime.setDetector('solana', 'connecting');
    this.connectStartedAt = Date.now();
    this.lastMsgAt = Date.now();
    this.ws = new WebSocket(HELIUS_WSS_URL);
    this.startWatchdog();

    this.ws.on('open', () => {
      console.log('[pumpfun-detector] connected, subscribing to program logs...');
      runtime.setDetector('solana', 'connected');
      this.lastMsgAt = Date.now();
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
      this.lastMsgAt = Date.now();
      runtime.touch('solana');
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
      runtime.setDetector('solana', 'reconnecting');
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
