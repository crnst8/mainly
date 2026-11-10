/**
 * The recap: what needs you, what is worth knowing, and what the rest was, for
 * the inbox since a point in time. Written by the model on the server from
 * sender, subject and preview (see backend/src/assist/recap.ts).
 *
 * Every item is a message, so every item opens it. The period is the user's
 * local day, which the server cannot know, so the browser sends its start.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Modal, Segmented, Spinner } from '@/components/ui';
import { getApi } from '@/lib/api';
import { relative } from '@/lib/format';
import { useStore } from '@/lib/store';
import type { Recap as RecapData, RecapItem } from '@/lib/types';
import './recap.css';

type Period = 'today' | 'yesterday' | 'week';

/** Local midnight today, minus `days`. */
function startOf(period: Period): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === 'yesterday') d.setDate(d.getDate() - 1);
  // A day short of the server's seven-day limit, so a clock a little ahead
  // of the server's is never refused.
  if (period === 'week') d.setDate(d.getDate() - 6);
  return d;
}

export function Recap() {
  const setRecap = useStore((s) => s.setRecap);
  const setSettings = useStore((s) => s.setSettings);
  const open = useStore((s) => s.open);
  const [period, setPeriod] = useState<Period>('today');
  const [data, setData] = useState<RecapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const close = useCallback(() => setRecap(false), [setRecap]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await (await getApi()).recap(startOf(period).toISOString());
        if (live) setData(next);
      } catch (e) {
        if (live) {
          setData(null);
          setError(e instanceof Error ? e.message : 'Could not write a recap');
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [period]);

  const go = (item: RecapItem) => {
    close();
    void open(item.id);
  };

  const kinds = Object.entries(data?.kinds ?? {}).filter(([, n]) => n);

  return (
    <Modal title="Recap" onClose={close} width={600}>
      <div className="recap">
        <Segmented<Period>
          ariaLabel="Recap period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'yesterday', label: 'Since yesterday' },
            { value: 'week', label: 'Last 7 days' },
          ]}
        />

        {loading && (
          <div className="recap__loading">
            <Spinner />
          </div>
        )}

        {!loading && error && (
          <div className="recap__error">
            <p className="settings__note settings__note--error">{error}</p>
            {/provider/i.test(error) && (
              <Button size="sm" onClick={() => setSettings('assist')}>
                Settings
              </Button>
            )}
          </div>
        )}

        {!loading && data && (
          <>
            {data.count === 0 ? (
              <p className="recap__summary">No inbox mail in this period.</p>
            ) : (
              data.summary.map((s) => (
                <p key={s} className="recap__summary">
                  {s}
                </p>
              ))
            )}
            <Items title="Needs you" items={data.needs} onOpen={go} />
            <Items title="Worth knowing" items={data.notable} onOpen={go} />
            {kinds.length > 0 && (
              <div className="recap__kinds">
                {kinds.map(([k, n]) => (
                  <span key={k} className="recap__kind">
                    {k} <span className="tnum">{n}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="recap__meta">
              {data.count} messages · {data.model} · {relative(data.generatedAt)}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Items({ title, items, onOpen }: { title: string; items: RecapItem[]; onOpen: (i: RecapItem) => void }) {
  if (!items.length) return null;
  return (
    <section className="recap__section">
      <span className="label">{title}</span>
      <ul className="recap__items">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="recap__item" onClick={() => onOpen(item)}>
              <span className="recap__why">{item.why}</span>
              <span className="recap__from">
                {item.from.name || item.from.address} · {item.subject || '(no subject)'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
