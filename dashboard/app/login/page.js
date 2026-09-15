'use client';

import { useState } from 'react';

const LIME = '#C6FF3D';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      window.location.href = '/';
    } else {
      setError('Incorrect password.');
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '100px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4, color: LIME }}>Meme Coin Scanner</h1>
      <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 24 }}>Enter the dashboard password to continue.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            padding: 12,
            fontSize: 14,
            boxSizing: 'border-box',
            marginBottom: 12,
            background: '#111',
            border: '1px solid #333',
            borderRadius: 6,
            color: '#fff',
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: 12,
            fontSize: 14,
            fontWeight: 600,
            background: LIME,
            color: '#000',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          {loading ? 'Checking...' : 'Enter'}
        </button>
        {error && <p style={{ color: '#FFD23F', marginTop: 12, fontSize: 13 }}>{error}</p>}
      </form>
    </main>
  );
}
