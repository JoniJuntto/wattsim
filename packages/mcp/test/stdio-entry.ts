// Subprocess entry for the stdio test: what `wattsim mcp` runs, plus a stray console.log that must not reach stdout.
import { serveStdio } from '../src/index';

const running = await serveStdio();
console.log('this line must go to stderr');
console.info('so must this one');
await running.closed;
process.exit(0);
