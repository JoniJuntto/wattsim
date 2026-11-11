import { expect, test } from 'bun:test';
import { folderNames, groupByFolder, matchesQuery } from '../src/lib/folders';
import { station } from './fixtures';

const fleet = [
  station({ id: 'CP-3', folder: 'Depot B' }),
  station({ id: 'CP-1' }),
  station({ id: 'CP-2', folder: 'Depot A' }),
  station({ id: 'CP-4', folder: 'Depot B' }),
];

test('groups by folder, folders sorted by name, ungrouped last, station order kept', () => {
  expect(groupByFolder(fleet).map((g) => [g.folder, g.stations.map((s) => s.id)])).toEqual([
    ['Depot A', ['CP-2']],
    ['Depot B', ['CP-3', 'CP-4']],
    [undefined, ['CP-1']],
  ]);
  expect(folderNames(fleet)).toEqual(['Depot A', 'Depot B']);
});

test('the filter matches the station id or its folder, ignoring case', () => {
  const ids = (q: string) => fleet.filter((s) => matchesQuery(s, q)).map((s) => s.id);
  expect(ids('depot b')).toEqual(['CP-3', 'CP-4']);
  expect(ids('cp-1')).toEqual(['CP-1']);
  expect(ids('  ')).toEqual(['CP-3', 'CP-1', 'CP-2', 'CP-4']);
});
