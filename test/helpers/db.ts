import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import postgres from 'postgres'
import { createSql, type Sql } from '../../src/lib/db.js'

/**
 * Integration tests need a Postgres server: set TEST_DATABASE_URL to a superuser connection,
 * e.g. postgres://postgres:postgres@localhost:5432/postgres. CI provides one.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

const root = new URL('../../', import.meta.url)
const stub = readFileSync(new URL('test/helpers/supabase-stub.sql', root), 'utf8')
const migrationsDir = new URL('supabase/migrations/', root)
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))

/** Creates a throwaway database with every migration applied. */
export async function createTestDatabase(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set')
  const name = `synqop_test_${randomBytes(6).toString('hex')}`
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database ${name}`)

  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  const setup = postgres(url.toString(), { max: 1, onnotice: () => {} })
  await setup.unsafe(stub)
  for (const migration of migrations) await setup.unsafe(migration)
  await setup.end()

  const sql = createSql(url.toString(), { max: 4 })
  return {
    sql,
    drop: async () => {
      await sql.end()
      await admin.unsafe(`drop database if exists ${name} with (force)`)
      await admin.end()
    },
  }
}
