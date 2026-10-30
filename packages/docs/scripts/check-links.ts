/**
 * Fails when a page of the static export links to something the export does not contain: a missing page, a missing
 * file under public/, or a `#fragment` with no element of that id on the target page.
 *
 * Usage: bun scripts/check-links.ts [outDir]. External links (any scheme, or protocol-relative) are not fetched.
 * DOCS_BASE_PATH, as given to the build, is stripped from internal links before resolving them.
 */
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? join(import.meta.dir, '../out'));
const basePath = process.env.DOCS_BASE_PATH?.replace(/\/+$/, '') ?? '';

if (!existsSync(outDir)) {
  console.error(`check-links: ${outDir} does not exist; run the build first`);
  process.exit(2);
}

const pages = new Map<string, string>();
for await (const file of new Bun.Glob('**/*.html').scan({ cwd: outDir })) {
  pages.set(file, await Bun.file(join(outDir, file)).text());
}

/** Element ids of a page, decoded the way a browser matches fragments. */
const idCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let ids = idCache.get(file);
  if (!ids) {
    ids = new Set([...(pages.get(file) ?? '').matchAll(/\sid="([^"]*)"/g)].map((m) => decodeEntities(m[1] ?? '')));
    idCache.set(file, ids);
  }
  return ids;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The exported file a site path is served from, or undefined. */
function resolveTarget(path: string): string | undefined {
  const rel = decodeURIComponent(path).replace(/^\/+/, '');
  const candidates = rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) {
    const abs = join(outDir, c);
    if (existsSync(abs) && statSync(abs).isFile()) return c;
  }
  return undefined;
}

/** The site path of an exported HTML file, as a directory URL ("docs/x/index.html" -> "/docs/x/"). */
function pathOf(file: string): string {
  return `/${file.replace(/index\.html$/, '').replace(/\.html$/, '')}`;
}

const broken: string[] = [];
let checked = 0;

for (const [file, html] of pages) {
  // Next's own 404 page is served for unknown paths; it links nowhere of interest.
  if (file === '404.html' || file.startsWith('_not-found')) continue;
  for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const raw = decodeEntities(m[2] ?? '');
    if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
    checked++;
    const [beforeHash = '', fragment] = raw.split('#', 2);
    const pathPart = beforeHash.split('?')[0] ?? '';
    let target: string | undefined;
    if (pathPart === '') {
      target = file;
    } else {
      const absolute = new URL(pathPart, `http://site${basePath}${pathOf(file)}`).pathname;
      if (basePath && !absolute.startsWith(`${basePath}/`) && absolute !== basePath) {
        broken.push(`${file}: ${raw} (outside the base path ${basePath})`);
        continue;
      }
      target = resolveTarget(absolute.slice(basePath.length));
      if (!target) {
        broken.push(`${file}: ${raw} (no such file)`);
        continue;
      }
    }
    if (fragment && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(fragment))) {
      broken.push(`${file}: ${raw} (no element with id "${fragment}" on ${target})`);
    }
  }
}

if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken internal link(s) in ${relative(process.cwd(), outDir)}:`);
  for (const b of [...new Set(broken)].sort()) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links across ${pages.size} pages, all resolve`);
