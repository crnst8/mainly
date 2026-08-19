import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/features/shell/AppShell';
import { DemoBadge } from '@/features/shell/DemoBadge';
import { Login } from '@/features/shell/Login';
import { useStore } from '@/lib/store';
import { Empty, Spinner } from '@/components/ui';

/* Constant-folded: in every build that is not the hosted demo this is `false`,
   and the bundler drops DemoBadge and its stylesheet entirely. */
const IS_DEMO = import.meta.env.VITE_DEMO === '1';

export default function App() {
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const accounts = useStore((s) => s.accounts);
  const boot = useStore((s) => s.boot);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void boot();
  }, [boot, attempt]);

  const retry = useCallback(() => {
    useStore.setState({ ready: false, error: null });
    setAttempt((n) => n + 1);
  }, []);

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <Spinner />
      </div>
    );
  }

  // A 401 means "not signed in", not "broken". Everything else is an outage.
  if (error && /unauthorized|not signed in|session expired/i.test(error)) {
    return <Login onSignedIn={retry} />;
  }

  if (error && !accounts.length) {
    return (
      <Empty
        title="Cannot reach the server"
        body={error}
        action={
          <button type="button" className="btn btn--outline" onClick={retry}>
            Retry
          </button>
        }
      />
    );
  }

  return (
    <>
      <AppShell />
      {IS_DEMO && <DemoBadge />}
    </>
  );
}
