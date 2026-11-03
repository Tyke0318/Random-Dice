(() => {
  const $ = id => document.getElementById(id);
  const views = ['homeView', 'drawView', 'scheduleView'];
  const config = window.MEETING_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url)
    && /^sb_publishable_[\w-]+$/.test(config.publishableKey);
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC',
  });
  let auth = null;
  let overview = null;
  let round = null;
  let busy = false;
  let polling = false;
  let revision = 0;
  let createAttempt;
  let toastTimer;

  function visible(id, show) {
    $(id).classList.toggle('hidden', !show);
  }

  function status(message = '', error = false) {
    $('status').textContent = message;
    $('status').dataset.error = error;
  }

  function show(view) {
    views.forEach(id => visible(id, id === view));
    visible('historySection', view === 'homeView' && !!overview);
  }

  function route() {
    const params = new URLSearchParams(location.hash.slice(1));
    const values = Object.fromEntries(['round', 'view', 'invite'].map(key => [key, params.get(key)]));
    if (Object.values(values).some(value => value !== null && !uuid.test(value))
      || (values.invite && !values.round)) {
      throw new Error('链接格式有误，请使用管理员分享的完整链接。');
    }
    return values;
  }

  function link(params = {}) {
    const url = new URL(location.pathname, location.origin);
    url.hash = new URLSearchParams(params).toString();
    return url.href;
  }

  function navigate(params) {
    const target = new URL(link(params)).hash;
    if (location.hash === target) return load();
    location.hash = target;
  }

  async function request(path, body, token = auth?.token) {
    const headers = {'Content-Type': 'application/json', apikey: config.publishableKey};
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetch(config.url + path, {
        method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error('连接共享服务失败，请检查网络后重试。');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (token && response.status === 401) {
        auth = null;
        overview = round = null;
        $('peopleList').replaceChildren();
        visible('signOut', false);
        renderHome(homeParams());
        throw new Error('管理员登录已过期，请重新登录。');
      }
      const message = result?.message;
      if (message && /[\u4e00-\u9fff]/.test(message)) throw new Error(message);
      throw new Error('请求失败，请稍后重试。若是首次部署，请检查共享服务配置。');
    }
    return result;
  }

  function rpc(name, body, token) {
    return request('/rest/v1/rpc/meeting_' + name, body, token);
  }

  function escape(value) {
    const el = document.createElement('span');
    el.textContent = value;
    return el.innerHTML;
  }

  function fmtDate(date) {
    return dateFormat.format(new Date(date + 'T00:00:00Z'));
  }

  function nextMonday() {
    const date = new Date();
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map(value => String(value).padStart(2, '0')).join('-');
  }

  function homeParams(current = route()) {
    return current.view ? {view: current.view} : {};
  }

  function renderHome(current) {
    const admin = overview?.admin;
    visible('loginForm', !admin && !current.view);
    visible('createForm', !!admin);
    if (!$('sessionDate').value) $('sessionDate').value = nextMonday();
    const records = overview?.rounds || [];
    $('historyCount').textContent = records.length ? `共 ${records.length} 场` : '';
    visible('emptyHistory', records.length === 0);
    $('historyList').innerHTML = records.map(item => `
      <article class="history-card">
        <div class="history-card-top">
          <div><p class="eyebrow">${item.finished_at ? '已归档' : '抽签中'}</p><h3>${escape(item.name)}</h3></div>
          <span class="person-dice">${item.drawn}/${item.total}</span>
        </div>
        <p class="history-date">${fmtDate(item.start_date)} 开始 · 每周两人</p>
        <div class="history-actions"><button data-round="${item.id}">${item.finished_at ? '查看排班' : '查看抽签进度'}</button></div>
      </article>`).join('');
    show('homeView');
  }

  function renderDraw() {
    const drawn = round.entries.filter(entry => entry.slot !== null).length;
    const slot = round.mine?.slot;
    $('drawTitle').textContent = round.name;
    $('personCount').textContent = `${drawn}/${round.entries.length}`;
    $('memberTitle').textContent = round.mine ? `${round.mine.name}，你好` : '组内抽签进度';
    $('diceValue').textContent = slot ?? '?';
    $('diceCaption').textContent = slot ? `你的汇报顺序是第 ${slot} 位` : '等待抽签';
    $('diceBox').className = slot ? 'dice-box' : 'dice-box idle';
    visible('rollBtn', !!round.mine && slot === null);
    visible('finishBtn', round.admin);
    visible('inviteNote', round.admin && drawn < round.entries.length);
    $('finishBtn').disabled = drawn !== round.entries.length;
    $('peopleList').innerHTML = round.entries.map(entry => `
      <li class="person-row">
        <span class="rank">${entry.slot ? String(entry.slot).padStart(2, '0') : '—'}</span>
        <div><div class="person-name">${escape(entry.name)}</div>
        ${entry.invite ? `<button class="invite-copy" data-invite="${entry.invite}">复制专属链接</button>` : ''}</div>
        <span class="person-sub">${entry.slot ? '已抽签' : '待抽签'}</span>
      </li>`).join('');
    show('drawView');
  }

  function renderSchedule() {
    $('scheduleTitle').textContent = round.name;
    $('scheduleName').textContent = round.name + ' · 分享安排';
    $('startDate').textContent = fmtDate(round.start_date);
    $('startDateBadge').textContent = '已归档';
    $('scheduleCount').textContent = `共 ${round.entries.length} 人`;
    $('scheduleRows').innerHTML = round.schedule.map(week => `
      <div class="week-row">
        <div class="week-date"><strong>第 ${week.week} 周</strong>${fmtDate(week.date)}</div>
        <div class="speaker-chips">${week.speakers.map(p => `
          <span class="speaker-chip"><b>${p.slot}</b>${escape(p.name)}</span>`).join('')}</div>
      </div>`).join('');
    show('scheduleView');
  }

  async function load(quiet = false) {
    const version = ++revision;
    if (!configured) {
      status('共享抽签尚未接通。管理员完成 Supabase 配置后即可使用。');
      visible('setupNote', true);
      return;
    }
    try {
      const current = route();
      if (!quiet) {
        round = overview = null;
        visible('loginForm', false);
        visible('createForm', false);
        show('homeView');
        status('正在加载…');
      }
      if (current.round) {
        const data = await rpc('round', {p_round: current.round, p_viewer: current.view, p_invite: current.invite});
        if (version !== revision) return;
        if (JSON.stringify(round) !== JSON.stringify(data)) {
          round = data;
          if (round.finished_at) renderSchedule();
          else renderDraw();
        }
      } else {
        const data = auth || current.view ? await rpc('overview', {p_viewer: current.view}) : null;
        if (version !== revision) return;
        if (!quiet || JSON.stringify(overview) !== JSON.stringify(data)) {
          overview = data;
          renderHome(current);
        }
      }
      status();
    } catch (error) {
      if (version !== revision) return;
      status(error.message, true);
      if (!quiet) {
        show('homeView');
        visible('loginForm', !auth);
      }
    }
  }

  async function action(button, work) {
    if (busy) return;
    busy = true;
    // Invalidate any polling response started before the write.
    const version = ++revision;
    button.disabled = true;
    status();
    try {
      await work();
    } catch (error) {
      if (version === revision) status(error.message, true);
    } finally {
      busy = false;
      if (button !== $('finishBtn') || round?.entries.every(entry => entry.slot)) {
        button.disabled = false;
      }
    }
  }

  async function copy(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      $('toast').textContent = message;
      $('toast').classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
    } catch {
      window.prompt('自动复制失败，请手动复制下列内容。', value);
    }
  }

  $('loginForm').addEventListener('submit', event => {
    event.preventDefault();
    action(event.submitter, async () => {
      try {
        const session = await request('/auth/v1/token?grant_type=password', {
          email: $('email').value.trim(), password: $('password').value,
        }, null);
        const data = await rpc('overview', {p_viewer: null}, session.access_token);
        if (!data.admin) throw new Error('此账号没有管理员权限。');
        auth = {token: session.access_token};
        visible('signOut', true);
        navigate({});
      } catch (error) {
        throw new Error('登录失败。请确认邮箱、密码、管理员权限及网络连接。', {cause: error});
      } finally {
        $('password').value = '';
      }
    });
  });

  $('signOut').addEventListener('click', () => {
    auth = null;
    visible('signOut', false);
    navigate(homeParams());
  });

  $('createForm').addEventListener('submit', event => {
    event.preventDefault();
    action(event.submitter, async () => {
      const input = {
        p_name: $('sessionName').value.trim(),
        p_start: $('sessionDate').value,
        p_names: $('roster').value.split(/\r?\n/).map(name => name.trim()).filter(Boolean),
      };
      const signature = JSON.stringify(input);
      if (createAttempt?.signature !== signature) createAttempt = {signature, id: crypto.randomUUID()};
      const id = await rpc('create', {p_round: createAttempt.id, ...input});
      createAttempt = null;
      $('sessionName').value = '';
      $('roster').value = '';
      navigate({round: id});
    });
  });

  $('rollBtn').addEventListener('click', () => action($('rollBtn'), async () => {
    const current = route();
    $('diceBox').className = 'dice-box rolling';
    try {
      const slot = await rpc('draw', {p_round: current.round, p_invite: current.invite});
      if (route().round !== current.round || route().invite !== current.invite) return;
      $('diceValue').textContent = slot;
      $('diceCaption').textContent = `你的汇报顺序是第 ${slot} 位`;
      visible('rollBtn', false);
      await load(true);
    } finally {
      $('diceBox').classList.remove('rolling');
    }
  }));

  $('finishBtn').addEventListener('click', () => action($('finishBtn'), async () => {
    const current = route();
    if (!window.confirm('生成并归档本期排班？')) return;
    await rpc('finish', {p_round: current.round});
    if (route().round === current.round) await load(true);
  }));

  $('copyGroup').addEventListener('click', () => {
    if (overview?.viewer_key) copy(link({view: overview.viewer_key}), '组内查看链接已复制');
  });
  $('peopleList').addEventListener('click', event => {
    const invite = event.target.closest('[data-invite]')?.dataset.invite;
    if (invite && round?.admin) copy(link({round: round.id, invite}), '专属链接已复制，请私发给对应组员');
  });
  $('historyList').addEventListener('click', event => {
    const id = event.target.closest('[data-round]')?.dataset.round;
    if (id) navigate({...homeParams(), round: id});
  });
  $('copyBtn').addEventListener('click', () => {
    const lines = round.schedule.map(week => `第 ${week.week} 周（${fmtDate(week.date)}）：`
      + week.speakers.map(person => `${person.slot}. ${person.name}`).join('；'));
    copy([round.name + '｜分享汇报排班表', ...lines].join('\n'), '排班表已复制');
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('backHome').addEventListener('click', () => navigate(homeParams()));
  $('newBtn').addEventListener('click', () => navigate(homeParams()));
  document.querySelector('.brand').addEventListener('click', event => {
    event.preventDefault();
    try { navigate(homeParams()); } catch { navigate({}); }
  });

  window.addEventListener('hashchange', () => load());
  setInterval(async () => {
    if (!configured || document.hidden || busy || polling || (!round && !overview)) return;
    polling = true;
    try { await load(true); } finally { polling = false; }
  }, 5000);
  load();
})();
