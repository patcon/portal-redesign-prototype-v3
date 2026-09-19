/**
 * What jsdom does not implement but the components assume.
 *
 * Loaded for every test file, including the plain-Node ones, so each patch is
 * guarded on there being a DOM to patch at all.
 */
if (typeof window !== "undefined") {
  // jsdom has no layout, so it ships no scrolling either: `scrollTo` is simply
  // absent from Element. The chatcn transcript hook calls it on mount to pin
  // the thread to its latest message, and an absent method is a TypeError
  // rather than a no-op. There is nothing to assert about scroll position in a
  // engine that has none, so this is a stub, not a simulation.
  Element.prototype.scrollTo ??= () => {};
}
