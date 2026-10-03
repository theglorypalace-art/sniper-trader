const WebSocket = require('ws');
const { PublicKey } = require('@solana/web3.js');
const { HELIUS_WSS_URL, PUMPFUN_PROGRAM_ID } = require('../config');
const { getConnection } = require('../solana/wallet');
const runtime = require('../live/runtime');
const { LAUNCHPADS, matchLaunchpad, enabledLaunchpads } = require('./launchpads');
const { getConfig } = require('../live/liveConfig');

// Quiet feed → reconnect. Keep this generous; multi-pad can be bursty.
const STALL_MS = Number(process.env.DETECTOR_STALL_MS || 180000);
const CONNECT_TIMEOUT_MS = 20000;
// Poll is a FALLBACK only — keep sparse to avoid Helius 429s.
const POLL_MS = Number(process.env.DETECTOR_POLL_MS || 60000);
const PING_MS = 45000;
const POLL_SIG_LIMIT = Number(process.env.DETECTOR_POLL_SIG_LIMIT || 5);
const POLL_TX_BUDGET = Number(process.env.DETECTOR_POLL_TX_BUDGET || 2); // max getParsedTransaction per cycle


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

function looksLikeCreate(logs) {
  if (!logs || !logs.length) return false;
  return logs.some((l) =>
    /Instruction:\s*(Create|CreateV2|Initialize|InitializeV2|InitializeWithToken2022|TokenMint)/i.test(String(l))
  );
}

/**
 * Multi-launchpad detector: WebSocket logsSubscribe + RPC poll fallback.
 * Poll keeps finding pump creates even when WSS flaps.
 */
class PumpFunDetector {
  constructor(onLaunch) {
    this.onLaunch = onLaunch;
    this.ws = null;
    this.reconnectDelayMs = 1000;
    this.lastMsgAt = Date.now();
    this.connectStartedAt = Date.now();
    this.watchdog = null;
    this.pingTimer = null;
    this.pollTimer = null;
    this.starting = false;
    this.seenSigs = new Set();
    this.seenMint = new Set();
    this.subReqToProgram = new Map();
    this.nextReqId = 1;
    this._closedOnPurpose = false;
  }

  touch() {
    this.lastMsgAt = Date.now();
    runtime.touch('solana');
  }

  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      const silentFor = Date.now() - this.lastMsgAt;
      const stalledOpen = ws.readyState === WebSocket.OPEN && silentFor > STALL_MS;
      const stuckConnecting =
        ws.readyState === WebSocket.CONNECTING && Date.now() - this.connectStartedAt > CONNECT_TIMEOUT_MS;
      if (!stalledOpen && !stuckConnecting) return;

      console.warn(
        `[launchpad-detector] feed stalled (${Math.round(silentFor / 1000)}s) — reconnecting WSS (poll keeps running)`
      );
      runtime.setDetector('solana', 'stalled');
      this._closedOnPurpose = true;
      try {
        ws.terminate();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
      this.scheduleReconnect();
    }, 15000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  startPing() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch (_) {
        /* ignore */
      }
    }, PING_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  startPoll() {
    if (this.pollTimer) return;
    this._pollCycle = 0;
    this._pollBackoffUntil = 0;
    const tick = async () => {
      if (Date.now() < this._pollBackoffUntil) return;
      // Prefer WSS: if we got a message recently, skip RPC poll entirely
      const wsOk =
        this.ws &&
        this.ws.readyState === WebSocket.OPEN &&
        Date.now() - this.lastMsgAt < Math.min(STALL_MS, 90000);
      if (wsOk) return;

      try {
        this._pollCycle += 1;
        // Always poll pump (volume). Other pads only every 3rd cycle.
        await this.pollProgram(
          PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          'pump.fun'
        );
        if (this._pollCycle % 3 === 0) {
          const pads = enabledLaunchpads(getConfig()).filter((p) => p.id !== 'pumpfun');
          // At most one extra pad per cycle
          const pad = pads[this._pollCycle % Math.max(pads.length, 1)];
          if (pad) await this.pollProgram(pad.programId, pad.name);
        }
      } catch (err) {
        const msg = String(err.message || err);
        if (/429|Too Many|rate limit/i.test(msg)) {
          this._pollBackoffUntil = Date.now() + 120000;
          console.warn('[launchpad-detector] RPC 429 — pausing poll 2 minutes');
        } else {
          console.warn('[launchpad-detector] poll error:', msg.slice(0, 200));
        }
      }
    };
    // First poll after a delay so boot does not stampede RPC
    setTimeout(tick, 15000);
    this.pollTimer = setInterval(tick, POLL_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  async pollProgram(programId, name) {
    const connection = getConnection();
    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(
        new PublicKey(programId),
        { limit: POLL_SIG_LIMIT },
        'confirmed'
      );
    } catch (err) {
      if (/Invalid|public key/i.test(err.message)) return;
      if (/429|Too Many|rate limit/i.test(err.message)) throw err;
      throw err;
    }
    if (!sigs || !sigs.length) return;
    this.touch();
    if (runtime.snapshot().chains.solana.detector !== 'connected') {
      runtime.setDetector('solana', 'connected');
    }

    let txBudget = POLL_TX_BUDGET;
    for (const s of sigs) {
      if (!s || !s.signature || s.err) continue;
      if (this.seenSigs.has(s.signature)) continue;
      this.seenSigs.add(s.signature);
      if (this.seenSigs.size > 1500) {
        const drop = [...this.seenSigs].slice(0, 400);
        for (const d of drop) this.seenSigs.delete(d);
      }
      if (s.blockTime && Date.now() / 1000 - s.blockTime > 120) continue;
      if (txBudget <= 0) break;
      txBudget -= 1;

      try {
        const mint = await resolveLaunchedMint(s.signature);
        if (!mint || this.seenMint.has(mint)) continue;
        this.seenMint.add(mint);
        const pad = enabledLaunchpads(getConfig()).find((p) => p.programId === programId) || {
          id: 'unknown',
          name: name || 'unknown',
        };
        console.log(`[launchpad-detector] poll new token on ${pad.name}: ${mint}`);
        await this.onLaunch({
          signature: s.signature,
          mint,
          launchpad: pad.id,
          launchpadName: pad.name,
          via: 'poll',
        });
      } catch (err) {
        if (/429|Too Many|rate limit/i.test(err.message)) throw err;
        console.warn(`[launchpad-detector] poll handle:`, err.message.slice(0, 120));
      }
    }
  }

  scheduleReconnect() {
    if (this.starting) return;
    runtime.setDetector('solana', 'reconnecting');
    setTimeout(() => this.start(), this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
  }

  start() {
    if (this.starting) return;
    this.starting = true;
    this._closedOnPurpose = false;

    try {
      if (this.ws) {
        try {
          this.ws.removeAllListeners();
          this.ws.terminate();
        } catch (_) {
          /* ignore */
        }
        this.ws = null;
      }

      runtime.setDetector('solana', 'connecting');
      this.connectStartedAt = Date.now();
      this.touch();
      this.subReqToProgram.clear();
      this.nextReqId = 1;

      const url = String(HELIUS_WSS_URL || '').trim();
      if (!url || url.includes('api-key=') && url.endsWith('api-key=')) {
        console.error('[launchpad-detector] HELIUS_API_KEY missing or empty — WSS cannot connect. Poll may still work if RPC key is set.');
      }

      this.ws = new WebSocket(url);
      this.startWatchdog();
      this.startPing();
      this.startPoll();

      this.ws.on('open', () => {
        this.starting = false;
        this.reconnectDelayMs = 1000;
        this.touch();
        runtime.setDetector('solana', 'connected');

        const pads = enabledLaunchpads(getConfig());
        // Always include pump if list empty
        const list = pads.length ? pads : LAUNCHPADS.filter((p) => p.id === 'pumpfun');
        console.log(
          `[launchpad-detector] WSS open — subscribing to ${list.map((p) => p.name).join(', ') || 'pump.fun'}`
        );

        for (const pad of list) {
          const id = this.nextReqId++;
          this.subReqToProgram.set(id, pad.programId);
          try {
            this.ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'logsSubscribe',
                params: [{ mentions: [pad.programId] }, { commitment: 'confirmed' }],
              })
            );
          } catch (err) {
            console.error('[launchpad-detector] subscribe send failed:', err.message);
          }
        }
      });

      this.ws.on('message', (raw) => {
        this.touch();
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.error) {
          console.error('[launchpad-detector] RPC error:', JSON.stringify(msg.error).slice(0, 300));
          return;
        }

        // subscription ack
        if (msg.id != null && msg.result != null && this.subReqToProgram.has(msg.id)) {
          console.log(`[launchpad-detector] subscribed ok (req ${msg.id})`);
          return;
        }

        if (msg.method !== 'logsNotification') return;

        const value = msg.params && msg.params.result && msg.params.result.value;
        if (!value) return;
        const logs = value.logs;
        const signature = value.signature;
        if (!logs || !signature) return;
        if (this.seenSigs.has(signature)) return;

        if (!looksLikeCreate(logs)) return;

        this.seenSigs.add(signature);
        const active = enabledLaunchpads(getConfig());
        let pad = null;
        for (const candidate of active) {
          pad = matchLaunchpad(logs, candidate.programId);
          if (pad) break;
        }
        if (!pad) {
          pad = active[0] || { id: 'unknown', name: 'unknown launchpad', programId: null };
        }

        this.handleLaunch(signature, pad).catch((err) =>
          console.error(`[launchpad-detector] onLaunch failed (${pad.name}):`, err.message)
        );
      });

      this.ws.on('pong', () => this.touch());

      this.ws.on('close', (code, reason) => {
        this.starting = false;
        console.warn(
          `[launchpad-detector] WSS closed code=${code} reason=${(reason && reason.toString()) || ''} — poll continues`
        );
        this.ws = null;
        if (this._closedOnPurpose) {
          this._closedOnPurpose = false;
          return; // scheduleReconnect already called
        }
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[launchpad-detector] WSS error:', err.message);
      });
    } catch (err) {
      this.starting = false;
      console.error('[launchpad-detector] start failed:', err.message);
      this.scheduleReconnect();
    }
  }

  async handleLaunch(signature, pad) {
    if (this.seenSigs.has(signature) && this.seenMint.size) {
      // already marked in message handler
    }
    const mint = await resolveLaunchedMint(signature);
    if (!mint) {
      console.warn(`[launchpad-detector] could not resolve mint for ${signature} (${pad.name})`);
      return;
    }
    if (this.seenMint.has(mint)) return;
    this.seenMint.add(mint);
    console.log(`[launchpad-detector] new token on ${pad.name}: ${mint}`);
    await this.onLaunch({
      signature,
      mint,
      launchpad: pad.id,
      launchpadName: pad.name,
      via: 'wss',
    });
  }
}

module.exports = { PumpFunDetector, resolveLaunchedMint };
