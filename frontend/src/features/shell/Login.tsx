/**
 * Sign-in.
 *
 * Shown only when the API answers 401. In mock mode it never appears, which is
 * why the rest of the app can be built and demoed without it.
 *
 * There is no "create account" link: this app has no open registration. Users
 * are created by the operator (`./dev.sh user <email>`), because every user of
 * a self-hosted mail client is, by definition, its operator.
 */

import { useState } from 'react';
import { Button, Field, Spinner } from '@/components/ui';
import './login.css';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base = import.meta.env.VITE_API_BASE ?? '/api';
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error?.message ?? 'Sign-in failed');
      }
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__panel" onSubmit={submit}>
        <div className="login__mark">mainly</div>
        <p className="login__sub">All of your addresses, in one place.</p>

        <Field label="Email">
          <input
            className="input input--mono"
            type="email"
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Password" error={error}>
          <input
            className={`input ${error ? 'input--invalid' : ''}`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Button variant="primary" block type="submit" disabled={busy || !email || !password}>
          {busy ? <Spinner /> : null}
          Sign in
        </Button>
      </form>
    </div>
  );
}
