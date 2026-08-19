# Search

One syntax, parsed by one file, executed two ways.

`frontend/src/lib/search.ts` is the parser and the ranking policy. The mock
adapter runs it directly against objects in memory;
`backend/src/modules/messages/search-sql.ts` mirrors it in SQL. The file is
copied byte-for-byte into `backend/src/contract/` and the build fails if the two
drift, because a query that means one thing in one place and something else in
another is worse than having no syntax at all.

**Nothing here throws and nothing is rejected.** An operator that is not
understood — a bad date, an unknown field, an unbalanced quote — degrades to a
plain text term. A search box that answers a typo with an error is a search box
people stop using.

---

## Operators

| Operator | Matches |
| --- | --- |
| `from:anna` | Sender name or address, substring |
| `to:dale` | Recipient |
| `subject:invoice` | Words in the subject |
| `label:receipts` | One of your labels |
| `folder:archive` | Folder name, or a folder role |
| `is:unread` `is:read` | Read state |
| `is:flagged` | Flagged |
| `is:answered` | You replied |
| `has:attachment` | Carries a file |
| `after:2026-01-01` | On or after a date |
| `before:2026-06-30` | Before a date |
| `larger:5mb` | Bigger than a size |
| `smaller:100kb` | Smaller than a size |

Anything not matching an operator is free text.

## Combining

| Form | Means |
| --- | --- |
| `a b` | Both. Terms are ANDed. |
| `a OR b`, `a \| b` | Either. |
| `-a`, `-from:anna` | Not. Any clause can be negated. |
| `"quoted phrase"` | The words in that order, not loosely. |

Grouping is one level deep: alternatives are ORed, and every clause inside one
alternative must match. That covers the queries people actually type and keeps
the SQL generator honest.

## Dates and sizes

Dates take an ISO date (`2026-01-01`), a relative offset (`7d`, `2w`, `3m`), or
a phrase (`"last week"`, `"yesterday"`). Sizes take a number with a unit —
`500kb`, `5mb`, `1gb` — or plain bytes.

---

## What free text searches

Free text goes through Postgres full-text search with stemming, weighted:

| Weight | Field |
| --- | --- |
| A | Subject |
| B | Sender name and address |
| C | The 200-character preview |
| D | Body text |

Body text is indexed for messages whose bodies have been fetched. Bodies are
fetched on demand rather than up front, so a message nobody has ever opened is
matchable on its envelope and preview but not yet on its full text. Opening it
once indexes it.

Field-scoped operators (`from:`, `subject:`) use substring matching rather than
full-text, because someone typing `from:ann` means the prefix, not the lexeme.

## Ranking

A query is classified into an intent — looking for a person, looking for a
thread, looking for a file, looking for anything — and the intent selects a
ranking profile. Recency decay, the field weights above, priority tier and read
state all feed the score, scaled by preferences you can change in settings.

Matching and ranking read the same parsed clauses, deliberately: a row that
matched `from:anna` is a row whose rank includes the sender weight, because the
alternative is a result list ordered by something other than why it matched.

---

## Saved views

Any search plus the sort, grouping and filters around it can be saved as a view
and pinned to the sidebar. A view owns its whole query, so `/v/<id>` on its own
means "the view exactly as saved" — parameters only appear in the URL when they
differ from it.

## In the URL

Everything above is addressable. `frontend/src/lib/url.ts` is the codec and
`frontend/scripts/url-check.mjs` asserts on exact strings.

```
/                       unified inbox
/u/:role                unified, one folder role
/d/:domain/:role?       one domain
/a/:accountId/:role?    one account
/f/:folderId            one folder
/v/:viewId              a saved view
/search?q=…             a search
…/m/:messageId          an open message — a location, not a mode
…?settings=:tab         settings, over whatever list you were looking at
```

Sort, grouping, threading and filters ride in the query string and are omitted
whenever they match the current defaults, so an ordinary link stays short enough
to read out loud.
