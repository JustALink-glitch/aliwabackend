// Creates supabase/signing_keys.json for the local Supabase stack (ES256), if missing.
// Hosted projects manage their own keys in the dashboard; this file is for local dev only.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const path = new URL('../supabase/signing_keys.json', import.meta.url)

if (existsSync(path)) {
  console.info('supabase/signing_keys.json already exists — leaving it alone.')
} else {
  const key = execFileSync('npx', ['supabase', 'gen', 'signing-key', '--algorithm', 'ES256'], {
    encoding: 'utf8',
  })
  writeFileSync(path, JSON.stringify([JSON.parse(key)], null, 2) + '\n', { mode: 0o600 })
  console.info('Created supabase/signing_keys.json')
}
