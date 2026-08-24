import { createApp } from './app.js';
import { config } from './config.js';

// Belt and braces behind asyncRoute: under Node 20's default --unhandled-rejections=throw,
// a promise rejection that escapes an Express handler terminates the process with exit
// code 1, taking every in-flight request down with it. Every async handler is wrapped in
// asyncRoute, but a future handler someone forgets to wrap must not be able to kill the
// server for a single bad request.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process kept alive):', reason);
});

const app = createApp();
app.listen(config.port, () => {
  console.log(`compliance-swarm-server listening on port ${config.port}`);
});
