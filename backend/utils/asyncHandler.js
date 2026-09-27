export const asyncHandler = (fn) => {
  if (typeof fn !== 'function') {
    const name = fn?.name || String(fn);
    console.error(`[asyncHandler] Not a function: ${name}`);
    throw new TypeError(`asyncHandler expected a function, got ${typeof fn} (${name})`);
  }
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};