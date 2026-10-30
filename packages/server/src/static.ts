/** The built UI, served with an SPA fallback: unknown non-`/api` paths get `index.html`. */
import { stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

const NOT_BUILT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>wattsim</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem">
<h1>wattsim</h1>
<p>UI not built: run <code>bun run --filter @wattsim/ui build</code></p>
<p>The API is up at <code>/api</code>.</p>
</body>
</html>
`;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function serveUi(uiDir: string, urlPath: string): Promise<Response> {
  const index = join(uiDir, 'index.html');
  if (!(await isFile(index))) {
    return new Response(NOT_BUILT, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    rel = '/';
  }
  const file = normalize(join(uiDir, rel));
  // Never leave the UI directory (`/../..`).
  if (file.startsWith(uiDir + sep) && (await isFile(file))) return new Response(Bun.file(file));
  return new Response(Bun.file(index), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
