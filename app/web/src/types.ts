export type Kind = 'html' | 'markdown' | 'pdf' | 'json' | 'site';
export type Visibility = 'private' | 'code' | 'link' | 'public';

/** An artifact in the trash (design 04): enough to list and restore it. */
export interface TrashItemDto {
  id: string; slug: string; title: string; kind: Kind; visibility: Visibility; project: string | null;
  deletedAt: string;
  /** When the purge deletes it for good (null when the trash is off). */
  purgeAt: string | null;
}

/** Full-text search (design 07): a result and the context of a text match (plain text, `hit` to highlight). */
export interface SnippetPart { text: string; hit: boolean }
export interface SearchResultDto { id: string; snippet: SnippetPart[] | null }

/** Operations of POST /artifacts/bulk (design 05). */
export type BulkOp = 'move' | 'addTags' | 'removeTags' | 'visibility' | 'pin' | 'unpin' | 'trash' | 'restore';

export interface ArtifactDto {
  id: string; slug: string; title: string; kind: Kind; visibility: Visibility; hasCode: boolean; memoryStorage: boolean; project: string | null; tags: string[];
  /** Optional text under the title (design 12). */
  description: string | null;
  createdAt: string; updatedAt: string; url: string;
  /** Most recent active share link (“link” visibility only). */
  activeLinkUrl: string | null;
  pinned: boolean; pinnedAt: string | null;
  /** Views counted by the content server: all time and over the last 30 days. */
  views: { total: number; last30: number };
  version: { id: string; number: number; message: string | null; originalName: string; sizeBytes: number; fileCount: number; createdAt: string } | null;
  /** Plain-text excerpt computed by the server (null for a PDF or an unreadable file). */
  preview: { heading: string | null; text: string | null } | null;
  /** Thumbnail of the current version, served by the admin API (relative path); null if none. */
  thumbnailUrl: string | null;
  /** Visibility of its project's folder (not private: the artifact is visible through the folder); null without a project. */
  folderVisibility: Visibility | null;
}

export interface LinkDto {
  id: string; label: string | null; url: string | null; expiresAt: string | null; revokedAt: string | null;
  lastUsedAt: string | null; createdAt: string; active: boolean; openCount: number;
}

export interface ArtifactDetail extends ArtifactDto { links: LinkDto[] }
export interface LabelCount<N = string> { name: N; count: number }

export interface DayCount { day: string; views: number; uniques: number }

export interface StatsDto {
  /** All time; `uniques` adds up the distinct visitors of each day. */
  total: { views: number; uniques: number };
  /** UTC days, oldest first, zero-filled. */
  days: DayCount[];
  lastVisitAt: string | null;
  links: { id: string; label: string | null; openCount: number; lastUsedAt: string | null; active: boolean }[];
}

export interface VersionDto {
  id: string; number: number; kind: Kind; originalName: string; sizeBytes: number; fileCount: number; createdAt: string; current: boolean;
  thumbnailUrl: string | null;
  /** What changed in this version (design 16), or null. */
  message: string | null;
}

/** Folder summary: artifact count, private count, folder visibility. `name: null` = no folder. */
export interface FolderSummary {
  name: string | null; count: number; privateCount: number; visibility: Visibility; title: string | null;
  /** Parent folder name (null at root) and position among its siblings. */
  parent: string | null; position: number | null;
  /** Direct sub-folders. */
  childCount: number;
  /** Latest activity: folder sheet or most recent artifact (null: nothing). */
  latestUpdatedAt: string | null;
  /** Up to 4 artifacts, newest first: the folder card mosaic. */
  recent: { id: string; kind: Kind; title: string; thumbnailUrl: string | null }[];
  /** Visitor address of the folder and active share link (null for “no folder”). */
  url: string | null; activeLinkUrl: string | null;
}

export interface FolderArtifact {
  id: string; slug: string; title: string; kind: Kind; visibility: Visibility; position: number | null; updatedAt: string;
  versionNumber: number | null; thumbnailUrl: string | null;
}

/** Shareable folder of a project (sheet created on the fly). */
export interface FolderDetail {
  name: string; title: string | null; description: string | null; visibility: Visibility; hasCode: boolean;
  /** False until the folder has been described or shared (implicitly private). */
  hasSheet: boolean;
  createdAt: string | null; updatedAt: string | null;
  url: string; activeLinkUrl: string | null; count: number; privateCount: number;
  /** In visitor page order. */
  artifacts: FolderArtifact[];
  links: LinkDto[];
  /** Parent folder name (null at root). */
  parent: string | null;
  /** Ancestors, root first, without this folder. */
  ancestors: { name: string; title: string | null }[];
  /** Direct sub-folders in visitor order. */
  children: { name: string; title: string | null; visibility: Visibility; count: number }[];
}
