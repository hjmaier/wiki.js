// Only for a disposable Linux CI runner and its new, local PostgreSQL service.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'linux')
assert.equal(process.arch, 'x64')
const root = fs.realpathSync(process.argv[2])
const logFile = path.resolve(process.argv[3])
const port = Number(process.env.WIKI_TEST_DB_PORT)
assert(Number.isInteger(port) && port > 0 && port < 65536, 'Need scratch service port')
assert(!fs.existsSync(path.join(root, 'config.yml')), 'Only an unconfigured package may be tested')
const config = path.join(root, 'config.smoke.yml')
assert(!fs.existsSync(config))
const require = createRequire(path.join(root, 'backend/package.json'))
const { Client } = require('pg')
const db = new Client({
  host: '127.0.0.1', port, database: 'wiki_build_test',
  user: 'wiki_build_test', password: 'build_test_password'
})
let child
let logFd
try {
  await db.connect()
  const before = await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'wiki'")
  assert.equal(before.rows[0].n, 0, 'Requires a fresh database, never an existing wiki')
  fs.writeFileSync(config, `port: 3010\nbindIP: 127.0.0.1\noffline: true\ndataPath: ./data-smoke\nscheduler:\n  workers: 1\ndev:\n  dropSchema: false\ndb:\n  host: 127.0.0.1\n  port: ${port}\n  user: wiki_build_test\n  pass: build_test_password\n  db: wiki_build_test\n  schema: wiki\n  ssl: false\n`, { flag: 'wx', mode: 0o600 })
  const env = { ...process.env, NODE_ENV: 'production', CONFIG_FILE: config }
  for (const name of ['DATABASE_URL', 'DB_PASS_FILE', 'DB_SSL_CA', 'WIKI_PORT', 'PORT']) delete env[name]
  logFd = fs.openSync(logFile, 'w')
  child = spawn(process.execPath, ['--no-experimental-webstorage', 'backend'], {
    cwd: root, env, stdio: ['ignore', logFd, logFd]
  })
  let boot
  for (let attempt = 0; attempt < 120; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'Wiki exited before becoming ready; see smoke.log')
    try {
      const r = await fetch('http://127.0.0.1:3010/_api/bootstrap', { signal: AbortSignal.timeout(1000) })
      if (r.ok) { boot = await r.json(); break }
    } catch {}
    await delay(500)
  }
  assert(boot?.site?.id, 'Bootstrap did not become ready; see smoke.log')
  assert.equal(boot.user.authenticated, false)
  for (const endpoint of ['/', '/_assets/renderer.js', '/_blocks/block-badge.js', '/_blocks/block-pdf.worker.js']) {
    const r = await fetch(`http://127.0.0.1:3010${endpoint}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(r.status, 200, endpoint)
    assert((await r.arrayBuffer()).byteLength > 0, endpoint)
  }
  const strategyId = '5a528c4c-0a82-4ad2-96a5-2b23811e6588'
  const authUrl = `http://127.0.0.1:3010/_api/sites/${boot.site.id}/auth`
  const send = async (endpoint, body, cookie) => {
    const r = await fetch(`${authUrl}/${endpoint}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    })
    assert.equal(r.status, 200, endpoint)
    return { body: await r.json(), cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') || cookie }
  }
  const login = await send('login', { strategyId, username: 'admin@example.com', password: '12345678' })
  assert.equal(login.body.nextAction, 'changePassword')
  const changed = await send('changePassword', {
    strategyId, continuationToken: login.body.continuationToken,
    newPassword: `CI-${randomBytes(24).toString('hex')}!`
  }, login.cookie)
  assert.equal(changed.body.authenticated, true)
  const session = await fetch('http://127.0.0.1:3010/_api/bootstrap', { headers: { cookie: changed.cookie } })
  assert.equal((await session.json()).user.authenticated, true)
  const migrations = await db.query('SELECT count(*)::int AS n FROM wiki.migrations')
  assert.equal(migrations.rows[0].n, 34)
  const extensions = await db.query("SELECT extname FROM pg_extension WHERE extname IN ('ltree', 'pg_trgm')")
  assert.equal(extensions.rowCount, 2)
  console.log('PASS: packaged boot, 34 migrations, 2 extensions, static assets, block worker, login and session')
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  if (logFd !== undefined) fs.closeSync(logFd)
  await db.end()
}
