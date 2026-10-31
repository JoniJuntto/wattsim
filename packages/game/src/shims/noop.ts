/** Absorbs any use: callable, constructible (so the target is a plain function), every property is itself. */
// biome-ignore lint/suspicious/noExplicitAny: a stand-in for modules the game never really calls
export const noop: any = new Proxy(function stub() {}, { get: () => noop, apply: () => noop, construct: () => noop });
