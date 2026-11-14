import { Link } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & Record<`data-${string}`, unknown>;

/**
 * Real link to a folder page (`name` null: the gallery root), so Cmd/Ctrl/middle click and “Copy link” work.
 * A plain click runs `onOpen` instead (same navigation, plus the gallery's focus and search handling).
 */
export function FolderLink({ name, onOpen, ...rest }: AnchorProps & { name: string | null; onOpen: () => void }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen();
  };
  // Exact match: the root link must not count as “current page” (aria-current) on every folder page.
  return name === null
    ? <Link to="/" activeOptions={{ exact: true }} onClick={onClick} {...rest} />
    : <Link to="/f/$folder" params={{ folder: name }} activeOptions={{ exact: true }} onClick={onClick} {...rest} />;
}
