'use client';

import { useEffect, useState, useCallback } from 'react';

const LIME = '#C6FF3D';
const YELLOW = '#FFD23F';
const RED = '#ef4444';
const CARD_BG = '#0d0d0d';
const BORDER = '#262626';

function verdictColor(verdict) {
  if (verdict === 'LOW') return LIME;
  if (verdict === 'MEDIUM') return YELLOW;
  return RED;
}

function truncate(addr) {
  if (!addr) return '';
  return addr.length > 14 ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : addr;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Card({ title, children, right }) {
  return (
    <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 18, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9ca3af', margin: 0 }}>{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: 8,
  background: '#111',
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  color: '#fff',
  fontSize: 13,
  boxSizing: 'border-box',
};

export default function DashboardPage() {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load state');
      setState(data);
      setError('');
      // Only reset the form from server state if the user hasn't got
      // unsaved edits in flight — avoids clobbering input mid-type.
      setForm((prev) => prev || data.config);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setSaveMsg('Saved — takes effect within a few seconds.');
    } catch (err) {
      setSaveMsg(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function togglePaused() {
    const next = !form.paused;
    setForm((f) => ({ ...f, paused: next }));
    await fetch('/api/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: next }),
    });
    load();
  }

  if (error) {
    return (
      <main style={{ maxWidth: 480, margin: '100px auto', padding: '0 20px' }}>
        <h1 style={{ color: RED, fontSize: 18 }}>Couldn't load dashboard</h1>
        <p style={{ color: '#9ca3af', fontSize: 13 }}>{error}</p>
        <p style={{ color: '#6b7280', fontSize: 12 }}>Check SUPABASE_URL / SUPABASE_SERVICE_KEY are set in this project's environment variables.</p>
      </main>
    );
  }

  if (!state || !form) {
    return (
      <main style={{ maxWidth: 480, margin: '100px auto', padding: '0 20px', color: '#9ca3af' }}>
        Loading...
      </main>
    );
  }

  const openPositions = state.positions.filter((p) => p.status === 'open');
  const closedPositions = state.positions.filter((p) => p.status === 'closed');

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '32px 20px 60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, margin: 0, color: LIME }}>Meme Coin Scanner</h1>
          <p style={{ color: '#9ca3af', fontSize: 13, margin: '4px 0 0' }}>Solana + BNB Smart Chain — live control panel</p>
        </div>
        <button
          onClick={togglePaused}
          style={{
            padding: '10px 18px',
            fontSize: 13,
            fontWeight: 700,
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: form.paused ? YELLOW : LIME,
            color: '#000',
          }}
        >
          {form.paused ? '⏸ PAUSED — tap to resume' : '● LIVE — tap to pause'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 18 }}>
        {[
          ['Solana', form.enable_solana ? 'ON' : 'OFF'],
          ['BSC', form.enable_bsc ? 'ON' : 'OFF'],
          ['Min tier', form.min_recommend_tier],
          ['Daily quota', `${form.max_tokens_per_day}/day`],
        ].map(([label, value]) => (
          <div key={label} style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      <Card title="Live filters">
        <form onSubmit={handleSave}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            <Field label="Chains">
              <div style={{ display: 'flex', gap: 16 }}>
                <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={form.enable_solana} onChange={(e) => setForm({ ...form, enable_solana: e.target.checked })} />
                  Solana
                </label>
                <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={form.enable_bsc} onChange={(e) => setForm({ ...form, enable_bsc: e.target.checked })} />
                  BSC
                </label>
              </div>
            </Field>

            <Field label="Minimum tier to recommend">
              <select
                value={form.min_recommend_tier}
                onChange={(e) => setForm({ ...form, min_recommend_tier: e.target.value })}
                style={inputStyle}
              >
                <option value="LOW">LOW only</option>
                <option value="LOW_MEDIUM">LOW + MEDIUM</option>
              </select>
            </Field>

            <Field label="Max tokens/day">
              <input
                type="number"
                min="1"
                value={form.max_tokens_per_day}
                onChange={(e) => setForm({ ...form, max_tokens_per_day: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>

            <Field label="Max dev holding %">
              <input
                type="number"
                value={form.max_dev_percent}
                onChange={(e) => setForm({ ...form, max_dev_percent: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>

            <Field label="Max top-10 holder %">
              <input
                type="number"
                value={form.max_top10_percent}
                onChange={(e) => setForm({ ...form, max_top10_percent: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>

            <Field label="Solana: capital % / trade">
              <input
                type="number"
                value={form.capital_pct}
                onChange={(e) => setForm({ ...form, capital_pct: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>

            <Field label="Solana: max SOL / trade">
              <input
                type="number"
                step="0.01"
                value={form.max_position_sol}
                onChange={(e) => setForm({ ...form, max_position_sol: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>

            <Field label="BSC: capital % / trade">
              <input
                type="number"
                value={form.bsc_capital_pct}
                onChange={(e) => setForm({ ...form, bsc_capital_pct: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>

            <Field label="BSC: max BNB / trade">
              <input
                type="number"
                step="0.01"
                value={form.bsc_max_position_bnb}
                onChange={(e) => setForm({ ...form, bsc_max_position_bnb: Number(e.target.value) })}
                style={inputStyle}
              />
            </Field>
          </div>

          <button
            type="submit"
            disabled={saving}
            style={{
              marginTop: 16,
              padding: '10px 20px',
              fontSize: 13,
              fontWeight: 700,
              background: LIME,
              color: '#000',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            {saving ? 'Saving...' : 'Save filters'}
          </button>
          {saveMsg && <span style={{ marginLeft: 12, fontSize: 12, color: saveMsg.startsWith('Error') ? RED : LIME }}>{saveMsg}</span>}
        </form>
      </Card>

      <Card title={`Open positions (${openPositions.length})`}>
        {openPositions.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>None right now.</p>
        ) : (
          <PositionsTable rows={openPositions} />
        )}
      </Card>

      <Card title="Recent closed positions">
        {closedPositions.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>None yet.</p>
        ) : (
          <PositionsTable rows={closedPositions.slice(0, 15)} showPnl />
        )}
      </Card>

      <Card title="Recent findings">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 500, overflowY: 'auto' }}>
          {state.assessments.map((a) => (
            <div key={a.id} style={{ borderLeft: `3px solid ${verdictColor(a.verdict)}`, paddingLeft: 12, paddingBottom: 8, borderBottom: `1px solid ${BORDER}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>
                  <strong style={{ color: verdictColor(a.verdict) }}>{a.verdict}</strong>
                  {a.recommended && <span style={{ color: LIME, marginLeft: 6 }}>★ RECOMMENDED</span>}
                  <span style={{ color: '#9ca3af', marginLeft: 8 }}>{a.chain}</span>
                  <span style={{ color: '#6b7280', marginLeft: 8, fontFamily: 'monospace' }}>{truncate(a.address)}</span>
                </span>
                <span style={{ color: '#6b7280', fontSize: 11 }}>{timeAgo(a.created_at)}</span>
              </div>
              {a.category && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>category: {a.category}</div>}
              {Array.isArray(a.reasons) && a.reasons.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12, color: '#9ca3af' }}>
                  {a.reasons.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>
    </main>
  );
}

function PositionsTable({ rows, showPnl }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#9ca3af', fontSize: 11 }}>
          <th style={{ padding: '6px 8px' }}>Chain</th>
          <th style={{ padding: '6px 8px' }}>Address</th>
          <th style={{ padding: '6px 8px' }}>Size</th>
          {showPnl && <th style={{ padding: '6px 8px' }}>PnL</th>}
          <th style={{ padding: '6px 8px' }}>{showPnl ? 'Closed' : 'Opened'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} style={{ borderTop: `1px solid ${BORDER}` }}>
            <td style={{ padding: '6px 8px' }}>{p.chain}{p.dry_run && <span style={{ color: '#6b7280' }}> (dry)</span>}</td>
            <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{truncate(p.address)}</td>
            <td style={{ padding: '6px 8px' }}>{p.size_native}</td>
            {showPnl && (
              <td style={{ padding: '6px 8px', color: p.pnl_pct >= 0 ? LIME : RED }}>
                {p.pnl_pct != null ? `${p.pnl_pct.toFixed(1)}%` : '—'}
              </td>
            )}
            <td style={{ padding: '6px 8px', color: '#9ca3af' }}>{timeAgo(showPnl ? p.closed_at : p.opened_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
