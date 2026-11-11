/** Folders group stations on the fleet page. A folder exists only while a station names it. */
import type { StationView } from '@/api/types';

export type FolderGroup = { folder: string | undefined; stations: StationView[] };

/** One group per folder sorted by name, then the stations without one; stations keep their order. */
export function groupByFolder(stations: StationView[]): FolderGroup[] {
  const groups = new Map<string | undefined, StationView[]>();
  for (const s of stations) {
    const list = groups.get(s.folder);
    if (list) list.push(s);
    else groups.set(s.folder, [s]);
  }
  return [...groups]
    .map(([folder, list]) => ({ folder, stations: list }))
    .sort((a, b) =>
      a.folder === undefined
        ? 1
        : b.folder === undefined
          ? -1
          : a.folder.localeCompare(b.folder, undefined, { numeric: true }),
    );
}

export function folderNames(stations: StationView[]): string[] {
  return groupByFolder(stations).flatMap((g) => (g.folder === undefined ? [] : [g.folder]));
}

export function matchesQuery(s: StationView, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || s.id.toLowerCase().includes(q) || (s.folder?.toLowerCase().includes(q) ?? false);
}
