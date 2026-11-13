import { renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Consistent hot copy of the database, run INSIDE the container (the host does not need sqlite3).
const dataDir = resolve(process.env.DATA_DIR || '/data');
const target = join(dataDir, 'backup', 'hub.sqlite');
const tmp = `${target}.tmp`;
rmSync(tmp, { force: true });
const db = new DatabaseSync(join(dataDir, 'hub.sqlite'));
db.prepare('VACUUM INTO ?').run(tmp);
db.close();
renameSync(tmp, target);
console.log(target);
