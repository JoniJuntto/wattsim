import { resolve } from 'node:path';

/** The repository checkout this package lives in. */
export const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** Where repo files are browsed on GitHub; links to files without a page on this site go here. */
export const REPO_URL = 'https://github.com/JoniJuntto/wattsim';
export const REPO_BLOB = `${REPO_URL}/blob/main`;
