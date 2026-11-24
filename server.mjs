import { config } from './lib/config.mjs';
import { db } from './lib/database.mjs';
import { createApplicationServer } from './lib/application.mjs';
import { createScheduler } from './lib/scheduler.mjs';

const server = createApplicationServer();
const scheduler = createScheduler();

async function shutdown(signal) {
  console.log(`Final Cog is stopping (${signal}).`);
  await scheduler.stop();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  db.close();
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

scheduler.start();
server.listen(config.port, config.host, () => {
  console.log(`Final Cog is listening on ${config.host}:${config.port}.`);
});
