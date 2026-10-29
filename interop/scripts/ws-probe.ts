// Opens an OCPP websocket to a CSMS and reports the negotiated subprotocol / close code.
// Usage: bun interop/scripts/ws-probe.ts <ws-url> [subprotocol=ocpp1.6]
const [url, proto = 'ocpp1.6'] = process.argv.slice(2);
if (!url) throw new Error('usage: bun interop/scripts/ws-probe.ts <ws-url> [subprotocol]');
const ws = new WebSocket(url, [proto]);
const timer = setTimeout(() => { console.log(`TIMEOUT ${url}`); process.exit(2); }, 10_000);
ws.onopen = () => console.log(`OPEN ${url} protocol=${ws.protocol || '(none)'}`);
ws.onclose = (e) => { clearTimeout(timer); console.log(`CLOSE ${url} code=${e.code} reason=${e.reason || '-'}`); process.exit(e.code === 1000 ? 0 : 1); };
ws.onerror = (e) => console.log(`ERROR ${url} ${(e as ErrorEvent).message ?? ''}`);
setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'probe done'); }, 1500);
