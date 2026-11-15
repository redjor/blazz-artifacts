import { createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router';
import { App } from './App.tsx';

/**
 * Admin routes. The gallery (Dashboard) lives in the root component and reads the location, so moving between
 * folders keeps its state (list, view, focus); child routes only name the URLs.
 *   /             gallery root            /f/<name>   a folder (names are unique)
 *   /unfiled      artifacts with no folder            ?a=<id>     an artifact's panel, over any of them
 *   /trash        deleted artifacts, restorable for TRASH_DAYS days (design 04)
 */
export interface GallerySearch { a?: string }

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): GallerySearch => (typeof search.a === 'string' && search.a ? { a: search.a } : {}),
  component: App,
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' });
const folderRoute = createRoute({ getParentRoute: () => rootRoute, path: 'f/$folder' });
const unfiledRoute = createRoute({ getParentRoute: () => rootRoute, path: 'unfiled' });
const trashRoute = createRoute({ getParentRoute: () => rootRoute, path: 'trash' });
// Any other path: back to the gallery root (rendered by App's Outlet).
const otherRoute = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => <Navigate to="/" replace /> });

const routeTree = rootRoute.addChildren([indexRoute, folderRoute, unfiledRoute, trashRoute, otherRoute]);

// Plain query strings (`?a=123`, never `?a=%22123%22`): the search holds flat string values only.
const parseSearch = (s: string): Record<string, unknown> => Object.fromEntries(new URLSearchParams(s));
const stringifySearch = (search: Record<string, unknown>): string => {
  const entries = Object.entries(search).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '');
  const s = new URLSearchParams(entries).toString();
  return s ? `?${s}` : '';
};

/** Old hash links (#project=x&a=id) still open the right page: rewritten once, before the router reads the URL. */
function upgradeLegacyHash(): void {
  const legacy = new URLSearchParams(window.location.hash.slice(1));
  const project = legacy.get('project');
  const a = legacy.get('a');
  if (!project && !a) return;
  const path = !project ? '/' : project === '~none' ? '/unfiled' : `/f/${encodeURIComponent(project)}`;
  window.history.replaceState(null, '', a ? `${path}?a=${encodeURIComponent(a)}` : path);
}

upgradeLegacyHash();

export const router = createRouter({ routeTree, parseSearch, stringifySearch });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
