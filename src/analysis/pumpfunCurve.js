const { PublicKey } = require('@solana/web3.js');
const { PUMPFUN_PROGRAM_ID } = require('../config');
const { getConnection } = require('../solana/wallet');

// Official constant from pump-fun/pump-public-docs (PUMP_PROGRAM_README.md):
// every bonding curve is initialized with real_token_reserves = 793,100,000,000,000
// raw units. Progress toward migration is how far real_token_reserves has
// dropped from that starting point. This is pump.fun's own documented
// value as of this build — if pump.fun changes their curve parameters,
// this constant (and the account layout below) would need updating.
const INITIAL_REAL_TOKEN_RESERVES = 793100000000000n;

function deriveBondingCurvePda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMPFUN_PROGRAM_ID)
  );
  return pda;
}

// Account layout per pump-fun/pump-public-docs: 8-byte discriminator,
// then virtual_token_reserves, virtual_sol_reserves, real_token_reserves,
// real_sol_reserves, token_total_supply (all u64 LE), then complete (bool).
// Verify this against a live account on Solscan if parsing ever looks off
// — pump.fun has added fields to this account in past protocol upgrades
// (e.g. a "creator" field), so a version mismatch is a real possibility.
function parseBondingCurve(data) {
  let offset = 8;
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) === 1;
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
}

// Returns null if the account doesn't exist (token isn't a pump.fun coin,
// or the mint is wrong) rather than throwing — callers should treat that
// as "couldn't verify curve status", not as an error.
async function getBondingCurveState(mint) {
  const connection = getConnection();
  const pda = deriveBondingCurvePda(mint);
  const account = await connection.getAccountInfo(pda);
  if (!account) return null;
  return parseBondingCurve(account.data);
}

// 0-100. Returns 100 once migrated (complete=true), since there's no more
// curve left to progress through at that point.
function curveProgressPct(state) {
  if (!state) return null;
  if (state.complete) return 100;
  const remaining = Number(state.realTokenReserves);
  const initial = Number(INITIAL_REAL_TOKEN_RESERVES);
  const pct = (1 - remaining / initial) * 100;
  return Math.max(0, Math.min(100, pct));
}

module.exports = {
  deriveBondingCurvePda,
  getBondingCurveState,
  curveProgressPct,
  INITIAL_REAL_TOKEN_RESERVES,
};
