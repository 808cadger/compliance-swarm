// Express 4 does not await async handlers: a rejected promise inside one is an unhandled
// rejection, which under Node 20's default --unhandled-rejections=throw kills the whole
// process — not just the one request. Every async handler/middleware must be wrapped so the
// rejection is forwarded to Express's error pipeline instead.
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
