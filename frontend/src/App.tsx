import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/features/shell/AppShell';
import { Login } from '@/features/shell/Login';
import { MobileShell } from '@/features/mobile/MobileShell';
import { useIsMobile } from '@/lib/media';
import { useStore } from '@/lib/store';
import { Empty, Spinner } from '@/components/ui';

export default function App() {
  const isMobile = useIsMobile();
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

  return isMobile ? <MobileShell /> : <AppShell />;
}
