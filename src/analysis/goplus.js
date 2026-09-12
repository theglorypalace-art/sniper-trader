// Thin wrapper around GoPlus Security's public Token Security API.
// https://docs.gopluslabs.io — no API key is required for light usage,
// but you are rate-limited (roughly ~30 req/min as of writing). If you
// outgrow that, GoPlus supports an authenticated access-token flow for a
// higher limit; add it here if/when you need it.
//
// GoPlus is a third-party aggregator, not the source of truth — treat a
// failed/empty lookup as "unknown", not as "safe". The risk engine in
// riskEngine.js scores conservatively when this returns nothing useful.

const GOPLUS_BASE = 'https://api.gopluslabs.io';
const BSC_CHAIN_ID = '56';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GoPlus request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// EVM token security (chainId "56" = BNB Smart Chain).
// https://docs.gopluslabs.io/reference/tokensecurityusingget_1
async function getEvmTokenSecurity(address, chainId = BSC_CHAIN_ID) {
  const url = `${GOPLUS_BASE}/api/v1/token_security/${chainId}?contract_addresses=${address}`;
  const data = await fetchJson(url);
  if (data.code !== 1) throw new Error(`GoPlus error (code ${data.code}): ${data.message}`);
  const result = data.result || {};
  return result[address.toLowerCase()] || null;
}

// Solana token security (beta endpoint — GoPlus itself labels this beta,
// so expect rougher edges/coverage than the mature EVM endpoint).
// https://docs.gopluslabs.io/reference/solanatokensecurityusingget
async function getSolanaTokenSecurity(mint) {
  const url = `${GOPLUS_BASE}/api/v1/solana/token_security?contract_addresses=${mint}`;
  const data = await fetchJson(url);
  if (data.code !== 1) throw new Error(`GoPlus error (code ${data.code}): ${data.message}`);
  const result = data.result || {};
  return result[mint] || null;
}

module.exports = { getEvmTokenSecurity, getSolanaTokenSecurity, BSC_CHAIN_ID };
