/**
 * Vitest global setup: boots a disposable embedded PostgreSQL 16 (binaries in
 * node_modules, no Docker required), applies migrations, and exposes the URL
 * via TEST_DATABASE_URL. Set TEST_DATABASE_URL yourself to use an external DB.
 */
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import EmbeddedPostgres from 'embedded-postgres'

const PORT = 54339
const DATA_DIR = '.pgtest'
const DB_NAME = 'leadline_test'

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.TEST_DATABASE_URL) {
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: 'inherit',
    })
    return
  }

  rmSync(DATA_DIR, { recursive: true, force: true })
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase(DB_NAME)

  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
  process.env.TEST_DATABASE_URL = url

  return async () => {
    await pg.stop()
    rmSync(DATA_DIR, { recursive: true, force: true })
  }
}
