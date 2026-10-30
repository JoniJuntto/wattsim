export const appName = 'wattsim';
export const repoUrl = 'https://github.com/JoniJuntto/wattsim';

/** The path prefix of the deployed site ('' locally, '/wattsim' on GitHub Pages). */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** A file under public/, with the base path that next/link adds to links but plain <img> does not. */
export function asset(path: string): string {
  return `${basePath}${path}`;
}
