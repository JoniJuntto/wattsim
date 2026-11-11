/**
 * Stands in for `node:crypto`, which @wattsim/pki imports at module level for certificate handling the game never
 * uses. One value absorbs any use: callable, constructible, every property is itself.
 */
// biome-ignore lint/suspicious/noExplicitAny: a stand-in for modules the game never really calls
const noop: any = new Proxy(function stub() {}, { get: () => noop, apply: () => noop, construct: () => noop });

export const createHash = noop;
export default noop;
