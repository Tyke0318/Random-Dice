import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';

const require = process.env.TEST_NODE_MODULES
  ? createRequire(join(process.env.TEST_NODE_MODULES, 'package.json'))
  : createRequire(import.meta.url);
const {default: EmbeddedPostgres} = await import(require.resolve('embedded-postgres'));
const {Client} = require('pg');
const {JSDOM} = require('jsdom');
const directory = await mkdtemp(join(tmpdir(), 'meeting-group-'));
const connection = {host: '127.0.0.1', port: Number(process.env.TEST_PORT || 55431),
  user: 'postgres', password: randomUUID(), database: 'postgres'};
const pg = new EmbeddedPostgres({databaseDir: directory, ...connection, persistent: false, onLog() {}});
const clients = [];
const windows = [];
const args = {
  overview: ['p_group'], round: ['p_group', 'p_round'],
  create: ['p_group', 'p_round', 'p_name', 'p_start', 'p_names'],
  edit: ['p_group', 'p_round', 'p_name', 'p_start'],
  draw: ['p_group', 'p_round', 'p_name'], finish: ['p_group', 'p_round'],
  share: ['p_group', 'p_round'],
  create_dice: ['p_group', 'p_round', 'p_name', 'p_start'],
  roll: ['p_group', 'p_round', 'p_name'],
  share_round: ['p_share'], share_draw: ['p_share', 'p_name'],
};
const read = name => readFile(new URL(name, import.meta.url), 'utf8');

async function connect(anon = true) {
  const client = new Client(connection);
  await client.connect();
  clients.push(client);
  if (anon) await client.query('set role anon');
  return client;
}

async function rpc(client, name, ...values) {
  const placeholders = values.map((_, i) => '$' + (i + 1)).join(', ');
  const fn = name.startsWith('share_') ? 'meeting_' + name : 'meeting_group_' + name;
  const {rows} = await client.query('select public.' + fn + '(' + placeholders + ') as result', values);
  return rows[0].result;
}

async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('页面未进入预期状态: ' + check.toString());
}

try {
  await pg.initialise();
  await pg.start();
  const db = await connect(false);
  await db.query(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  `);
  await db.query(await read('schema.sql'));
  await db.query(await read('group-access.sql'));
  await db.query(await read('round-share.sql'));
  const {rows:[settings]} = await db.query('select group_key, viewer_key from meeting_private.settings');
  const {group_key: group, viewer_key: oldViewer} = settings;
  const anon = await connect();
  const round = randomUUID();
  const names = ['测试甲', '测试乙', '测试丙'];
  for (const [operation, values] of Object.entries({
    overview: [], round: [round], create: [round, '越权', '2026-11-09', names],
    edit: [round, '越权', '2026-11-09'], draw: [round, names[0]], finish: [round],
  })) {
    await assert.rejects(rpc(anon, operation, oldViewer, ...values), {code: '42501'});
  }
  assert.equal(await rpc(anon, 'create', group, round, '共享测试', '2026-11-09', names), round);
  assert.equal(await rpc(anon, 'create', group, round, '共享测试', '2026-11-09', names), round);
  await rpc(anon, 'edit', group, round, '新标题', '2026-11-16');
  assert.ok((await rpc(anon, 'round', group, round)).entries.every(e => !('invite' in e)));
  await assert.rejects(rpc(anon, 'draw', group, round, '非名单成员'), /名单/);
  await assert.rejects(rpc(anon, 'finish', group, round), /尚未全部抽签/);
  const share = await rpc(anon, 'share', group, round);
  assert.equal(await rpc(anon, 'share', group, round), share);
  assert.notEqual(share, group);
  assert.notEqual(share, round);
  await assert.rejects(rpc(anon, 'share_round', round), {code:'42501'});
  await assert.rejects(rpc(anon, 'overview', share), {code:'42501'});
  await assert.rejects(rpc(anon, 'finish', share, round), {code:'42501'});
  await assert.rejects(rpc(anon, 'edit', share, round, '越权', '2026-11-16'), {code:'42501'});
  assert.equal((await rpc(anon, 'share_round', share)).name, '新标题');
  const participants = await Promise.all([...names, names[0]].map(() => connect()));
  const slots = await Promise.all([...names, names[0]].map((name, i) =>
    rpc(participants[i], 'share_draw', share, ' ' + name + ' ')));
  assert.deepEqual(slots.slice(0, 3).sort(), [1, 2, 3]);
  assert.equal(slots[0], slots[3]);
  await rpc(anon, 'finish', group, round);
  const archived = await rpc(anon, 'round', group, round);
  assert.equal(archived.name, '新标题');
  assert.deepEqual(archived.schedule.map(week => week.date), ['2026-11-16', '2026-11-23']);
  assert.equal(archived.schedule[1].speakers.length, 1);
  await assert.rejects(rpc(anon, 'edit', group, round, '归档后修改', '2026-11-23'), /已归档/);
  assert.equal(await rpc(anon, 'draw', group, round, names[0]), slots[0]);
  assert.deepEqual((await rpc(anon, 'round', group, round)).schedule, archived.schedule);
  assert.deepEqual((await rpc(anon, 'share_round', share)).schedule, archived.schedule);
  console.log('PASS 场次链接权限隔离、并发抽签、重试、编辑与归档保护');

  const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
  const base = 'https://example.github.io/Random-Dice/';
  function open(url) {
    const {window} = new JSDOM(html, {url, runScripts:'outside-only', pretendToBeVisual:true});
    windows.push(window);
    window.MEETING_CONFIG = {url:'https://example.supabase.co', publishableKey:'sb_publishable_test'};
    window.confirm = () => true;
    const get = id => window.document.getElementById(id);
    Object.defineProperty(window.navigator, 'clipboard', {value: {
      writeText: async value => { get.clipboard = value; },
    }});
    window.Blob = Blob;
    window.URL.createObjectURL = blob => {
      get.download = blob;
      return 'blob:fixture';
    };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () { get.filename = this.download; };
    window.fetch = async (url, options) => {
      assert.match(url, /\/rpc\/meeting_(group|share)_/);
      const name = url.split('/meeting_')[1].replace(/^group_/, '');
      const body = JSON.parse(options.body);
      try {
        const data = await rpc(anon, name, ...args[name].map(key => body[key]));
        return {ok:true, json:async () => data};
      } catch (error) {
        return {ok:false, status:400, json:async () => ({message:error.message})};
      }
    };
    window.eval(app);
    return get;
  }
  const direct = open(base);
  assert.equal(direct('loginForm'), null);
  const groupHome = open(base + '#group=' + group);
  await until(() => !groupHome('createForm').classList.contains('hidden'));
  assert.match(groupHome('historyList').textContent, /新标题/);
  groupHome('sessionName').value = '页面验收';
  groupHome('sessionDate').value = '2026-11-09';
  groupHome('createForm').querySelector('button').click();
  await until(() => !groupHome('shareBtn').classList.contains('hidden'));
  const uiRound = new URLSearchParams(groupHome('shareBtn').ownerDocument.defaultView.location.hash.slice(1)).get('round');
  assert.ok((await rpc(anon, 'overview', group)).rounds.some(item => item.id === uiRound && item.drawn === 0));
  groupHome('shareBtn').click();
  const url = groupHome.clipboard;
  assert.match(url, /^https:\/\/example.github.io\/Random-Dice\/#share=/);
  assert.ok(!url.includes(group));
  const uiShare = new URLSearchParams(new URL(url).hash.slice(1)).get('share');
  const [a, b] = [open(url), open(url)];
  await until(() => a('drawTitle').textContent === '页面验收' && b('drawTitle').textContent === '页面验收');
  assert.ok(a('createForm').classList.contains('hidden'));
  assert.ok(a('editBtn').classList.contains('hidden'));
  assert.ok(a('finishBtn').classList.contains('hidden'));
  assert.ok(a('shareBtn').classList.contains('hidden'));
  for (const [page, name] of [[a, names[0]], [b, names[1]]]) {
    page('personName').value = name;
    page('personName').dispatchEvent(new (page('personName').ownerDocument.defaultView.Event)('input'));
    page('rollBtn').click();
  }
  await until(() => /^\d+$/.test(a('diceValue').textContent) && /^\d+$/.test(b('diceValue').textContent));
  for (const page of [a,b]) assert.match(page('diceValue').textContent, /^[1-6]$/);
  const reopened = open(url);
  await until(() => reopened('drawTitle').textContent === '页面验收');
  reopened('personName').value = names[0];
  reopened('personName').dispatchEvent(new (reopened('personName').ownerDocument.defaultView.Event)('input'));
  assert.equal(reopened('diceValue').textContent, a('diceValue').textContent);
  const extra = ['丁', '戊', '己', '庚', '辛'];
  const extraClients = await Promise.all([...extra, extra[0]].map(() => connect()));
  const results = await Promise.all([...extra, extra[0]].map((name, i) =>
    rpc(extraClients[i], 'share_draw', uiShare, name)));
  assert.equal(results[0], results.at(-1));
  assert.ok(results.every(result => result >= 1 && result <= 6));
  const live = await rpc(anon, 'share_round', uiShare);
  const expected = [...live.entries].sort((a,b) => a.die - b.die).map(entry => entry.name);
  await rpc(anon, 'finish', group, uiRound);
  const final = await rpc(anon, 'share_round', uiShare);
  assert.deepEqual(final.schedule.flatMap(week => week.speakers.map(entry => entry.name)), expected);
  await assert.rejects(rpc(anon, 'share_draw', uiShare, '迟到'), /已归档/);
  a('refreshBtn').click();
  await until(() => !a('scheduleView').classList.contains('hidden'));
  a('csvBtn').click();
  assert.equal(a.filename, '页面验收_汇报排班.csv');
  const csv = await a.download.text();
  assert.match(csv, /"周次","日期","顺序","姓名","点数"/);
  assert.match(csv, /"2026-11-09","1","[^"]+","[1-6]"/);
  assert.equal(csv.split('\r\n').length, 8);
  console.log('PASS 独立场次页面、无建场表单、换设备查看原号、刷新归档和 CSV 入口');
} finally {
  windows.forEach(window => window.close());
  await Promise.allSettled(clients.map(client => client.end()));
  try { await pg.stop(); } finally { await rm(directory, {recursive:true, force:true}); }
}
