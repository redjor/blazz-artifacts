import type { ReactNode } from 'react';
import type { Kind, Visibility } from './types.ts';

// Home-made icon set: 24 grid, 1.5 stroke, round caps, inherited colour (currentColor).
function Svg({ children, className = 'size-5' }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      {children}
    </svg>
  );
}

type P = { className?: string };

export const SearchIcon = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></Svg>;
export const FilterIcon = (p: P) => <Svg {...p}><path d="M4 5h16l-6.2 7.4v5.4L10.2 20v-7.6z" /></Svg>;
export const ListIcon = (p: P) => <Svg {...p}><path d="M9 6.5h11M9 12h11M9 17.5h11" /><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" strokeWidth={2.4} /></Svg>;
export const GridIcon = (p: P) => (
  <Svg {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></Svg>
);
export const PlusIcon = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const CloseIcon = (p: P) => <Svg {...p}><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" /></Svg>;
export const MoreIcon = (p: P) => <Svg {...p}><path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.6} /></Svg>;
export const OpenIcon = (p: P) => <Svg {...p}><path d="M14 4h6v6M20 4l-8.5 8.5" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Svg>;
export const CopyIcon = (p: P) => <Svg {...p}><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></Svg>;
export const SlidersIcon = (p: P) => <Svg {...p}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>;
export const LogoutIcon = (p: P) => <Svg {...p}><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" /></Svg>;
export const UploadIcon = (p: P) => <Svg {...p}><path d="M12 15V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" /></Svg>;
export const PinIcon = (p: P) => <Svg {...p}><path d="M9 4h6l-1 5.5 3.5 3.5h-11L10 9.5z" /><path d="M12 13v7" /></Svg>;
export const ShareIcon = (p: P) => <Svg {...p}><path d="M12 15V4M8 7.5 12 4l4 3.5" /><path d="M8.5 10.5H7a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-1.5" /></Svg>;
export const SortIcon = (p: P) => <Svg {...p}><path d="M8 4.5v15M4.5 8 8 4.5 11.5 8" /><path d="M16 19.5v-15M12.5 16l3.5 3.5 3.5-3.5" /></Svg>;
export const KeyboardIcon = (p: P) => (
  <Svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13.5h.01M16 13.5h.01" strokeWidth={2.2} /><path d="M9.5 14h5" /></Svg>
);
export const ChevronUpIcon = (p: P) => <Svg {...p}><path d="m6.5 14.5 5.5-5.5 5.5 5.5" /></Svg>;
export const ChevronDownIcon = (p: P) => <Svg {...p}><path d="m6.5 9.5 5.5 5.5 5.5-5.5" /></Svg>;
export const FolderPlusIcon = (p: P) => (
  <Svg {...p}><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M12 11.5v5M9.5 14h5" /></Svg>
);
export const FolderIcon = (p: P) => <Svg {...p}><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></Svg>;
export const ChevronLeftIcon = (p: P) => <Svg {...p}><path d="m14.5 6.5-5.5 5.5 5.5 5.5" /></Svg>;
export const ChevronRightIcon = (p: P) => <Svg {...p}><path d="m9.5 6.5 5.5 5.5-5.5 5.5" /></Svg>;
/** Filled folder (folder cards): flat, inherited tint. */
export const FolderFilledIcon = ({ className = 'size-5' }: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
    <path d="M2.5 6.75A2.25 2.25 0 0 1 4.75 4.5h4.07c.6 0 1.17.24 1.6.66L12.1 6.8h7.15a2.25 2.25 0 0 1 2.25 2.25v8.7A2.25 2.25 0 0 1 19.25 20H4.75a2.25 2.25 0 0 1-2.25-2.25z" />
  </svg>
);
export const TrashIcon = (p: P) => <Svg {...p}><path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /><path d="M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7" /></Svg>;
export const GripIcon = (p: P) => <Svg {...p}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.6} /></Svg>;
export const ArrowUpIcon = (p: P) => <Svg {...p}><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" /></Svg>;
export const ArrowDownIcon = (p: P) => <Svg {...p}><path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" /></Svg>;
export const CheckIcon = (p: P) => <Svg {...p}><path d="m5.5 12.5 4 4 9-9" /></Svg>;
export const TagIcon = (p: P) => <Svg {...p}><path d="M4 12.6V5.5A1.5 1.5 0 0 1 5.5 4h7.1a1.5 1.5 0 0 1 1.06.44l6 6a1.5 1.5 0 0 1 0 2.12l-7.1 7.1a1.5 1.5 0 0 1-2.12 0l-6-6A1.5 1.5 0 0 1 4 12.6z" /><path d="M8.5 8.5h.01" strokeWidth={2.4} /></Svg>;
export const EyeIcon = (p: P) => <Svg {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.75" /></Svg>;

// Types publiables.
const DocumentIcon = (p: P) => <Svg {...p}><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" /><path d="M14 3.5V8h4.5" /></Svg>;
const PageIcon = (p: P) => <Svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 8.5h17" /><path d="m10 12.5-2 2 2 2M14 12.5l2 2-2 2" /></Svg>;
const SiteIcon = (p: P) => <Svg {...p}><path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 16 8.5 4.5 8.5-4.5" /></Svg>;
const PdfIcon = (p: P) => <Svg {...p}><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" /><path d="M14 3.5V8h4.5" /><path d="M9 12.5h6M9 16h4" /></Svg>;
const JsonIcon = (p: P) => (
  <Svg {...p}><path d="M8.5 4C6.5 4 6 5 6 6.8v2.4C6 10.6 5.2 11.6 4 12c1.2.4 2 1.4 2 2.8v2.4C6 19 6.5 20 8.5 20" /><path d="M15.5 4c2 0 2.5 1 2.5 2.8v2.4c0 1.4.8 2.4 2 2.8-1.2.4-2 1.4-2 2.8v2.4c0 1.8-.5 2.8-2.5 2.8" /></Svg>
);

export const KIND_ICON: Record<Kind, (p: P) => ReactNode> = { markdown: DocumentIcon, html: PageIcon, site: SiteIcon, pdf: PdfIcon, json: JsonIcon };

// Visibility: always paired with its label (never colour alone).
const LockIcon = (p: P) => <Svg {...p}><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>;
const KeyIcon = (p: P) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" /></Svg>;
export const WarningIcon = (p: P) => <Svg {...p}><path d="M10.3 4.6 3.4 16.8A2 2 0 0 0 5.1 19.8h13.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4M12 16.8h.01" /></Svg>;
export const LinkIcon = (p: P) => <Svg {...p}><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></Svg>;
const GlobeIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z" /></Svg>;

export const VISIBILITY_ICON: Record<Visibility, (p: P) => ReactNode> = { private: LockIcon, code: KeyIcon, link: LinkIcon, public: GlobeIcon };
