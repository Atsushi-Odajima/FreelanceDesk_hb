import { createPool } from './db';
import { migrate } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL が必要です');
  process.exit(1);
}
const pool = createPool(url);
migrate(pool, console.log)
  .then(() => console.log('migrations up to date'))
  .catch((e) => {
    console.error('migration failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
