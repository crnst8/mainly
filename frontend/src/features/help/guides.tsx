/**
 * User-facing help content.
 *
 * The page shell knows how to render guides, sections and items, but it knows
 * nothing about mail. Adding a topic is therefore one object here: navigation,
 * search and responsive rendering all pick it up automatically.
 */

import type { ReactNode } from 'react';
import {
  Check,
  Command,
  Eye,
  Globe,
  Layout,
  Palette,
  Phone,
  Question,
  Search,
  Send,
  User,
} from '@/components/icons';

export interface HelpItem {
  title: string;
  body: string;
  details?: string[];
  examples?: string[];
  keys?: string[];
}

export interface HelpSection {
  title: string;
  intro?: string;
  items: HelpItem[];
  action?: { label: string; settingsTab: string };
}

export interface HelpGuide {
  id: string;
  label: string;
  summary: string;
  icon: ReactNode;
  sections: HelpSection[];
  /** The shortcut table comes from lib/keyboard so its labels cannot drift. */
  showShortcuts?: boolean;
}

export const HELP_GUIDES: HelpGuide[] = [
  {
    id: 'start',
    label: 'Start here',
    summary: 'A quick map of Mainly and the few controls worth knowing first.',
    icon: <Question size={15} />,
    sections: [
      {
        title: 'The four parts of the desktop',
        items: [
          {
            title: 'Domain rail',
            body: 'The narrow strip on the far left switches between all mail, a domain and your pinned views. Unread and connection-error dots stay visible at a glance.',
          },
          {
            title: 'Folder sidebar',
            body: 'The next pane shows the folders, mailbox groups and accounts that belong to the rail selection. Expand only the trees you need.',
          },
          {
            title: 'Message list',
            body: 'The middle pane owns filters, sorting, grouping, selection and the messages themselves. Its breadcrumb always says exactly which scope you are viewing.',
          },
          {
            title: 'Reader',
            body: 'Open a message into the right or bottom preview pane. At narrower desktop widths it covers the list; the Mainly mark then takes you back one step.',
          },
        ],
      },
      {
        title: 'The controls that travel with you',
        items: [
          {
            title: 'Search and commands',
            body: 'Use the search field for mail and the command palette for places, view changes and actions. The palette is the fastest route to something you do not use often.',
            keys: ['/', '⌘', 'K'],
          },
          {
            title: 'Writing identity',
            body: 'The coloured identity control in the top bar chooses which mailbox new mail is sent from. It is separate from the person signed into Mainly.',
          },
          {
            title: 'Sync and compose',
            body: 'Refresh asks every mailbox for changes; its icon spins while work is active. Compose opens a docked draft and keeps the rest of the app available.',
            keys: ['r', 'c'],
          },
          {
            title: 'Undo instead of confirmation',
            body: 'Archive, trash and bulk mark-read actions announce what happened in a toast. Use Undo there, or press z, before the configured undo window ends.',
            keys: ['z'],
          },
        ],
      },
    ],
  },
  {
    id: 'navigate',
    label: 'Navigate mail',
    summary: 'Move between all mail, domains, accounts, groups and folders.',
    icon: <Globe size={15} />,
    sections: [
      {
        title: 'Rail and sidebar',
        items: [
          {
            title: 'All mail and domains',
            body: 'The inbox at the top of the rail unifies every visible mailbox. Pick a domain below it to narrow the sidebar and list to just that domain.',
          },
          {
            title: 'Recognisable domain icons',
            body: 'Domains start with two-letter tiles. Right-click a domain tile to choose a pictogram instead; its colour and unread or error marker stay intact.',
          },
          {
            title: 'Folders keep their scope',
            body: 'Inbox, Drafts, Sent, Archive, Junk and Trash are combined at the unified level. Under a domain or account they refer only to that part of your mail.',
          },
          {
            title: 'Custom folders',
            body: 'Expand an account to browse its complete folder tree. Folder context menus can create subfolders, choose colours, pin folders and mark their mail read.',
          },
        ],
      },
      {
        title: 'Mailbox groups',
        items: [
          {
            title: 'Group by purpose',
            body: 'Create groups such as Work or Personal, then drag mailboxes into them and into the order you want. Ungrouped mailboxes remain available below.',
          },
          {
            title: 'Group controls',
            body: 'Right-click a group to rename or colour it, mark all of its messages read, or remove the group. Removing a group never removes its mailboxes.',
          },
          {
            title: 'Jump without drilling down',
            body: 'The command palette can open any domain, mailbox, saved view or custom folder. Recently visited places appear first.',
            keys: ['⌘', 'K'],
          },
          {
            title: 'Home and role shortcuts',
            body: 'The Mainly mark returns to all mail, while g followed by a role key changes folders without losing the current domain or account scope.',
            examples: ['g h  All mail', 'g i  Inbox here', 'g s  Sent here', 'g g  Every folder here'],
          },
        ],
      },
    ],
  },
  {
    id: 'search',
    label: 'Search & views',
    summary: 'Find mail across every account, narrow it, and save useful queries.',
    icon: <Search size={15} />,
    sections: [
      {
        title: 'Search language',
        intro: 'Bare words search sender, subject and indexed body text. Operators can be combined in one query.',
        items: [
          {
            title: 'People and text',
            body: 'Target an address, subject or body instead of searching every text field.',
            examples: ['from:alice@example.com', 'to:team@example.com', 'subject:"project plan"', 'body:invoice'],
          },
          {
            title: 'Location and organisation',
            body: 'Limit results to a label, folder, domain or mailbox.',
            examples: ['label:finance', 'folder:receipts', 'domain:example.com', 'account:personal'],
          },
          {
            title: 'State, dates and size',
            body: 'Mix message state with date and attachment constraints.',
            examples: ['is:unread', 'has:attachment', 'after:2026-01-01', 'before:2026-02-01', 'larger:5mb'],
          },
          {
            title: 'Search here or everywhere',
            body: 'A search remembers where it began. Scope chips above the list let you switch between that domain, account or folder and every mailbox.',
            keys: ['/'],
          },
        ],
      },
      {
        title: 'Shape and keep the result',
        items: [
          {
            title: 'Facet chips',
            body: 'Unread, Flagged, Attachments, Priority and popular labels narrow the current result. Their counts come from the whole result, not only the visible page.',
          },
          {
            title: 'Sort, group and thread',
            body: 'Sort by relevance, date, priority, sender, subject, unread state or size. Group by date, account, domain, priority, sender or folder, and choose whether conversations collapse into one row.',
          },
          {
            title: 'Saved views',
            body: 'After searching or filtering, use the star in the list toolbar to name that exact view. Pinned views live in the rail and every saved view is available in the command palette.',
          },
          {
            title: 'Tune relevance',
            body: 'Search settings expose the weights behind adaptive ranking, including exact phrases, people, subject, body, recency, priority and message state.',
          },
        ],
        action: { label: 'Open search settings', settingsTab: 'search' },
      },
    ],
  },
  {
    id: 'select',
    label: 'Select & organise',
    summary: 'Work on one message, a range, a group or an entire mailbox set.',
    icon: <Check size={15} />,
    sections: [
      {
        title: 'Build a selection',
        items: [
          {
            title: 'One or many',
            body: 'Use a row checkbox or x to add one message. Shift-click selects the visible range from the last message you touched, even when the list is grouped.',
            keys: ['x', '⇧', 'click'],
          },
          {
            title: 'Keyboard ranges',
            body: 'j and k move focus. Hold Shift with either key to grow a selection through the order currently drawn on screen.',
            keys: ['j', 'k', '⇧', 'j/k'],
          },
          {
            title: 'Whole groups and pages',
            body: 'A grouped list has a checkbox on each group heading. Once a selection exists, the toolbar can extend it to every message on the loaded page.',
          },
          {
            title: 'Clear cleanly',
            body: 'Escape clears the selection before it closes the reader, so it is safe to use as the universal way out.',
            keys: ['Esc'],
          },
        ],
      },
      {
        title: 'Actions',
        items: [
          {
            title: 'Read, flag, archive and trash',
            body: 'The selection toolbar states the action it will apply to the whole set. Mixed selections are brought into the named state, so “Mark read” really marks every selected message read.',
          },
          {
            title: 'Labels and folders',
            body: 'Right-click a message or selection to add and remove labels, move mail to a server folder, or choose a label colour. Mailbox and folder menus expose broader actions.',
          },
          {
            title: 'Mark a mailbox or group read',
            body: 'Context menus can mark everything unread in a folder, mailbox or mailbox group read, including messages beyond the loaded page. The resulting toast can undo the whole operation.',
          },
          {
            title: 'App-side organisation',
            body: 'Saved views, labels and snooze belong to Mainly. Archive, trash, folder moves and standard flags are replayed to IMAP where they have a server meaning.',
          },
        ],
      },
    ],
  },
  {
    id: 'read',
    label: 'Read messages',
    summary: 'Use threads, message controls, attachments and sender protections.',
    icon: <Eye size={15} />,
    sections: [
      {
        title: 'Reader behaviour',
        items: [
          {
            title: 'Preview your way',
            body: 'Keep the reader on the right, move it below the list or turn the pane off. In a stacked window, opening a message overlays the list and Back returns to the same place.',
          },
          {
            title: 'Conversations',
            body: 'With threads collapsed, one list row opens the conversation. Bodies are fetched as members are expanded, so long threads do not make the first open wait.',
          },
          {
            title: 'Move through mail',
            body: 'Previous and next controls follow the visual list order. j and k do the same while keeping browser history clean.',
            keys: ['j', 'k'],
          },
          {
            title: 'Automatic read state',
            body: 'A message becomes read after the delay in Message list settings. Set the delay to instant, wait a little, or disable automatic marking entirely.',
          },
        ],
        action: { label: 'Open message list settings', settingsTab: 'list' },
      },
      {
        title: 'Content and safety',
        items: [
          {
            title: 'Remote images',
            body: 'Remote images can reveal that you opened a message. Block them, always load them, or allow them only for sender identities you trust.',
          },
          {
            title: 'Sender identities',
            body: 'A sender profile joins authorised domains under one name and optional logo. It also controls whether that sender may load remote images.',
          },
          {
            title: 'Attachments',
            body: 'Attachments are listed with their filename, type and size and can be downloaded from the reader.',
          },
          {
            title: 'Unsubscribe',
            body: 'When a sender publishes List-Unsubscribe details, Mainly shows the safe options and records attempts. Automatic one-click actions require the sender to have explicitly advertised them.',
          },
        ],
        action: { label: 'Open sender settings', settingsTab: 'senders' },
      },
      {
        title: 'Colours and paper',
        intro:
          'Mail is drawn for white paper. Two places break that — a dark screen, and an actual printer — and Mainly moves the sender\u2019s colours to suit, keeping their hues and changing only how light or dark they are.',
        items: [
          {
            title: 'Dark mode for message bodies',
            body: 'In dark mode a light message is re-lit to sit on the dark surface, including the common case of a message that sets no background and hardcodes dark grey text. A message already designed dark is left alone.',
          },
          {
            title: 'Messages that bring no background',
            body: 'Most mail declares no background at all, which is not the same as declaring white \u2014 it means the message is standing on whatever is behind it. When its own text was written for the opposite kind of surface it would be white on white, so it is given the surface it was drawn for, on its own card, with every colour the sender chose left alone. A message that paints its own background is never treated this way.',
          },
          {
            title: 'Back to the original, for one message',
            body: 'The contrast button in the reader toolbar shows a message exactly as it was sent, and shows it re-lit again. It applies to that message only and is forgotten when you move on \u2014 when a colour is the content, this is how you see it.',
            keys: ['i'],
          },
          {
            title: 'Print a message',
            body: 'Print builds a page holding the message and nothing of the mail client, titled with the subject line. Paper colours lift dark bands and pale small print to black on white; As sent prints the sender\u2019s own colours. The chevron beside the printer picks the other one.',
            keys: ['p'],
          },
          {
            title: 'Receipts that arrived in the body',
            body: 'Shops and banks often send a receipt as the message itself, with nothing attached and no file to save. Print it and choose Save as PDF in the browser\u2019s print dialog \u2014 the subject becomes the filename, so the saved file is already named after what it is.',
          },
        ],
        action: { label: 'Open appearance settings', settingsTab: 'appearance' },
      },
    ],
  },
  {
    id: 'write',
    label: 'Write & reply',
    summary: 'Choose an identity, address recipients and send with safeguards.',
    icon: <Send size={15} />,
    sections: [
      {
        title: 'Compose',
        items: [
          {
            title: 'Choose the From mailbox',
            body: 'The top-bar identity is the default for new mail. Open it to switch identities, jump to a mailbox, or start a draft from a specific address.',
          },
          {
            title: 'Recipient chips',
            body: 'Type or paste addresses into To, Cc and Bcc. Commas, semicolons and pasted address lists become individual removable recipients.',
          },
          {
            title: 'Keep working beside a draft',
            body: 'The desktop composer is a docked card that can be minimised. The message list and reader remain usable while the draft is open.',
          },
          {
            title: 'Send guards',
            body: 'When enabled, Mainly warns before sending an empty subject or text that mentions an attachment without one. The mobile composer also protects a non-empty draft from an accidental discard.',
            keys: ['⌘', '↵'],
          },
        ],
        action: { label: 'Open message list settings', settingsTab: 'list' },
      },
      {
        title: 'Reply and forward',
        items: [
          {
            title: 'Reply in context',
            body: 'Reply and Reply all seed the right account, recipients, subject and quoted context from the message you are reading.',
            keys: ['r', 'a'],
          },
          {
            title: 'Forward',
            body: 'Forward creates a new addressed draft from the open message while leaving the original conversation intact.',
            keys: ['f'],
          },
        ],
      },
    ],
  },
  {
    id: 'accounts',
    label: 'Accounts & sync',
    summary: 'Add, group, prioritise, repair and sync many mailboxes.',
    icon: <User size={15} />,
    sections: [
      {
        title: 'Add mailboxes',
        items: [
          {
            title: 'Add one account',
            body: 'Enter an address and password. Autoconfig discovers common IMAP and SMTP settings, and the advanced step lets you supply the exact servers when discovery is not enough.',
          },
          {
            title: 'Bulk onboarding',
            body: 'When many addresses share server settings, state those settings once and import the mailbox credentials in batches. Each row succeeds or fails independently.',
          },
          {
            title: 'Priority tiers',
            body: 'Critical, high, normal, low and muted priorities let one unified inbox reflect what each mailbox is for. Priority is available for sorting, grouping and filtering.',
          },
          {
            title: 'Visibility and colour',
            body: 'Hide a mailbox from unified views without removing it. Accounts inherit their domain colour unless you give one an override.',
          },
        ],
      },
      {
        title: 'Keep accounts healthy',
        items: [
          {
            title: 'Live sync state',
            body: 'Progress and server errors are reported per mailbox. An error marker on the rail stays visible without stopping healthy accounts from updating.',
          },
          {
            title: 'Repair credentials',
            body: 'When a mail password changes, Accounts shows the mail server’s own error and lets you replace the sealed credential in place.',
          },
          {
            title: 'Remove safely',
            body: 'Removing an account stops sync and drops Mainly’s local index for it; it never deletes the mailbox or messages from the mail server.',
          },
          {
            title: 'Two kinds of account',
            body: 'Mail accounts are the addresses Mainly reads and sends through. Sign-in is the separate Mainly user for this browser session, with its own password and sign-out control.',
          },
        ],
        action: { label: 'Open account settings', settingsTab: 'accounts' },
      },
    ],
  },
  {
    id: 'personalise',
    label: 'Personalise the UI',
    summary: 'Tune the theme, layout, row contents, colours and small interface details.',
    icon: <Palette size={15} />,
    sections: [
      {
        title: 'Appearance',
        items: [
          {
            title: 'Theme and accent',
            body: 'Choose light, dark or system mode and an accent colour. Changes apply immediately to focus rings, links, unread marks and selection.',
          },
          {
            title: 'Density and scale',
            body: 'Compact, cosy and relaxed densities change row height. Text size scales the whole interface, while corner radius controls how flat or rounded it feels.',
          },
          {
            title: 'Text weight',
            body: 'Light, Regular and Bold, applied to the whole interface. Worth a step up on a phone or a bright screen, where the default can read as thin. Bold is as heavy as the typeface goes while unread rows still look heavier than read ones, and printing always uses the default.',
          },
          {
            title: 'Contrast and motion',
            body: 'High contrast strengthens borders and secondary text. Reduce motion removes optional transitions in addition to respecting the operating-system preference.',
          },
          {
            title: 'Quick layout menu',
            body: 'The layout button above the list exposes density, preview position, account stripes and sender monograms without opening Settings.',
          },
        ],
        action: { label: 'Open appearance settings', settingsTab: 'appearance' },
      },
      {
        title: 'Colour and identity',
        items: [
          {
            title: 'Domain, account and folder colours',
            body: 'Each domain gets a colour used by rail tiles, row stripes and badges. Accounts can override it, and folder roles, custom folders, labels and mailbox groups can carry their own colours.',
          },
          {
            title: 'Domain pictograms',
            body: 'Right-click a domain in the rail to replace colliding initials with a searchable pictogram. Clear it at any time to return to letters.',
          },
          {
            title: 'Sender monograms and logos',
            body: 'Show or hide generated sender monograms in the list. Sender profiles can replace them with an HTTPS image for domains you explicitly authorise.',
          },
        ],
        action: { label: 'Open colour settings', settingsTab: 'colours' },
      },
      {
        title: 'Message list behaviour',
        items: [
          {
            title: 'Choose every column',
            body: 'Turn the account stripe, checkbox, unread dot, flag, monogram, sender, subject, preview, labels, account, attachment, size and date columns on or off.',
          },
          {
            title: 'Set the opening view',
            body: 'Choose the default sort, grouping and thread behaviour. The current list toolbar can temporarily override each without changing the defaults.',
          },
          {
            title: 'Timing and privacy',
            body: 'Set the automatic mark-read delay and undo window, decide how remote images load, and enable or disable send guards.',
          },
        ],
        action: { label: 'Open message list settings', settingsTab: 'list' },
      },
    ],
  },
  {
    id: 'mobile',
    label: 'Mobile & app install',
    summary: 'Use the touch-first shell, configure gestures and install Mainly.',
    icon: <Phone size={15} />,
    sections: [
      {
        title: 'Touch-first mail',
        items: [
          {
            title: 'A separate mobile shell',
            body: 'Below the mobile breakpoint, Mainly uses a full-bleed list and dedicated reader instead of squeezing the desktop columns. Scope and filter controls open as bottom sheets.',
          },
          {
            title: 'Pull to refresh',
            body: 'Pull the list down until the refresh indicator arms, then release. Sync progress uses the same space while accounts update.',
          },
          {
            title: 'Configurable swipes',
            body: 'Choose archive, trash, pin, read or nothing for each direction. A short swipe reveals a tappable action; a long swipe arms and commits it on release.',
          },
          {
            title: 'Mobile composing',
            body: 'Compose gets its own screen, keeps the From row visible and moves the send bar with the on-screen keyboard. A non-empty draft asks before being discarded.',
          },
        ],
        action: { label: 'Open mobile settings', settingsTab: 'mobile' },
      },
      {
        title: 'Install Mainly',
        items: [
          {
            title: 'Home screen or dock',
            body: 'Mainly is an installable web app. Use Add to Home Screen in Safari on iPhone or iPad, or the install action in Chrome or Edge on Android and desktop.',
          },
          {
            title: 'HTTPS requirement',
            body: 'Browsers only offer installation over HTTPS or localhost. Installing changes no server data and is optional; the normal browser tab has the same mail features.',
          },
          {
            title: 'Honest offline behaviour',
            body: 'The app shell is cached so it can launch promptly, but API responses are never cached as if they were current mail. When the server is unavailable, Mainly says so.',
          },
        ],
      },
    ],
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    summary: 'The complete keyboard map, kept in sync with the app.',
    icon: <Command size={15} />,
    showShortcuts: true,
    sections: [
      {
        title: 'How shortcuts behave',
        items: [
          {
            title: 'No shortcuts while typing',
            body: 'Single-key commands pause inside inputs, text areas, selectors and editable message fields. Platform copy and reload shortcuts are left to the browser.',
          },
          {
            title: 'Sequences stay local',
            body: 'Press g and then a role key within a moment. Inbox, Sent and the other role jumps stay inside the current domain or mailbox when that scope supports them.',
          },
        ],
      },
    ],
  },
  {
    id: 'layout',
    label: 'Interface map',
    summary: 'A compact reference for the controls and visual signals on screen.',
    icon: <Layout size={15} />,
    sections: [
      {
        title: 'Signals you can read without opening anything',
        items: [
          {
            title: 'Colour',
            body: 'Domain colour connects the rail, mailbox, account stripe and badges. Optional colours on folders, labels and groups add a second layer without replacing mailbox identity.',
          },
          {
            title: 'Unread and errors',
            body: 'Unread messages use the accent mark and stronger text. Rail dots summarize unread mail; a danger-coloured dot means at least one mailbox in that domain needs attention.',
          },
          {
            title: 'Hover and context actions',
            body: 'Row actions appear at the point of use, while right-click opens the complete action set for messages, folders, accounts, groups and domains.',
          },
          {
            title: 'Focus, selection and location',
            body: 'Keyboard focus, selected rows and the open message are separate states. The breadcrumb names location, checkboxes name selection, and the reader names what is open.',
          },
        ],
      },
      {
        title: 'Small navigation details',
        items: [
          {
            title: 'The Mainly mark is a control',
            body: 'At full width it returns to all mail. When a narrower desktop reader covers the list, the same position becomes Back to messages so it follows the visible layout.',
          },
          {
            title: 'Settings and Help stay at the edge',
            body: 'The question mark sits directly above the settings cog in the rail. Both open full-screen workspaces and Escape returns to mail.',
          },
          {
            title: 'Responsive settings',
            body: 'On narrower screens, settings categories move into a horizontally scrolling strip at the thumb edge instead of disappearing.',
          },
          {
            title: 'Tooltips include useful keys',
            body: 'Hover icon-only controls to see their name and, where available, the keyboard shortcut that performs the same action.',
          },
        ],
      },
    ],
  },
];

export function helpGuide(id: string | null | undefined): HelpGuide {
  return HELP_GUIDES.find((guide) => guide.id === id) ?? HELP_GUIDES[0]!;
}

export function guideSearchText(guide: HelpGuide): string {
  return [
    guide.label,
    guide.summary,
    ...guide.sections.flatMap((section) => [
      section.title,
      section.intro ?? '',
      ...section.items.flatMap((item) => [
        item.title,
        item.body,
        ...(item.details ?? []),
        ...(item.examples ?? []),
        ...(item.keys ?? []),
      ]),
    ]),
  ]
    .join(' ')
    .toLocaleLowerCase();
}
