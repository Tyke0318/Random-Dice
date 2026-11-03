import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = process.env.TEST_NODE_MODULES
  ? createRequire(join(process.env.TEST_NODE_MODULES, 'package.json'))
  : createRequire(import.meta.url);
const { default: EmbeddedPostgres } = await import(require.resolve('embedded-postgres'));
const { Client } = require('pg');
const { JSDOM } = require('jsdom');
const dir = await mkdtemp(join(tmpdir(), 'meeting-draw-'));
const connection = {host: '127.0.0.1', port: Number(process.env.TEST_PORT || 55431),
  user: 'postgres', password: randomUUID(), database: 'postgres'};
const pg = new EmbeddedPostgres({databaseDir: dir, ...connection, persistent: false,
  onLog() {}});
const clients = [];
const pages = [];
const adminId = randomUUID();
const migration = new URL('./schema.sql', import.meta.url);

async function connect(role, uid = '') {
  const client = new Client(connection);
  await client.connect();
  clients.push(client);
  if (role) {
    await client.query('set role ' + role);
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
  }
  return client;
}

async function rpc(client, name, ...args) {
  const placeholders = args.map((_, i) => '$' + (i + 1)).join(', ');
  const { rows } = await client.query('select public.' + name + '(' + placeholders + ') as result', args);
  return rows[0].result;
}

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const site = 'https://example.github.io/Random-Dice/';

function openPage(url, actors) {
  const {window} = new JSDOM(html, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  pages.push(window);
  window.confirm = () => true;
  const page = {window, get: id => window.document.getElementById(id), clipboard: ''};
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {writeText: async value => { page.clipboard = value; }},
  });
  window.MEETING_CONFIG = {url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test'};
  window.setInterval = callback => { page.poll = callback; };
  window.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.includes('/auth/')) {
      assert.equal(payload.email, 'admin@example.com');
      return {ok: true, json: async () => ({access_token: 'fixture-token'})};
    }
    const actor = options.headers.Authorization ? actors.admin : actors.anon;
    const name = url.split('/').at(-1);
    const order = {
      meeting_overview: ['p_viewer'],
      meeting_round: ['p_round', 'p_viewer', 'p_invite'],
      meeting_create: ['p_round', 'p_name', 'p_start', 'p_names'],
      meeting_draw: ['p_round', 'p_invite'],
      meeting_finish: ['p_round'],
    };
    try {
      const result = await rpc(actor, name, ...order[name].map(arg => payload[arg]));
      return {ok: true, json: async () => result};
    } catch (error) {
      return {ok: false, status: 400, json: async () => ({message: error.message})};
    }
  };
  window.eval(app);
  return page;
}

async function until(test) {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('页面未进入预期状态: ' + test.toString());
}

const shown = (page, id) => !page.get(id).classList.contains('hidden');
const submit = (page, id) => page.get(id).querySelector('button').click();

try {
  await pg.initialise();
  await pg.start();
  const db = await connect();
  await db.query(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
  `);
  await db.query(await readFile(migration, 'utf8'));
  await db.query('insert into auth.users values ($1)', [adminId]);
  await db.query('insert into meeting_private.admins (user_id) values ($1)', [adminId]);
  const [admin, outsider, anon] = await Promise.all([
    connect('authenticated', adminId), connect('authenticated', randomUUID()), connect('anon'),
  ]);
  const overview = await rpc(admin, 'meeting_overview', null);
  const group = overview.viewer_key;
  const round = randomUUID();
  const names = Array.from({length: 12}, (_, i) => '成员 ' + (i + 1));

  await assert.rejects(rpc(anon, 'meeting_overview', null), /需要组内查看链接/);
  await assert.rejects(rpc(outsider, 'meeting_create', round, '越权', '2026-11-09', names), /管理员/);
  await assert.rejects(rpc(anon, 'meeting_finish', round), { code: '42501' });
  await assert.rejects(anon.query('select * from meeting_private.entries'), { code: '42501' });
  await assert.rejects(rpc(admin, 'meeting_create', randomUUID(), '重复名单', '2026-11-09',
    [' A ', 'a']), /名单有重复/);

  assert.equal(await rpc(admin, 'meeting_create', round, '并发测试', '2026-11-09', names), round);
  assert.equal(await rpc(admin, 'meeting_create', round, '并发测试', '2026-11-09', names), round);
  const initial = await rpc(admin, 'meeting_round', round, null, null);
  const invites = initial.entries.map(entry => entry.invite);
  assert.equal(new Set(invites).size, names.length);
  const shared = await rpc(anon, 'meeting_round', round, group, null);
  assert.ok(shared.entries.every(entry => !('invite' in entry)));
  await assert.rejects(rpc(anon, 'meeting_round', round, null, randomUUID()), /无效/);
  await assert.rejects(rpc(admin, 'meeting_finish', round), /尚未全部抽签/);
  await assert.rejects(rpc(anon, 'meeting_draw', round, group), /无效/);

  const drawingClients = await Promise.all(Array.from({length: names.length + 1}, () => connect('anon')));
  const jobs = [...invites, invites[0]];
  const results = await Promise.all(jobs.map((key, i) => rpc(drawingClients[i], 'meeting_draw', round, key)));
  assert.deepEqual(results.slice(0, names.length).sort((a, b) => a - b), names.map((_, i) => i + 1));
  assert.equal(results.at(-1), results[0]);
  const sameInviteNewDevice = await rpc(anon, 'meeting_round', round, null, invites[0]);
  assert.equal(sameInviteNewDevice.mine.slot, results[0]);
  assert.ok(sameInviteNewDevice.entries.every(entry => !('invite' in entry)));
  assert.equal((await rpc(anon, 'meeting_overview', group)).rounds[0].drawn, names.length);
  assert.equal((await rpc(anon, 'meeting_overview', group)).viewer_key, null);
  console.log('PASS 权限、只读链接、专属链接、13 个并发请求及跨连接重复抽签');

  await Promise.all([rpc(admin, 'meeting_finish', round),
    rpc(drawingClients[0], 'meeting_draw', round, invites[0])]);
  const archived = await rpc(anon, 'meeting_round', round, group, null);
  assert.equal(archived.schedule.length, 6);
  assert.equal(archived.schedule[1].date, '2026-11-16');
  assert.deepEqual(archived.schedule.flatMap(week => week.speakers.map(p => p.slot)),
    names.map((_, i) => i + 1));
  await rpc(admin, 'meeting_finish', round);
  await rpc(admin, 'meeting_create', randomUUID(), '下一期', '2026-12-07', ['下一期成员']);
  assert.deepEqual((await rpc(anon, 'meeting_round', round, group, null)).schedule, archived.schedule);
  assert.equal((await rpc(anon, 'meeting_overview', group)).rounds.length, 2);
  assert.equal(await rpc(anon, 'meeting_draw', round, invites[0]), results[0]);
  console.log('PASS 归档与抽签并发、每周双人快照、新场次后历史保留');

  const actors = {admin, anon};
  const panel = openPage(site, actors);
  await until(() => shown(panel, 'loginForm'));
  panel.get('email').value = 'admin@example.com';
  panel.get('password').value = 'test-password';
  submit(panel, 'loginForm');
  await until(() => shown(panel, 'createForm'));
  panel.get('copyGroup').click();
  const historyUrl = panel.clipboard;
  assert.equal(new URL(historyUrl).hash, '#view=' + group);
  panel.get('sessionName').value = '界面联调';
  panel.get('sessionDate').value = '2026-11-09';
  panel.get('roster').value = '同学甲\n同学乙';
  submit(panel, 'createForm');
  await until(() => shown(panel, 'drawView'));
  const links = [...panel.get('peopleList').querySelectorAll('[data-invite]')].map(button => {
    button.click();
    return panel.clipboard;
  });
  assert.equal(links.length, 2);
  const members = links.map(invite => openPage(invite, actors));
  for (const member of members) {
    await until(() => shown(member, 'drawView') && shown(member, 'rollBtn'));
    assert.equal(member.get('peopleList').querySelector('[data-invite]'), null);
    assert.equal(shown(member, 'finishBtn'), false);
    member.get('rollBtn').click();
  }
  await until(() => members.every(member => !shown(member, 'rollBtn')));
  assert.deepEqual(members.map(member => member.get('diceValue').textContent).sort(), ['1', '2']);
  const reopened = openPage(links[0], actors);
  await until(() => shown(reopened, 'drawView'));
  assert.equal(reopened.get('diceValue').textContent, members[0].get('diceValue').textContent);
  await panel.poll();
  assert.equal(panel.get('personCount').textContent, '2/2');
  panel.get('finishBtn').click();
  await until(() => shown(panel, 'scheduleView'));
  const reader = openPage(historyUrl, actors);
  await until(() => shown(reader, 'historySection'));
  assert.equal(shown(reader, 'createForm'), false);
  const history = [...reader.get('historyList').querySelectorAll('article')];
  assert.ok(history.some(card => card.textContent.includes('并发测试')));
  history.find(card => card.textContent.includes('界面联调')).querySelector('button').click();
  await until(() => shown(reader, 'scheduleView'));
  assert.equal(reader.get('scheduleRows').querySelectorAll('.speaker-chip').length, 2);
  reader.get('copyBtn').click();
  assert.match(reader.clipboard, /同学甲/);
  assert.match(reader.clipboard, /同学乙/);
  console.log('PASS 管理员、两位组员、独立页面重开、只读历史和复制排班');
} finally {
  for (const page of pages) page.close();
  await Promise.allSettled(clients.map(client => client.end()));
  try { await pg.stop(); } finally { await rm(dir, {recursive: true, force: true}); }
}
