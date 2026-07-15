/**
 * Local development Postgres without Docker: runs an embedded PostgreSQL 16 in
 * .devdb/ (binaries live in node_modules, nothing is installed system-wide).
 *
 *   npm run dev:db                                 # start and keep running
 *   npm run dev:db -- -- npx prisma migrate dev    # run a command against it
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import EmbeddedPostgres from 'embedded-postgres'

const PORT = 54322
const DATA_DIR = '.devdb'
const DB_NAME = 'leadline_dev'
const URL = `postgresql://leadline:leadline@127.0.0.1:${PORT}/${DB_NAME}`

async function main(): Promise<void> {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'leadline',
    password: 'leadline',
    port: PORT,
    persistent: true,
  })
  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    await pg.initialise()
  }
  await pg.start()
  try {
    await pg.createDatabase(DB_NAME)
  } catch {
    // already exists
  }
  console.log(`dev Postgres running at ${URL}`)

  const sep = process.argv.indexOf('--')
  const command = sep !== -1 ? process.argv.slice(sep + 1) : []
  if (command.length > 0) {
    const [cmd, ...args] = command
    const result = spawnSync(cmd!, args, {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: URL },
    })
    await pg.stop()
    process.exit(result.status ?? 1)
  }

  console.log('Press Ctrl+C to stop.')
  const stop = async (): Promise<void> => {
    await pg.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
