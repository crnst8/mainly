import { useEffect, useMemo, useRef, useState } from 'react';
import { Chevron, Close, Search } from '@/components/icons';
import { IconButton, Kbd } from '@/components/ui';
import { SHORTCUTS } from '@/lib/keyboard';
import { useStore } from '@/lib/store';
import { HELP_GUIDES, guideSearchText, helpGuide, type HelpGuide, type HelpSection } from './guides';
import '@/features/settings/settings.css';
import './help.css';

export function Help() {
  const raw = useStore((s) => s.help);
  const setHelp = useStore((s) => s.setHelp);
  const setSettings = useStore((s) => s.setSettings);
  const [activeId, setActiveId] = useState(() => helpGuide(raw).id);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const active = helpGuide(activeId);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return HELP_GUIDES.filter((guide) => guideSearchText(guide).includes(needle));
  }, [query]);

  useEffect(() => {
    if (raw) setActiveId(helpGuide(raw).id);
  }, [raw]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if (event.key !== '/' || typing) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);

  const choose = (id: string) => {
    setActiveId(id);
    setQuery('');
  };

  const openSettings = (tab: string) => {
    setHelp(null);
    setSettings(tab);
  };

  return (
    <div className="settings help" role="dialog" aria-modal="true" aria-label="Help and guides">
      <nav className="settings__nav help__nav" aria-label="Help topics">
        <button type="button" className="settings__back" onClick={() => setHelp(null)}>
          <Chevron size={13} dir="left" />
          <span>Mainly</span>
        </button>
        <div className="settings__brand">Help &amp; guides</div>
        {HELP_GUIDES.map((guide) => (
          <button
            key={guide.id}
            type="button"
            className="settings__navitem"
            aria-current={!query && active.id === guide.id}
            onClick={() => choose(guide.id)}
          >
            {guide.icon}
            {guide.label}
          </button>
        ))}
      </nav>

      <main className="settings__main">
        <div className="settings__head help__head">
          <button
            type="button"
            className="settings__back settings__back--inline"
            aria-label="Back"
            onClick={() => setHelp(null)}
          >
            <Chevron size={16} dir="left" />
          </button>
          <h1 className="settings__title">{query ? 'Search guides' : active.label}</h1>
          <label className="help__search">
            <Search size={15} />
            <input
              ref={inputRef}
              value={query}
              type="search"
              aria-label="Search help"
              placeholder="Search help…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.stopPropagation();
                  setQuery('');
                }
              }}
            />
            <span className="help__searchkey" aria-hidden="true">/</span>
          </label>
          <IconButton label="Close help" hint="Esc" onClick={() => setHelp(null)}>
            <Close size={16} />
          </IconButton>
        </div>

        <div className="settings__scroll help__scroll">
          <div className="settings__pane help__pane">
            {query ? (
              <SearchResults query={query} guides={matches} onChoose={choose} />
            ) : (
              <Guide guide={active} openSettings={openSettings} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Guide({
  guide,
  openSettings,
}: {
  guide: HelpGuide;
  openSettings: (tab: string) => void;
}) {
  return (
    <>
      <p className="help__lede">{guide.summary}</p>
      {guide.sections.map((section) => (
        <GuideSection key={section.title} section={section} openSettings={openSettings} />
      ))}
      {guide.showShortcuts && <ShortcutReference />}
    </>
  );
}

function GuideSection({
  section,
  openSettings,
}: {
  section: HelpSection;
  openSettings: (tab: string) => void;
}) {
  return (
    <section className="help__section">
      <div className="help__sectionhead">
        <h2>{section.title}</h2>
        {section.intro && <p>{section.intro}</p>}
      </div>
      <div className="help__items">
        {section.items.map((item) => (
          <article className="help__item" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            {item.details && (
              <ul>
                {item.details.map((detail) => <li key={detail}>{detail}</li>)}
              </ul>
            )}
            {item.examples && (
              <div className="help__examples">
                {item.examples.map((example) => <code key={example}>{example}</code>)}
              </div>
            )}
            {item.keys && (
              <div className="help__keys" aria-label={`Shortcuts: ${item.keys.join(', ')}`}>
                {item.keys.map((key, index) => <Kbd key={`${key}-${index}`}>{key}</Kbd>)}
              </div>
            )}
          </article>
        ))}
      </div>
      {section.action && (
        <button
          type="button"
          className="btn btn--outline help__action"
          onClick={() => openSettings(section.action!.settingsTab)}
        >
          {section.action.label}
          <Chevron size={12} dir="right" />
        </button>
      )}
    </section>
  );
}

function ShortcutReference() {
  const groups = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];
  return (
    <section className="help__section">
      <div className="help__sectionhead">
        <h2>Complete shortcut reference</h2>
      </div>
      <div className="keys help__shortcutgrid">
        {groups.map((group) => (
          <div key={group}>
            <div className="label">{group}</div>
            {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
              <div className="keys__row" key={`${group}-${shortcut.label}`}>
                <span>{shortcut.label}</span>
                <span className="keys__combo">
                  {shortcut.keys.map((key, index) => <Kbd key={`${key}-${index}`}>{key}</Kbd>)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function SearchResults({
  query,
  guides,
  onChoose,
}: {
  query: string;
  guides: HelpGuide[];
  onChoose: (id: string) => void;
}) {
  if (!guides.length) {
    return (
      <div className="help__empty">
        <Search size={22} />
        <h2>No guide matches “{query.trim()}”</h2>
        <p>Try a feature name such as search, swipe, colour, account or shortcut.</p>
      </div>
    );
  }

  return (
    <>
      <p className="help__lede">
        {guides.length} {guides.length === 1 ? 'guide covers' : 'guides cover'} “{query.trim()}”.
      </p>
      <div className="help__results">
        {guides.map((guide) => (
          <button type="button" className="help__result" key={guide.id} onClick={() => onChoose(guide.id)}>
            <span className="help__resulticon">{guide.icon}</span>
            <span>
              <strong>{guide.label}</strong>
              <small>{guide.summary}</small>
            </span>
            <Chevron size={13} dir="right" />
          </button>
        ))}
      </div>
    </>
  );
}
