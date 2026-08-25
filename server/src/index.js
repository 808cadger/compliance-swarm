import { createApp, describeErrorForLog } from './app.js';
import { config } from './config.js';

// Belt and braces behind asyncRoute: under Node 20's default --unhandled-rejections=throw,
// a promise rejection that escapes an Express handler terminates the process with exit
// code 1, taking every in-flight request down with it. Every async handler is wrapped in
// asyncRoute, but a future handler someone forgets to wrap must not be able to kill the
// server for a single bad request.
//
// `reason` here is exactly the same kind of value errorHandler in app.js logs — today it's
// unreachable (asyncRoute forwards every rejection to errorHandler instead), but this is the
// backstop for a future handler that isn't wrapped, so it must not log a raw Error the same
// way the pre-Stage-4 bug in app.js did. Reuse the same redaction rather than duplicating it.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process kept alive):', describeErrorForLog(reason));
});

const app = createApp();
app.listen(config.port, () => {
  console.log(`compliance-swarm-server listening on port ${config.port}`);
});
