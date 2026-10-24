/**
 * The Filtered folder: whether it files on arrival, how readily, with which
 * model, and the senders and lists it has learned.
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
import type { FilterModelTrial, FilterPreferences, FilterSensitivity, FilterSource, FilterStatus } from '@/lib/types';
import { AccountChecklist } from './Notifications';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function FilteredSettings() {
  const f = useStore((s) => s.prefs!.filtering);
  const savePrefs = useStore((s) => s.savePrefs);
  const resync = useStore((s) => s.resync);
  const set = (patch: Partial<FilterPreferences>) => void savePrefs({ filtering: { ...f, ...patch } });

  const [status, setStatus] = useState<FilterStatus | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [trial, setTrial] = useState<FilterModelTrial | null>(null);
  const [busy, setBusy] = useState<'sweep' | 'try' | null>(null);
  const [swept, setSwept] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = async () => {
    try {
      setStatus(await (await getApi()).filterStatus());
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not read the filter');
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!status?.llm.available || models) return;
    void (async () => {
      try {
        setModels(await (await getApi()).listFilterModels());
      } catch (e) {
        setModels([]);
        setFailure(e instanceof Error ? e.message : 'Could not list models');
      }
    })();
  }, [status?.llm.available, models]);

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

  async function tryModel() {
    setBusy('try');
    setTrial(null);
    try {
      setTrial(await (await getApi()).tryFilterModel(f.llmModel));
    } catch (e) {
      setTrial({ ok: false, model: f.llmModel ?? '', ms: 0, detail: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setBusy(null);
    }
  }

  async function forget(source: FilterSource) {
    await (await getApi()).forgetFilterSource(source);
    await reload();
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
            desc={`${status.examples.filter} filtered · ${status.examples.keep} taken back`}
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
            desc={llm.available ? `Sends sender, subject and preview to ${llm.host}` : 'No model configured on this server'}
          >
            <Toggle
              label="Ask a language model when unsure"
              checked={f.llm && llm.available}
              onChange={(on) => {
                if (llm.available) set({ llm: on });
              }}
            />
          </Row>
          {llm.available && (
            <Row title="Model" desc={trial ? `${trial.model || llm.defaultModel} · ${trial.detail}${trial.ms ? ` · ${trial.ms} ms` : ''}` : undefined}>
              <div className="notif__device">
                <select
                  className="input mselect"
                  aria-label="Model"
                  value={f.llmModel ?? ''}
                  onChange={(e) => {
                    setTrial(null);
                    set({ llmModel: e.target.value || null });
                  }}
                >
                  <option value="">{`Default · ${llm.defaultModel}`}</option>
                  {(models ?? []).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                  {f.llmModel && models && !models.includes(f.llmModel) && (
                    <option value={f.llmModel}>{f.llmModel}</option>
                  )}
                </select>
                <Button size="sm" disabled={busy !== null} onClick={() => void tryModel()}>
                  {busy === 'try' ? <Spinner /> : null}
                  Try
                </Button>
              </div>
            </Row>
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
