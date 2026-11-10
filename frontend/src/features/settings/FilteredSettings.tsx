/**
 * The Filtered folder: whether it files on arrival, how readily, whether it
 * asks the model, what it has worked out about the user's filing, and the
 * senders and lists it has learned. The provider and model are chosen under
 * Assist, which every model task shares.
 *
 * Preferences are saved like every other setting. What the filter learned is
 * not a preference — it is the record of what the user filed — so it is read
 * from the server and changed only by forgetting a source.
 */

import { useEffect, useState } from 'react';
import { Button, IconButton, Row, Segmented, Spinner, Toggle } from '@/components/ui';
import { Trash } from '@/components/icons';
import { getApi } from '@/lib/api';
import { relative } from '@/lib/format';
import { useStore } from '@/lib/store';
import type { FilterPreferences, FilterSensitivity, FilterSource, FilterStatus } from '@/lib/types';
import { AccountChecklist } from './Notifications';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function FilteredSettings() {
  const f = useStore((s) => s.prefs!.filtering);
  const savePrefs = useStore((s) => s.savePrefs);
  const resync = useStore((s) => s.resync);
  const setSettings = useStore((s) => s.setSettings);
  const set = (patch: Partial<FilterPreferences>) => void savePrefs({ filtering: { ...f, ...patch } });

  const [status, setStatus] = useState<FilterStatus | null>(null);
  const [busy, setBusy] = useState<'sweep' | 'profile' | null>(null);
  const [swept, setSwept] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = async () => {
    try {
      const next = await (await getApi()).filterStatus();
      setStatus(next);
      return next;
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not read the filter');
      return null;
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  async function sweep() {
    setBusy('sweep');
    setFailure(null);
    try {
      const { filed } = await (await getApi()).sweepFiltered();
      setSwept(filed);
      await resync();
      await reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not file inbox mail');
    } finally {
      setBusy(null);
    }
  }

  async function rebuildProfile() {
    setBusy('profile');
    setFailure(null);
    let failed: string | null = null;
    try {
      await (await getApi()).rebuildFilterProfile();
    } catch (e) {
      failed = e instanceof Error ? e.message : 'Could not rebuild the profile';
    }
    const next = await reload();
    // A failure the server recorded shows on the row itself; only one it
    // could not record (the request never arrived) needs the note.
    if (failed && !next?.profile?.error) setFailure(failed);
    setBusy(null);
  }

  async function forget(source: FilterSource) {
    setFailure(null);
    try {
      await (await getApi()).forgetFilterSource(source);
      await reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not forget this source');
    }
  }

  const llm = status?.llm;
  const filtered = status?.sources.filter((s) => s.verdict === 'filter') ?? [];
  const kept = status?.sources.filter((s) => s.verdict === 'keep') ?? [];

  return (
    <>
      <section className="settings__section">
        <Row title="Filter new mail" desc="Into Filtered under each inbox">
          <Toggle label="Filter new mail" checked={f.enabled} onChange={(enabled) => set({ enabled })} />
        </Row>
        {f.enabled && (
          <>
            <Row title="Learn" desc="Mail like what you filtered, from any sender">
              <Toggle label="Learn from filtered mail" checked={f.learn} onChange={(learn) => set({ learn })} />
            </Row>
            <Row title="Sensitivity">
              <Segmented<FilterSensitivity>
                ariaLabel="How readily the filter files"
                value={f.sensitivity}
                onChange={(sensitivity) => set({ sensitivity })}
                options={[
                  { value: 'cautious', label: 'Cautious', hint: 'Files at 97% certainty' },
                  { value: 'balanced', label: 'Balanced', hint: 'Files at 92% certainty' },
                  { value: 'eager', label: 'Eager', hint: 'Files at 85% certainty' },
                ]}
              />
            </Row>
            <Row title="Inbox mail from filtered senders">
              <Button size="sm" disabled={busy !== null} onClick={() => void sweep()}>
                {busy === 'sweep' ? <Spinner /> : null}
                {swept === null ? 'File now' : `Filed ${swept}`}
              </Button>
            </Row>
          </>
        )}
        {failure && <p className="settings__note settings__note--error">{failure}</p>}
      </section>

      {f.enabled && status && (
        <section className="settings__section">
          <div className="settings__sectionhead">
            <span className="label">Learned</span>
          </div>
          <Row
            title="Examples"
            desc={`${status.examples.filter} filtered · ${status.examples.keep} taken back${status.observed ? ` · ${status.observed} filed elsewhere` : ''}`}
          >
            <span className="tnum">{status.trained ? 'Trained' : 'Rules only'}</span>
          </Row>
          <Row
            title="Filed by itself"
            desc={`Last 60 days · ${status.rescued} taken back`}
          >
            <span className="tnum">{status.autoFiled}</span>
          </Row>
          {status.trained && (
            <Row title="Certainty needed">
              <span className="tnum">{pct(status.threshold)}</span>
            </Row>
          )}
        </section>
      )}

      {f.enabled && llm && (
        <section className="settings__section">
          <div className="settings__sectionhead">
            <span className="label">Language model</span>
          </div>
          <Row
            title="Ask a model when unsure"
            desc={llm.available ? `Sends sender, subject and preview to ${llm.host}` : undefined}
          >
            {llm.available ? (
              <Toggle label="Ask a language model when unsure" checked={f.llm} onChange={(on) => set({ llm: on })} />
            ) : (
              <Button size="sm" onClick={() => setSettings('assist')}>
                Add a model
              </Button>
            )}
          </Row>
          {llm.available && f.llm && (
            <>
              <Row
                title="What you filter"
                desc={
                  status.profile?.builtAt
                    ? `From ${status.profile.basis} messages · ${relative(status.profile.builtAt)}`
                    : (status.profile?.error ?? undefined)
                }
              >
                <Button size="sm" disabled={busy !== null} onClick={() => void rebuildProfile()}>
                  {busy === 'profile' ? <Spinner /> : null}
                  {status.profile?.builtAt ? 'Rebuild' : 'Build'}
                </Button>
              </Row>
              {status.profile?.builtAt && status.profile.error && (
                <p className="settings__note settings__note--error">{status.profile.error}</p>
              )}
              {status.profile?.builtAt && (
                <div className="filter-profile">
                  <ProfileLines title="Filtered" lines={status.profile.filter} />
                  <ProfileLines title="Kept" lines={status.profile.keep} />
                </div>
              )}
            </>
          )}
        </section>
      )}

      {f.enabled && <Sources title="Filtered senders and lists" sources={filtered} onForget={forget} />}
      {f.enabled && <Sources title="Kept in the inbox" sources={kept} onForget={forget} />}

      {f.enabled && (
        <AccountChecklist
          title="Filter in"
          ariaVerb="Filter in"
          isOn={(id) => !f.excluded.includes(id)}
          onChange={(ids, on) =>
            set({
              excluded: on ? f.excluded.filter((x) => !ids.includes(x)) : [...new Set([...f.excluded, ...ids])],
            })
          }
        />
      )}
    </>
  );
}

function ProfileLines({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="filter-profile__side">
      <span className="label">{title}</span>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function Sources({
  title,
  sources,
  onForget,
}: {
  title: string;
  sources: FilterSource[];
  onForget: (s: FilterSource) => Promise<void>;
}) {
  if (!sources.length) return null;
  return (
    <section className="settings__section">
      <div className="settings__sectionhead">
        <span className="label">{title}</span>
      </div>
      {sources.map((s) => (
        <Row
          key={`${s.kind}:${s.value}`}
          title={s.name || s.value}
          desc={`${s.kind === 'list' ? 'List ' : ''}${s.name ? `${s.value} · ` : ''}${relative(s.lastAt)}`}
        >
          <IconButton label={`Forget ${s.value}`} onClick={() => void onForget(s)}>
            <Trash size={14} />
          </IconButton>
        </Row>
      ))}
    </section>
  );
}
