// Runs one of the maintenance scripts (db-backup, db-verify, db-restore,
// user-password, …) in whichever form this installation has it:
//
//   - the production image carries compiled JavaScript (dist/scripts/*.js)
//     and no TypeScript loader;
//   - a checkout runs the TypeScript source through tsx.
//
// `npm run db:backup --workspace=server -- <args>` therefore means the same
// thing in the container and on a developer machine.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const name = process.argv[2];
if (!name || !/^[a-z-]+$/.test(name)) {
  console.error('Usage: node run-script.mjs <script-name> [arguments]');
  process.exit(2);
}
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const compiled = here(`./dist/scripts/${name}.js`);
const source = here(`./src/scripts/${name}.ts`);

if (existsSync(compiled)) {
  // The script reads its own arguments from process.argv[2…].
  process.argv.splice(2, 1);
  await import(pathToFileURL(compiled).href);
} else if (existsSync(source)) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', source, ...process.argv.slice(3)],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
} else {
  console.error(`No such script: ${name}`);
  process.exit(2);
}
