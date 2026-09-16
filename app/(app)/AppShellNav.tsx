'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * App-shell navigation — Module 08 §7.5: "Four tabs: Home · Trades ·
 * Rulebook · Performance. Strategy lives inside Rulebook." Rendered to
 * match `retrospeq-design-system/brand/docs/instrument.html`'s tab bar
 * (same icons, `.rq-tabs`/`.rq-tab`).
 *
 * Client component only because the active tab comes from the pathname
 * (`usePathname` can't run in a Server Component). The auth/AAL gate
 * stays in `layout.tsx`, a Server Component — nothing here is a
 * security boundary.
 *
 * Deliberately no `.rq-btn` and no `<form>` anywhere in the shell: the
 * "one primary per view" E2E checks count `.rq-btn` page-wide, and
 * sign-out lives on `/settings` instead of in persistent chrome.
 */

type Section = 'home' | 'trades' | 'rulebook' | 'performance' | 'settings';

const SECTION_PREFIXES: Array<[Section, string[]]> = [
  ['home', ['/dashboard', '/review', '/onboarding']],
  ['trades', ['/trades']],
  ['rulebook', ['/rules', '/strategies', '/fields']],
  ['performance', ['/performance']],
  ['settings', ['/settings', '/accounts', '/plan', '/security', '/privacy']],
];

function matches(pathname: string | null, prefix: string): boolean {
  if (!pathname) return false;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `usePathname()` is typed `string` but genuinely returns `null` outside
 *  a router context — which every one of these components now hits, since
 *  `RulebookSubnav` moved out of the layout and into four pages that are
 *  rendered directly by unit tests (`app/(app)/rules/new/__tests__/
 *  page.test.ts` crashed on exactly this). `null` means "no section",
 *  never a throw. */
export function sectionFor(pathname: string | null): Section | null {
  for (const [section, prefixes] of SECTION_PREFIXES) {
    if (prefixes.some((p) => matches(pathname, p))) return section;
  }
  return null;
}

const TABS: Array<{ section: Section; href: string; label: string; icon: React.ReactNode }> = [
  {
    section: 'home',
    href: '/dashboard',
    label: 'Home',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="currentColor" />
      </svg>
    ),
  },
  {
    section: 'trades',
    href: '/trades',
    label: 'Trades',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 19v-7M10 19V6M16 19v-4M21 19v-9" />
      </svg>
    ),
  },
  {
    section: 'rulebook',
    href: '/rules',
    label: 'Rulebook',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h9M4 12h9M4 18h6M16 16.5l2 2 4-4.5" />
      </svg>
    ),
  },
  {
    section: 'performance',
    href: '/performance',
    label: 'Performance',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 17l5.5-6 4 3.5L21 6" />
      </svg>
    ),
  },
];

export function TabBar() {
  const section = sectionFor(usePathname());
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10">
      <div className="rq-tabs mx-auto max-w-[32rem]">
        {TABS.map((tab) => (
          <Link
            key={tab.section}
            href={tab.href}
            className="rq-tab"
            aria-current={section === tab.section ? 'page' : undefined}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

const RULEBOOK_LINKS = [
  { href: '/rules', label: 'Rules' },
  { href: '/strategies', label: 'Strategies' },
  { href: '/fields', label: 'Fields' },
];

/**
 * "Strategy lives inside Rulebook" — the three Rulebook views as pills.
 *
 * Rendered by each screen that shows it (`/rules`, `/rules/new`,
 * `/strategies`, `/fields`), directly under that screen's own `<h1>`,
 * per every frame in `brand/docs/screens/rulebook.html` that has pills at
 * all — NOT by `app/(app)/layout.tsx`, which can only put chrome above
 * the heading. The section guard below stays as a defensive no-op so a
 * future caller outside the tab can't accidentally render a nav whose
 * pills would all read inactive.
 */
export function RulebookSubnav() {
  const pathname = usePathname();
  if (sectionFor(pathname) !== 'rulebook') return null;
  return (
    <nav aria-label="Rulebook" className="rq-pills">
      {RULEBOOK_LINKS.map((link) => {
        const active = matches(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={active ? 'rq-pill on' : 'rq-pill'}
            aria-current={active ? 'page' : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Settings entry in the top bar — highlighted while on any settings-group page. */
export function SettingsLink() {
  const active = sectionFor(usePathname()) === 'settings';
  return (
    <Link
      href="/settings"
      aria-label="Settings"
      aria-current={active ? 'page' : undefined}
      className={`flex h-11 w-11 items-center justify-center rounded-full ${active ? 'text-accent-ink' : 'text-ink-soft hover:text-ink'}`}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </Link>
  );
}
