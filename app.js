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
  let shareKey = null;
  let lastShare = null;
  const managementStorage = 'random-dice.management-group';
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
    const values = {group: params.get('group'), round: params.get('round'), share: params.get('share')};
    if (Object.values(values).some(value => value !== null && !uuid.test(value))
      || (values.share ? values.group || values.round : !values.group && location.hash.length > 1)) {
      throw new Error('请打开完整的场次链接。');
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
    const current = route();
    return current.share
      ? request('/rest/v1/rpc/meeting_share_' + name, {p_share: current.share, ...body})
      : request('/rest/v1/rpc/meeting_group_' + name, {p_group: current.group, ...body});
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

  function returnHome() {
    let group = new URLSearchParams(location.hash.slice(1)).get('group');
    if (!group) {
      try { group = localStorage.getItem(managementStorage); } catch {}
    }
    navigate(uuid.test(group ?? '') ? {group} : {});
  }

  function renderHome() {
    visible('groupIntro', !overview);
    visible('resumeRound', !overview && !!lastShare);
    visible('createForm', !!overview);
    visible('shareBtn', false);
    visible('refreshBtn', !!overview);
    if (!$('sessionDate').value) $('sessionDate').value = nextMonday();
    const records = overview?.rounds || [];
    $('historyCount').textContent = records.length ? `共 ${records.length} 场` : '';
    visible('emptyHistory', records.length === 0);
    $('historyList').innerHTML = records.map(item => `
      <article class="history-card">
        <div class="history-card-top">
          <div><p class="eyebrow">${item.finished_at ? '已归档' : '抽签中'}</p><h3>${escape(item.name)}</h3></div>
          <span class="person-dice">${item.dice_mode ? item.drawn + ' 人' : item.drawn + '/' + item.total}</span>
        </div>
        <p class="history-date">${fmtDate(item.start_date)} 开始 · 每周两人</p>
        <div class="history-actions"><button data-round="${item.id}">${item.finished_at ? '查看排班' : '查看抽签进度'}</button></div>
      </article>`).join('');
    show('homeView');
  }

  function typedName() {
    return $('personName').value.trim().replace(/\s+/gu, ' ');
  }

  function selectedEntry() {
    const name = typedName().toLowerCase();
    return round?.entries.find(entry => entry.name.toLowerCase() === name);
  }

  function renderSelection() {
    const chosen = selectedEntry();
    const result = chosen?.die ?? chosen?.slot;
    $('diceValue').textContent = result ?? '?';
    $('diceCaption').textContent = result ? (round.dice_mode ? `${result} 点` : `第 ${result} 位`) : '等待抽签';
    $('diceBox').className = result ? 'dice-box' : 'dice-box idle';
    $('rollBtn').disabled = busy || !typedName() || !!result;
  }

  function weekDate(slot) {
    const date = new Date(round.start_date + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 7 * Math.floor((slot - 1) / 2));
    return date.toISOString().slice(0, 10);
  }

  function renderRoundControls() {
    const manager = !!route().group;
    visible('shareBtn', manager && !!shareKey);
    visible('refreshBtn', true);
    visible('editBtn', manager);
    visible('finishBtn', manager);
  }

  function renderDraw() {
    const drawn = round.entries.filter(entry => (entry.die ?? entry.slot) !== null)
      .sort((a,b) => (a.die ?? a.slot) - (b.die ?? b.slot));
    renderSelection();
    $('drawTitle').textContent = round.name;
    $('personCount').textContent = round.dice_mode ? drawn.length : `${drawn.length}/${round.entries.length}`;
    $('finishBtn').disabled = !drawn.length || (!round.dice_mode && drawn.length !== round.entries.length);
    visible('rankNote', round.dice_mode && drawn.length > 0);
    visible('progressEmpty', !drawn.length);
    $('peopleList').innerHTML = drawn.map((entry, i) => {
      const position = entry.slot ?? i + 1;
      return `
      <li class="person-row">
        <span class="rank">${String(position).padStart(2, '0')}</span>
        <div><div class="person-name">${escape(entry.name)}</div><div class="person-sub">${entry.die ? entry.die + ' 点' : ''}</div></div>
        <span class="person-sub">${fmtDate(weekDate(position))}</span>
      </li>`;
    }).join('');
    renderRoundControls();
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
          <span class="speaker-chip"><b>${p.slot}</b>${escape(p.name)}${p.die ? ' · ' + p.die + ' 点' : ''}</span>`).join('')}</div>
      </div>`).join('');
    renderRoundControls();
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
      if (!quiet) {
        round = overview = shareKey = null;
        visible('shareBtn', false);
        visible('refreshBtn', false);
        visible('editForm', false);
        $('personName').value = '';
        visible('createForm', false);
        show('homeView');
        status('正在加载…');
      }
      const current = route();
      if (current.round || current.share) {
        const [data, key] = await Promise.all([
          rpc('round', current.share ? {} : {p_round: current.round}),
          current.group && !shareKey ? rpc('share', {p_round: current.round}) : shareKey,
        ]);
        if (version !== revision) return;
        if (current.share) lastShare = current.share;
        if (JSON.stringify(round) !== JSON.stringify(data) || shareKey !== key) {
          shareKey = key;
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
      if (current.group && !quiet) {
        try { localStorage.setItem(managementStorage, current.group); } catch {}
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
      else if (button !== $('finishBtn') || round?.entries.every(entry => entry.die ?? entry.slot)) {
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
      };
      const signature = JSON.stringify(input);
      if (createAttempt?.signature !== signature) createAttempt = {signature, id: crypto.randomUUID()};
      const id = await rpc('create_dice', {p_round: createAttempt.id, ...input});
      createAttempt = null;
      $('sessionName').value = '';
      navigate({...homeParams(), round: id});
    });
  });

  $('personName').addEventListener('input', renderSelection);
  $('drawForm').addEventListener('submit', event => {
    event.preventDefault();
    action($('rollBtn'), async () => {
      const from = location.hash;
      const current = route();
      const name = selectedEntry()?.name || typedName();
      $('diceBox').className = 'dice-box rolling';
      const method = current.share || !round.dice_mode ? 'draw' : 'roll';
      await rpc(method, current.share ? {p_name: name} : {p_round: current.round, p_name: name});
      if (location.hash === from) await load(true);
    });
  });

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
    if (!window.confirm('结束抽签并归档当前排班？')) return;
    await rpc('finish', {p_round: current.round});
    if (route().round === current.round) await load(true);
  }));

  $('shareBtn').addEventListener('click', () => {
    if (shareKey) copy(link({share: shareKey}), '本场链接已复制');
  });
  $('refreshBtn').addEventListener('click', () => action($('refreshBtn'), () => load(true)));
  $('historyList').addEventListener('click', event => {
    const id = event.target.closest('[data-round]')?.dataset.round;
    if (id) navigate({...homeParams(), round: id});
  });
  $('csvBtn').addEventListener('click', () => {
    const rows = [['周次', '日期', '顺序', '姓名', '点数']];
    for (const week of round.schedule) {
      for (const person of week.speakers) rows.push([week.week, week.date, person.slot, person.name, person.die ?? '']);
    }
    const csv = rows.map(row => row.map(value => {
      let cell = String(value);
      if (/^[=+@-]/.test(cell)) cell = "'" + cell;
      return '"' + cell.replace(/"/g, '""') + '"';
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], {type: 'text/csv;charset=utf-8'}));
    const download = document.createElement('a');
    download.href = url;
    download.download = round.name.replace(/[\\/:*?"<>|]/g, '_') + '_汇报排班.csv';
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('copyBtn').addEventListener('click', () => {
    const lines = round.schedule.map(week => `第 ${week.week} 周（${fmtDate(week.date)}）：`
      + week.speakers.map(person => `${person.slot}. ${person.name}`).join('；'));
    copy([round.name + '｜分享汇报排班表', ...lines].join('\n'), '排班表已复制');
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('backHome').addEventListener('click', returnHome);
  $('newBtn').addEventListener('click', returnHome);
  $('resumeRound').addEventListener('click', () => {
    if (lastShare) navigate({share: lastShare});
  });
  document.querySelector('.brand').addEventListener('click', event => {
    event.preventDefault();
    returnHome();
  });

  window.addEventListener('hashchange', () => load());
  setInterval(async () => {
    if (!configured || document.hidden || busy || polling || (!round && !overview)) return;
    polling = true;
    try { await load(true); } finally { polling = false; }
  }, 5000);
  load();
})();
