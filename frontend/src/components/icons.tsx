/**
 * Icon set. 16px grid, 1.5 stroke, currentColor, no fills.
 *
 * Hand-drawn rather than pulled from a library: the whole set is ~3KB, matches
 * the stroke weight of the type, and never introduces an icon that does not
 * belong to this product.
 */

import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Inbox = (p: P) => (
  <Svg {...p}>
    <path d="M2 9.5h3l1 2h4l1-2h3M2 9.5 3.6 3.4A1 1 0 0 1 4.6 2.6h6.8a1 1 0 0 1 1 .8L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </Svg>
);

export const Send = (p: P) => (
  <Svg {...p}>
    <path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z" />
  </Svg>
);

export const Draft = (p: P) => (
  <Svg {...p}>
    <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6zM9 2v4h4" />
  </Svg>
);

export const Archive = (p: P) => (
  <Svg {...p}>
    <path d="M2 5h12M3 5v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5M2.5 5 3.4 2.6h9.2L14 5M6.5 8.5h3" />
  </Svg>
);

export const Trash = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4h11M6 4V2.8h4V4M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4M6.5 7v4M9.5 7v4" />
  </Svg>
);

export const Junk = (p: P) => (
  <Svg {...p}>
    <path d="M8 2 2 5v3.5c0 3 2.5 5.4 6 6.5 3.5-1.1 6-3.5 6-6.5V5zM8 6v3M8 11h.01" />
  </Svg>
);

export const Star = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="m8 2 1.85 3.9 4.15.6-3 3 .7 4.3L8 11.8 4.3 13.8l.7-4.3-3-3 4.15-.6z" />
  </Svg>
);

export const Dot = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <circle cx="8" cy="8" r="3.5" />
  </Svg>
);

export const Attachment = (p: P) => (
  <Svg {...p}>
    <path d="M11.5 7.5 7 12a2.8 2.8 0 0 1-4-4l5-5a2 2 0 0 1 2.8 2.8L6 10.6a1.2 1.2 0 0 1-1.7-1.7L8.5 4.7" />
  </Svg>
);

export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Svg>
);

export const Chevron = ({ dir = 'down', ...p }: P & { dir?: 'up' | 'down' | 'left' | 'right' }) => {
  const rot = { up: 180, down: 0, left: 90, right: -90 }[dir];
  return (
    <Svg {...p} style={{ transform: `rotate(${rot}deg)`, ...p.style }}>
      <path d="m4 6.5 4 4 4-4" />
    </Svg>
  );
};

export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const Close = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const Reply = (p: P) => (
  <Svg {...p}>
    <path d="M6 4 2.5 7.5 6 11M2.5 7.5H9a4.5 4.5 0 0 1 4.5 4.5v1" />
  </Svg>
);

export const ReplyAll = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 4 2 7.5 5.5 11M9 4 5.5 7.5 9 11M5.5 7.5h5A4 4 0 0 1 14.5 11.5v1" />
  </Svg>
);

export const Forward = (p: P) => (
  <Svg {...p}>
    <path d="M10 4l3.5 3.5L10 11M13.5 7.5H7A4.5 4.5 0 0 0 2.5 12v1" />
  </Svg>
);

export const Settings = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
  </Svg>
);

export const Sort = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M3 8h6.5M3 11.5h3.5" />
  </Svg>
);

export const Group = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 3.5h11M2.5 7h5M2.5 10.5h11M2.5 14h5" />
  </Svg>
);

export const Filter = (p: P) => (
  <Svg {...p}>
    <path d="M2 4h12l-4.5 5v4.5l-3-1.5V9z" />
  </Svg>
);

export const Refresh = (p: P) => (
  <Svg {...p}>
    <path d="M13.5 7a5.5 5.5 0 1 0-1.3 4.2M13.5 3.5V7H10" />
  </Svg>
);

export const Layout = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M6.5 3v10" />
  </Svg>
);

export const Palette = (p: P) => (
  <Svg {...p}>
    <path d="M8 14a6 6 0 1 1 6-6c0 1.4-1.1 2-2.2 2H10a1.4 1.4 0 0 0-1 2.4c.3.4.2 1.1-.5 1.4A2 2 0 0 1 8 14z" />
    <circle cx="5.6" cy="6.4" r=".9" fill="currentColor" stroke="none" />
    <circle cx="9" cy="4.9" r=".9" fill="currentColor" stroke="none" />
  </Svg>
);

export const User = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="5.5" r="2.6" />
    <path d="M2.9 13.6a5.3 5.3 0 0 1 10.2 0" />
  </Svg>
);

export const Globe = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.7 1.8 2.6 3.9 2.6 6S9.7 12.2 8 14C6.3 12.2 5.4 10.1 5.4 8S6.3 3.8 8 2z" />
  </Svg>
);

export const Folder = (p: P) => (
  <Svg {...p}>
    <path d="M2 12.5v-9h4l1.4 1.8H14v7.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </Svg>
);

export const Warning = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.4 14.4 13.2H1.6zM8 6.6v3M8 11.4h.01" />
  </Svg>
);

export const Check = (p: P) => (
  <Svg {...p}>
    <path d="m3 8.4 3.2 3.2L13 4.6" />
  </Svg>
);

export const Undo = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 7h7.2a3.8 3.8 0 0 1 0 7.6H6M2.5 7l3-3M2.5 7l3 3" />
  </Svg>
);

export const Command = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 2.5a1.6 1.6 0 1 0 1.6 1.6v7.8a1.6 1.6 0 1 0 1.6-1.6H4.1a1.6 1.6 0 1 0 1.6 1.6V4.1a1.6 1.6 0 1 0-1.6 1.6h7.8a1.6 1.6 0 1 0-1.6-1.6z" />
  </Svg>
);

export const Priority = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 14V2.5M3.5 3h8l-1.6 2.6L11.5 8.5h-8" />
  </Svg>
);

export const Eye = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.9" />
  </Svg>
);

export const Clock = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.4 1.6" />
  </Svg>
);

export const Phone = (p: P) => (
  <Svg {...p}>
    <rect x="5.2" y="2.6" width="5.6" height="10.8" rx="1.6" />
    <path d="M7.2 12.3h1.6" />
  </Svg>
);

export const Key = (p: P) => (
  <Svg {...p}>
    <circle cx="5.4" cy="10.6" r="3.4" />
    <path d="m7.8 8.2 6-6M11.4 4.6l1.6 1.6M9.8 6.2l1.6 1.6" />
  </Svg>
);

export const SignOut = (p: P) => (
  <Svg {...p}>
    <path d="M6.2 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2.7M9.6 5.2 12.4 8l-2.8 2.8M12.4 8H6.4" />
  </Svg>
);
