/**
 * Assist: the language model every model task shares, the tasks that use it,
 * and sender logos.
 *
 * One provider and one model serve the Filtered folder, kind labels and the
 * recap, so they are chosen here once rather than per feature. Each task is
 * still its own switch: having a key does not by itself send anything.
 */

import { useEffect, useState } from 'react';
import { Button, IconButton, Row, Spinner, Toggle } from '@/components/ui';
import { Trash } from '@/components/icons';
import { getApi } from '@/lib/api';
import { useStore } from '@/lib/store';
import { MAIL_KINDS, type AssistPreferences, type FilterModelTrial, type FilterStatus } from '@/lib/types';

export function AssistSettings() {
  const prefs = useStore((s) => s.prefs!);
  const savePrefs = useStore((s) => s.savePrefs);
  const setRecap = useStore((s) => s.setRecap);
  const a = prefs.assist;
  const f = prefs.filtering;
  const setAssist = (patch: Partial<AssistPreferences>) => void savePrefs({ assist: { ...a, ...patch } });
  const setModel = (llmModel: string | null) => void savePrefs({ filtering: { ...f, llmModel } });

  const [llm, setLlm] = useState<FilterStatus['llm'] | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [trial, setTrial] = useState<FilterModelTrial | null>(null);
  const [trying, setTrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = async () => {
    try {
      const next = (await (await getApi()).filterStatus()).llm;
      setLlm(next);
      return next;
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not read the model settings');
      return null;
    }
  };

  /** After the key changes: list the new provider's models, and drop a chosen
   *  model when requests now go to a different host that may not have it. */
  async function providerChanged() {
    const before = llm?.host ?? null;
    const next = await reload();
    setModels(null);
    setTrial(null);
    if (next && next.host !== before && f.llmModel) setModel(null);
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!llm?.available || models) return;
    void (async () => {
      try {
        setModels(await (await getApi()).listFilterModels());
      } catch (e) {
        setModels([]);
        setFailure(e instanceof Error ? e.message : 'Could not list models');
      }
    })();
  }, [llm?.available, models]);

  async function tryModel() {
    setTrying(true);
    setTrial(null);
    try {
      setTrial(await (await getApi()).tryFilterModel(f.llmModel));
    } catch (e) {
      setTrial({ ok: false, model: f.llmModel ?? '', ms: 0, detail: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setTrying(false);
    }
  }

  return (
    <>
      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">Language model</span>
        </div>
        {llm ? (
          <ProviderKey llm={llm} onChanged={providerChanged} />
        ) : (
          // Same height as the two rows it stands in for, so the page does
          // not jump when the status arrives.
          <>
            <Row title="Provider">
              <Spinner />
            </Row>
            <Row title="API key">{null}</Row>
          </>
        )}
        {llm?.available && (
          <Row
            title="Model"
            desc={trial ? `${trial.model || llm.defaultModel} · ${trial.detail}${trial.ms ? ` · ${trial.ms} ms` : ''}` : undefined}
          >
            <div className="notif__device">
              <select
                className="input mselect"
                aria-label="Model"
                value={f.llmModel ?? ''}
                onChange={(e) => {
                  setTrial(null);
                  setModel(e.target.value || null);
                }}
              >
                <option value="">{llm.defaultModel ? `Default · ${llm.defaultModel}` : 'Choose a model'}</option>
                {(models ?? []).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
                {f.llmModel && models && !models.includes(f.llmModel) && <option value={f.llmModel}>{f.llmModel}</option>}
              </select>
              <Button size="sm" disabled={trying || (!f.llmModel && !llm.defaultModel)} onClick={() => void tryModel()}>
                {trying ? <Spinner /> : null}
                Try
              </Button>
            </div>
          </Row>
        )}
        {failure && <p className="settings__note settings__note--error">{failure}</p>}
      </section>

      {llm?.available && (
        <section className="settings__section">
          <div className="settings__sectionhead">
            <span className="label">With the model</span>
          </div>
          <Row title="Label new mail by kind" desc={MAIL_KINDS.join(' · ')}>
            <Toggle label="Label new mail by kind" checked={a.kinds} onChange={(kinds) => setAssist({ kinds })} />
          </Row>
          <Row title="Filter when unsure" desc="Settings → Filtered">
            <Toggle
              label="Ask the model when the filter is unsure"
              checked={f.llm}
              onChange={(on) => void savePrefs({ filtering: { ...f, llm: on } })}
            />
          </Row>
          <Row title="Recap">
            <Button size="sm" onClick={() => setRecap(true)}>
              Today
            </Button>
          </Row>
        </section>
      )}

      <section className="settings__section">
        <div className="settings__sectionhead">
          <span className="label">Sender logos</span>
        </div>
        <Row title="Show published logos" desc="BIMI, looked up by this server">
          <Toggle
            label="Show senders' published logos"
            checked={a.senderLogos}
            onChange={(senderLogos) => setAssist({ senderLogos })}
          />
        </Row>
      </section>
    </>
  );
}

/** Presets for the OpenAI-compatible providers docs/filtering.md lists. A null
 *  URL is OpenCode Go, the server's own default. */
const PROVIDERS = [
  { id: 'opencode', label: 'OpenCode Go', url: null, host: 'opencode.ai' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', host: 'openrouter.ai' },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', host: 'api.openai.com' },
  { id: 'custom', label: 'Other', url: '', host: null },
] as const;
type ProviderId = (typeof PROVIDERS)[number]['id'];

const providerOf = (host: string | null): ProviderId =>
  PROVIDERS.find((p) => p.host && p.host === host)?.id ?? (host ? 'custom' : 'opencode');

/**
 * The user's own provider and key. The key is write-only: the server never
 * sends it back, so the field is always empty and "Saved" is all there is to
 * show for it.
 */
function ProviderKey({ llm, onChanged }: { llm: FilterStatus['llm']; onChanged: () => Promise<void> }) {
  const own = llm.source === 'own';
  const [provider, setProvider] = useState<ProviderId>(() => (own ? providerOf(llm.host) : 'opencode'));
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preset = PROVIDERS.find((p) => p.id === provider)!;
  const target = provider === 'custom' ? url.trim() : preset.url;
  const canSave = busy === null && (key.trim() !== '' || (provider === 'custom' && url.trim() !== ''));

  async function save() {
    setBusy('save');
    setError(null);
    try {
      await (await getApi()).setFilterKey({ url: target || null, key: key.trim() });
      // Cleared, so a second Save cannot replace the key with an empty one.
      setKey('');
      setUrl('');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the key');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setError(null);
    try {
      await (await getApi()).removeFilterKey();
      setProvider('opencode');
      setUrl('');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the key');
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="filter-key"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <Row title="Provider">
        <select
          className="input mselect"
          aria-label="Provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as ProviderId);
            setError(null);
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Row>
      {provider === 'custom' && (
        <Row title="URL">
          <input
            className="input filter-key__input"
            type="url"
            aria-label="Provider URL"
            autoComplete="off"
            spellCheck={false}
            placeholder={own && providerOf(llm.host) === 'custom' && llm.host ? llm.host : 'https://host/v1'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Row>
      )}
      <Row title="API key" desc={own ? `Saved · ${llm.host}` : llm.source === 'server' ? "Using the server's" : undefined}>
        <div className="notif__device">
          <input
            className="input filter-key__input"
            type="password"
            aria-label="API key"
            autoComplete="off"
            spellCheck={false}
            placeholder={own && providerOf(llm.host) === provider ? 'Replace key' : 'Paste key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!canSave}>
            {busy === 'save' ? <Spinner /> : null}
            Save
          </Button>
          {own && (
            <IconButton label="Remove API key" disabled={busy !== null} onClick={() => void remove()}>
              {busy === 'remove' ? <Spinner /> : <Trash size={14} />}
            </IconButton>
          )}
        </div>
      </Row>
      {error && <p className="settings__note settings__note--error">{error}</p>}
    </form>
  );
}

