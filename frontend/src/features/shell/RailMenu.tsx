/**
 * The right-click menu for a rail target: pick the picture a domain wears.
 *
 * The rail draws two letters of the domain name, which is enough until it is
 * not — "chungus.holdings" and "chungus.group" are both CH, and the rail is
 * 44px wide with no room to say more. A glyph is the shortest way to tell eight
 * domains apart at a glance, so it sits behind a right-click on the target
 * itself rather than three screens deep in settings.
 *
 * The set lives in `components/glyphs.tsx` and the choice lives in
 * preferences — presentation, one line in a blob the client already reads
 * whole, and nothing the mail server is told about.
 */

import { useMemo, useState } from 'react';
import { Check, Close, Search } from '@/components/icons';
import { GLYPHS, GLYPH_CATEGORIES, Glyph, type GlyphCategory } from '@/components/glyphs';
import { ContextMenu, MenuItem, type ContextMenuController } from '@/components/context-menu';
import { PopLabel, PopSep } from '@/components/ui';
import { useStore } from '@/lib/store';

/** What was right-clicked in the rail. Only domains carry a glyph today; the
 *  shape is a union so the unified and saved-view targets can join later
 *  without every caller changing. */
export type RailTarget = { kind: 'domain'; domain: string };

export function RailMenu({ controller }: { controller: ContextMenuController<RailTarget> }) {
  return (
    <ContextMenu controller={controller} width={272}>
      {(target, close) => <IconPicker domain={target.domain} close={close} />}
    </ContextMenu>
  );
}

function IconPicker({ domain, close }: { domain: string; close: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const saveTheme = useStore((s) => s.saveTheme);
  const [filter, setFilter] = useState('');

  const current = prefs?.theme.domainIcons[domain] ?? null;

  /* Filtering flattens the categories. Five headings over three results is the
     scaffolding outliving the thing it was holding up. */
  const query = filter.trim().toLowerCase();
  const sections = useMemo(() => {
    if (query) {
      const hits = GLYPHS.filter((g) => g.label.toLowerCase().includes(query));
      return hits.length ? [{ id: 'hits' as GlyphCategory | 'hits', label: '', glyphs: hits }] : [];
    }
    return GLYPH_CATEGORIES.map((c) => ({
      id: c.id as GlyphCategory | 'hits',
      label: c.label,
      glyphs: GLYPHS.filter((g) => g.category === c.id),
    }));
  }, [query]);

  const pick = (id: string | null) => {
    const next = { ...(prefs?.theme.domainIcons ?? {}) };
    if (id) next[domain] = id;
    else delete next[domain];
    void saveTheme({ domainIcons: next });
    close();
  };

  return (
    <>
      <PopLabel>{domain}</PopLabel>

      <div className="pop__field">
        <span className="pop__search">
          <Search size={12} />
          <input
            className="input"
            autoFocus
            placeholder="Search icons"
            aria-label="Search icons"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                // Clear first, close second. Escaping out of the whole menu
                // because a search box had a word in it loses the place.
                e.stopPropagation();
                setFilter('');
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                const first = sections[0]?.glyphs[0];
                if (first) pick(first.id);
              }
            }}
          />
        </span>
      </div>

      <div className="glyphs scroll-y">
        {sections.length === 0 && <div className="pop__empty">No icon called “{filter.trim()}”.</div>}
        {sections.map((section) => (
          <div key={section.id}>
            {section.label && <div className="glyphs__head label">{section.label}</div>}
            <div className="glyphs__grid">
              {section.glyphs.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="glyphs__item"
                  aria-label={g.label}
                  title={g.label}
                  aria-pressed={current === g.id}
                  onClick={() => pick(g.id)}
                >
                  <Glyph name={g.id} size={16} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <PopSep />

      <MenuItem
        icon={current ? <Close size={13} /> : <Check size={13} />}
        disabled={!current}
        onClick={() => pick(null)}
      >
        Use letters
      </MenuItem>
    </>
  );
}
