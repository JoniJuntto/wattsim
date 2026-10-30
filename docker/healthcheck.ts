// Docker HEALTHCHECK: exit 0 when the UI server answers /api/health. The image has no curl; Bun is enough.
// The port is the first argument, default 7700 as in the image's CMD.
const port = Bun.argv[2] ?? '7700';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
