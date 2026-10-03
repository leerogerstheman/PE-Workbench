/* PE-Workbench · application shell.
 *
 * Responsibilities:
 *   - bootstrap the client (instance config, domains, login choices)
 *   - authentication gate, including first-run setup
 *   - hash routing with permission-aware navigation
 *   - global session-ended handling so an idle timeout is explained, not silent
 */
(function () {
  'use strict';

  const state = {
    bootstrap: null,
    user: null,
    currentRoute: null,
    sessionEndedMessage: null,
  };

  let registry = null;

  function bootRegistry() {
    registry = {};
    for (const [name, view] of window.Views.pending) {
      registry[name] = view;
      if (view.routes) {
        for (const r of view.routes) {
          r._view = name;
        }
      }
    }
    window.Views.pending.length = 0;
  }

  function currentUser() {
    return state.user;
  }

  function navLink(label, path, key) {
    const a = document.createElement('a');
    a.href = '#' + path;
    a.textContent = label;
    a.dataset.path = key || path;
    return a;
  }

  function renderShell() {
    const user = state.user;
    const root = document.getElementById('root');
    UI.clear(root);

    const shell = UI.h(`
      <div class="shell">
        <aside class="sidebar">
          <div class="brand"><span class="logo">￥</span><span>药物经济学工作台<small>PE-Workbench · ${(state.bootstrap && state.bootstrap.app && state.bootstrap.app.version) || ''}</small></span></div>
          <nav class="nav"></nav>
          <div class="who"></div>
        </aside>
        <div class="main">
          <header class="topbar"></header>
          <main class="content" id="main-content"></main>
        </div>
      </div>
    `);
    root.appendChild(shell);

    const nav = shell.querySelector('.nav');
    const defs = [
      ['dashboard', '仪表盘', '#/dashboard', 'pe:any'],
      ['inbox', '我的待办', '#/inbox', 'pe:any'],
      ['domains', '领域与流程', '#/domains', 'pe:any'],
      ['records', '质量记录', '#/records', 'record.view'],
      ['analysis', '分析工具', '#/analysis', 'analysis.manage'],
      ['assessments', '自查与检查表', '#/assessments', 'inspection.view'],
      ['documents', '文件控制', '#/documents', 'doc.view'],
      ['audit', '审计追踪', '#/audit', 'audit.view'],
      ['users', '用户与权限', '#/users', 'user.view'],
      ['philosophy', '设计理念', '#/philosophy', 'pe:any'],
    ];
    for (const [key, label, href, perm] of defs) {
      if (perm !== 'pe:any' && !hasPerm(perm)) continue;
      const a = navLink(label, href.replace('#', ''), key);
      a.addEventListener('click', () => {
        for (const n of nav.querySelectorAll('a')) n.classList.remove('active');
        a.classList.add('active');
      });
      nav.appendChild(a);
    }

    const who = shell.querySelector('.who');
    const initial = (user.fullName || user.username || '?').slice(0, 1).toUpperCase();
    who.appendChild(UI.h(`
      <div class="nm">${UI.escapeHtml(user.fullName || user.username)}</div>
      <div class="rl">${UI.escapeHtml(user.roleLabel || user.role)} · ${UI.escapeHtml(user.department || '')}</div>
    `));

    const topbar = shell.querySelector('.topbar');
    topbar.appendChild(UI.el('div', { class: 'crumb' }));
    const search = UI.searchBox();
    search.id = 'global-search';
    topbar.appendChild(search);
    topbar.appendChild(UI.el('div', { class: 'spacer' }));
    const chip = UI.el('div', { class: 'user-chip' });
    chip.appendChild(UI.el('div', { class: 'avatar', text: initial }));
    chip.appendChild(UI.el('span', { text: user.fullName || user.username }));
    const outBtn = UI.el('button', { class: 'btn small', text: '退出', onclick: logout });
    chip.appendChild(outBtn);
    topbar.appendChild(chip);
    if (state.sessionEndedMessage) {
      const banner = UI.el('div', { class: 'alert warn' });
      banner.textContent = state.sessionEndedMessage;
      topbar.insertBefore(banner, topbar.firstChild);
      state.sessionEndedMessage = null;
    }
    bindGlobalKeys();
    return shell;
  }

  // ------------------------------------------------- global keyboard -------
  function bindGlobalKeys() {
    if (bindGlobalKeys.done) return;
    bindGlobalKeys.done = true;
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const box = document.getElementById('global-search');
        if (box) { const inp = box.querySelector('input'); if (inp) { inp.focus(); inp.select(); } }
        return;
      }
      if (!typing && e.key === '/' && state.user) {
        e.preventDefault();
        const box = document.getElementById('global-search');
        if (box) { const inp = box.querySelector('input'); if (inp) inp.focus(); }
      }
    });
  }

  // ---------------------------------------------- first-login onboarding ----
  function maybeOnboarding(shell) {
    if (state.user && !localStorage.getItem('pe.onboarded.v1')) {
      startOnboarding(shell);
    }
  }

  function startOnboarding(shell) {
    const nav = shell.querySelector('.sidebar .nav');
    const steps = [
      {
        title: '第 1 步 · 看流程怎么走',
        body: '「领域与流程」是本工作台的心脏：7 个领域卡片，每个领域第一屏就是工作流程图——每一步下面直接写着负责岗位、签名门槛与指引。先去看一眼，你会立刻明白一条分析是怎么走完的。',
        href: '#/domains',
      },
      {
        title: '第 2 步 · 处理今天的事',
        body: '「我的待办」按后果轻重排序：严重优先、需签名优先、超期优先。点"去处理"直达记录当前步骤，完成表单或签名即可推进流程。',
        href: '#/inbox',
      },
      {
        title: '第 3 步 · 算一笔账',
        body: '「分析工具」提供受审计的 ICER / 预算影响 / QALY 计算器：可先拖动价格看实时预览，点"计算并留痕"才会写入审计，报告里的数字永远可回溯。',
        href: '#/analysis',
      },
    ];
    let idx = 0;
    let anchor = null;
    const backdrop = UI.el('div', { class: 'ob-backdrop' });
    const card = UI.el('div', { class: 'ob-card' });
    card.innerHTML = `
      <div class="ob-title"></div>
      <div class="ob-body"></div>
      <div class="ob-actions">
        <button class="btn small ob-prev">上一步</button>
        <span class="ob-dots"></span>
        <button class="btn small primary ob-next">下一步</button>
      </div>
      <div style="margin-top:8px;text-align:right"><button class="btn small ob-skip">跳过引导</button></div>
    `;

    function position() {
      const step = steps[idx];
      const target = nav.querySelector('a[href="' + step.href + '"]');
      if (anchor) anchor.classList.remove('ob-highlight');
      anchor = target;
      if (anchor) anchor.classList.add('ob-highlight');
      const pos = UI.anchorFor(target || nav, 340, 220);
      card.style.top = pos.top + 'px';
      card.style.left = pos.left + 'px';
      card.querySelector('.ob-title').textContent = step.title;
      card.querySelector('.ob-body').textContent = step.body;
      card.querySelector('.ob-dots').innerHTML = steps.map((s, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('');
      card.querySelector('.ob-prev').style.visibility = idx === 0 ? 'hidden' : 'visible';
      card.querySelector('.ob-next').textContent = idx === steps.length - 1 ? '开始使用' : '下一步';
    }

    function finish() {
      localStorage.setItem('pe.onboarded.v1', '1');
      if (anchor) anchor.classList.remove('ob-highlight');
      backdrop.remove();
      card.remove();
    }

    card.querySelector('.ob-prev').addEventListener('click', () => { idx = Math.max(0, idx - 1); position(); });
    card.querySelector('.ob-next').addEventListener('click', () => {
      if (idx < steps.length - 1) { idx += 1; position(); return; }
      finish();
    });
    card.querySelector('.ob-skip').addEventListener('click', finish);
    backdrop.addEventListener('click', finish);
    document.body.appendChild(backdrop);
    document.body.appendChild(card);
    position();
  }

  function hasPerm(perm) {
    const user = state.user;
    if (!user || !user.permissions) return false;
    return user.permissions.includes('*') || user.permissions.includes(perm);
  }

  async function logout() {
    try { await API.post('/api/logout', {}); } catch { /* ignore */ }
    state.user = null;
    location.hash = '#/';
    route();
  }

  // -------------------------------------------------------------- routing ----
  function matchRoute(path) {
    const parts = path.split('?')[0].split('/').filter(Boolean);
    for (const view of Object.values(registry)) {
      for (const r of (view.routes || [])) {
        const rp = r.pattern.split('/').filter(Boolean);
        if (rp.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < rp.length; i += 1) {
          if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(parts[i]);
          else if (rp[i] !== parts[i]) { ok = false; break; }
        }
        if (ok) return { view, route: r, params };
      }
    }
    return null;
  }

  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    if (!state.user) {
      const view = registry.identity;
      if (view) await view.renderLanding(document.getElementById('root'), state.bootstrap, afterLogin);
      return;
    }
    renderShell();
    const content = document.getElementById('main-content');
    const m = matchRoute(hash);
    if (!m) {
      UI.clear(content);
      content.appendChild(UI.h(`<div class="empty">没有这个页面：${UI.escapeHtml(hash)}。返回 <a href="#/dashboard">仪表盘</a>。</div>`));
      return;
    }
    state.currentRoute = { view: m.view, route: m.route, params: m.params, hash };
    UI.clear(content);
    const loader = UI.el('div', { class: 'loading', text: '加载中…' });
    content.appendChild(loader);
    try {
      const fragment = await m.view.render(m.params, { route: m.route, hash, content });
      if (fragment) {
        UI.clear(content);
        content.appendChild(fragment);
      } else {
        content.querySelector('.loading') && content.querySelector('.loading').remove();
      }
    } catch (err) {
      UI.clear(content);
      content.appendChild(UI.h(`<div class="alert err">${UI.escapeHtml(err.message)}</div>`));
    }
    // active nav highlight
    const nav = document.querySelector('.sidebar .nav');
    if (nav) {
      for (const a of nav.querySelectorAll('a')) {
        const href = a.getAttribute('href').replace('#', '');
        a.classList.toggle('active', hash.startsWith(href) && (href !== '/domains' || hash === href));
      }
    }
    // First-login onboarding only settles on the landing dashboard.
    if (state.user && !localStorage.getItem('pe.onboarded.v1')
        && (hash === '/dashboard' || hash === '/')) {
      const shell = document.querySelector('.shell');
      if (shell) startOnboarding(shell);
    }
  }

  // ----------------------------------------------------------- login flow ---
  async function afterLogin() {
    try {
      const me = await API.get('/api/me');
      state.user = me.user;
      location.hash = '#/dashboard';
      route();
    } catch (err) {
      UI.toastError(err);
    }
  }

  function onSessionEnded(code, message) {
    state.user = null;
    state.sessionEndedMessage = message || '会话已结束，请重新登录。';
    location.hash = '#/';
    route();
  }

  async function boot() {
    bootRegistry();
    try {
      state.bootstrap = await API.get('/api/bootstrap');
    } catch (err) {
      const root = document.getElementById('root');
      UI.clear(root);
      root.appendChild(UI.h(`<div class="alert err" style="max-width:560px;margin:80px auto">${UI.escapeHtml(err.message)}</div>`));
      return;
    }
    // Restore an existing session.
    try {
      const me = await API.get('/api/me');
      state.user = me.user;
    } catch { /* no session */ }
    window.addEventListener('hashchange', route);
    route();
  }

  window.App = {
    state,
    boot,
    route,
    afterLogin,
    onSessionEnded,
    currentUser,
    hasPerm,
    bootstrap: () => state.bootstrap,
    logout,
  };

  document.addEventListener('DOMContentLoaded', boot);
})();