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
    const values = {group: params.get('group'), round: params.get('round')};
    if (Object.values(values).some(value => value !== null && !uuid.test(value))
      || (!values.group && location.hash.length > 1)) {
      throw new Error('请打开课题组群里分享的完整链接。');
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

  async function request(path, body) {
    const headers = {'Content-Type': 'application/json', apikey: config.publishableKey};
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
      const message = result?.message;
      if (message && /[\u4e00-\u9fff]/.test(message)) throw new Error(message);
      throw new Error('请求失败，请稍后重试。若是首次部署，请检查共享服务配置。');
    }
    return result;
  }

  function rpc(name, body) {
    return request('/rest/v1/rpc/meeting_group_' + name, {p_group: route().group, ...body});
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
    return current.group ? {group: current.group} : {};
  }

  function renderHome() {
    visible('groupIntro', !overview);
    visible('createForm', !!overview);
    visible('copyGroup', !!overview);
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

  function renderSelection() {
    const chosen = round?.entries.find(entry => entry.name === $('personName').value);
    const slot = chosen?.slot;
    $('diceValue').textContent = slot ?? '?';
    $('diceCaption').textContent = slot ? `${chosen.name}的汇报顺序是第 ${slot} 位` : '等待抽签';
    $('diceBox').className = slot ? 'dice-box' : 'dice-box idle';
    $('rollBtn').disabled = busy || !chosen || slot !== null;
  }

  function renderDraw() {
    const drawn = round.entries.filter(entry => entry.slot !== null).length;
    const select = $('personName');
    const name = select.value;
    select.replaceChildren(new Option('请选择姓名', ''),
      ...round.entries.map(entry => new Option(entry.name + (entry.slot ? '（已抽）' : ''), entry.name)));
    if (round.entries.some(entry => entry.name === name)) select.value = name;
    renderSelection();
    $('drawTitle').textContent = round.name;
    $('personCount').textContent = `${drawn}/${round.entries.length}`;
    $('finishBtn').disabled = drawn !== round.entries.length;
    $('peopleList').innerHTML = [...round.entries].sort((a,b) => (a.slot ?? Infinity) - (b.slot ?? Infinity))
      .map(entry => `
      <li class="person-row">
        <span class="rank">${entry.slot ? String(entry.slot).padStart(2, '0') : '—'}</span>
        <div class="person-name">${escape(entry.name)}</div>
        <span class="person-sub">${entry.slot ? '已抽签' : '待抽签'}</span>
      </li>`).join('');
    visible('copyGroup', true);
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
    visible('copyGroup', true);
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
        visible('copyGroup', false);
        visible('editForm', false);
        $('personName').replaceChildren();
        visible('createForm', false);
        show('homeView');
        status('正在加载…');
      }
      if (current.round) {
        const data = await rpc('round', {p_round: current.round});
        if (version !== revision) return;
        if (JSON.stringify(round) !== JSON.stringify(data)) {
          round = data;
          if (round.finished_at) renderSchedule();
          else renderDraw();
        }
      } else {
        const data = current.group ? await rpc('overview', {}) : null;
        if (version !== revision) return;
        if (!quiet || JSON.stringify(overview) !== JSON.stringify(data)) {
          overview = data;
          renderHome();
        }
      }
      status();
    } catch (error) {
      if (version !== revision) return;
      status(error.message, true);
      if (!quiet) {
        renderHome();
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
      if (button === $('rollBtn')) renderSelection();
      else if (button !== $('finishBtn') || round?.entries.every(entry => entry.slot)) {
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
      navigate({...homeParams(), round: id});
    });
  });

  $('personName').addEventListener('change', renderSelection);
  $('rollBtn').addEventListener('click', () => action($('rollBtn'), async () => {
    const current = route();
    const name = $('personName').value;
    $('diceBox').className = 'dice-box rolling';
    await rpc('draw', {p_round: current.round, p_name: name});
    if (route().round === current.round && route().group === current.group) await load(true);
  }));

  $('editBtn').addEventListener('click', () => {
    $('editName').value = round.name;
    $('editDate').value = round.start_date;
    visible('editForm', true);
    $('editName').focus();
  });
  $('editForm').addEventListener('submit', event => {
    event.preventDefault();
    action(event.submitter, async () => {
      const current = route();
      await rpc('edit', {
        p_round: current.round,
        p_name: $('editName').value.trim(),
        p_start: $('editDate').value,
      });
      if (route().round === current.round && route().group === current.group) {
        visible('editForm', false);
        await load(true);
      }
    });
  });

  $('finishBtn').addEventListener('click', () => action($('finishBtn'), async () => {
    const current = route();
    if (!window.confirm('生成并归档本期排班？')) return;
    await rpc('finish', {p_round: current.round});
    if (route().round === current.round) await load(true);
  }));

  $('copyGroup').addEventListener('click', () => {
    copy(link(homeParams()), '群链接已复制');
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
