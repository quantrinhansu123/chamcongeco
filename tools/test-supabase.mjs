// PostgreSQL/PLpgSQL contract checks. PGlite is single-connection; this does not
// certify real Supabase Storage, network behavior, or cross-session advisory locks.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
let checks = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++ }
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0].value
const model = 'buffalo_sc:sql-fixture'
const day = '2026-11-14'
const context = { distance: 0.1, faces: [{ employee_id: 'emp_001', name: 'Synthetic SQL', location: { top: 0, right: 100, bottom: 100, left: 0 }, distance: 0.1 }] }
const reserve = (id, now, action = 'auto', employee = 'emp_001') => scalar('select public.reserve_attendance_request($1,$2,$3,$4,$5,$6,$7) as value', [id, employee, action, now, day, model, context])
const complete = (id, path) => scalar('select public.complete_attendance_request($1,$2) as value', [id, path])
const photo = async (request) => {
  const path = `${day}/${request.employee_id}/${request.action}/${request.request_id}.jpg`
  await db.query('insert into storage.objects(bucket_id,name) values($1,$2) on conflict do nothing', ['attendance-photos', path])
  return path
}
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage; create table storage.objects(bucket_id text, name text, primary key(bucket_id,name));
    grant usage on schema public,storage to service_role; grant all on storage.objects to service_role;`)
  const base = await readFile(new URL('../backend/supabase/schema.sql', import.meta.url), 'utf8')
  const migration = await readFile(new URL('../backend/supabase/003_runtime.sql', import.meta.url), 'utf8')
  await db.exec(base)
  await db.exec(migration)
  await db.exec(migration)
  await db.exec('set role service_role')
  await db.query('insert into public.employees(name,image_filename,face_encoding,face_model,face_templates) values($1,$2,$3,$4,$5)', ['Synthetic SQL', 'synthetic.jpg', Array(512).fill(0.1), model, [Array(512).fill(0.1)]])
  const firstId = randomUUID()
  let first = await reserve(firstId, '2026-11-14T08:30:00+07:00')
  check(first.status, 'pending')
  check((await complete(firstId, 'missing.jpg')).error.code, 'photo_required')
  check(await scalar('select count(*)::int as value from attendance'), 0)
  const conflict = await reserve(randomUUID(), '2026-11-14T08:30:01+07:00')
  check(conflict.error.code, 'punch_pending')
  const arrived = await complete(firstId, await photo(first))
  check(arrived.status, 'confirmed')
  check(arrived.action, 'in')
  check(arrived.attendance_updated, ['emp_001'])
  check(await complete(firstId, 'ignored-on-retry'), arrived)
  check((await reserve(firstId, '2026-11-14T17:30:00+07:00')).result, arrived)
  check((await reserve(firstId, '2026-11-14T17:30:00+07:00', 'auto', 'other')).error.code, 'request_conflict')
  const doubleClick = await reserve(randomUUID(), '2026-11-14T08:30:03+07:00')
  check(doubleClick.status, 'confirmed')
  check(doubleClick.action, 'in')
  check(doubleClick.result.attendance[0].departed_at, null)
  const leavingId = randomUUID()
  const leaving = await reserve(leavingId, '2026-11-14T17:30:00+07:00')
  check(leaving.action, 'out')
  const departed = await complete(leavingId, await photo(leaving))
  check(departed.attendance[0].arrived_at, arrived.attendance[0].arrived_at)
  check(new Date(departed.attendance[0].departed_at).toISOString(), '2026-11-14T10:30:00.000Z')
  const repeat = await reserve(randomUUID(), '2026-11-14T18:30:00+07:00')
  check(repeat.status, 'confirmed')
  check(repeat.result.attendance_updated, [])
  check(await scalar('select count(*)::int as value from attendance'), 1)
  await db.query('insert into employees(name,image_filename,face_encoding) values($1,$2,$3)', ['Legacy SQL', 'legacy.jpg', Array(128).fill(0.2)])
  const updated = await scalar('select update_employee_face($1,$2) as value', ['emp_002', { face_encoding: Array(512).fill(0.2), face_model: model, face_templates: [Array(512).fill(0.2)], image_filename: 'new.jpg', face_updated_at: '2026-11-14T01:30:00Z', consented_at: '2026-11-14T01:30:00Z' }])
  check(updated.face_encoding.length, 512)
  check(updated.face_profiles['dlib-v1'][0].length, 128)
  check((await reserve(randomUUID(), '2026-11-14T08:30:00+07:00', 'out', 'emp_002')).error.code, 'arrival_required')
  const expiredId = randomUUID()
  const expired = await reserve(expiredId, '2026-11-14T08:30:00+07:00', 'auto', 'emp_002')
  await reserve(randomUUID(), '2026-11-14T08:33:00+07:00', 'auto', 'emp_002')
  check((await complete(expiredId, await photo(expired))).error.code, 'request_expired')
  const pendingId = (await scalar("select request_id as value from punch_requests where employee_id='emp_002' and status='pending'"))
  const abandoned = await scalar('select expire_attendance_request($1,$2) as value', [pendingId, '2026-11-14T08:36:00+07:00'])
  check(abandoned.status, 'abandoned')
  check((await reserve(pendingId, '2026-11-14T08:36:01+07:00', 'auto', 'emp_002')).error.code, 'request_expired')
  await db.exec('reset role; set role anon')
  await assert.rejects(() => db.query('select * from public.employees'), /permission denied/); checks++
  await assert.rejects(() => complete(firstId, 'unauthorized'), /permission denied/); checks++
  console.log(`PASS: ${checks} PostgreSQL migration/RPC checks (PGlite, synthetic data).`)
} finally { await db.close() }
