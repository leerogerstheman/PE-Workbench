/* PE-Workbench · 登录 / 身份选择视图。
 *
 * 演示模式下（内置账号开启）首先显示身份卡：每个身份写明角色、领域与
 * "进入后能看到什么"，点击后要求键入统一密码——密码是真的校验的，
 * 不是点一下就放行。
 */

window.Views.register('identity', {
  async renderLanding(root, bootstrap, afterLogin) {
    const ui = UI;
    ui.clear(root);
    const wrap = ui.el('div', { class: 'login-wrap' });

    // ---------------------------------------------------------- hero -------
    const hero = ui.h(`
      <div class="login-hero">
        <div class="brand-mark">￥</div>
        <h1>药物经济学工作台</h1>
        <div class="muted">PE-Workbench · 让每一步分析可理解、可追溯、可审查</div>
        ${(bootstrap && bootstrap.demoMode) ? '<span class="badge-demo">演示模式：统一密码见身份卡提示 · 请勿用于真实分析记录</span>' : ''}
      </div>
    `);
    wrap.appendChild(hero);

    // --------------------------------------------------- first admin -------
    if (bootstrap && bootstrap.requiresFirstAdmin) {
      const card = ui.el('div', { class: 'card', style: 'max-width:520px;margin:24px auto' });
      card.appendChild(ui.h(`<h3>创建第一个管理员账号</h3>`));
      card.appendChild(ui.h(`<p class="muted">实例尚未配置任何账号。请创建第一个系统管理员；随后可在「用户与权限」中添加其他岗位。</p>`));
      const form = ui.el('form', { onsubmit: async (e) => { e.preventDefault(); await submitSetup(form, card); } });
      form.appendChild(ui.h(`<label>用户名</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'username', required: 'required', minlength: '3' }));
      form.appendChild(ui.h(`<label>姓名</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'fullName', required: 'required' }));
      form.appendChild(ui.h(`<label>密码（≥${(bootstrap.security && bootstrap.security.passwordMinLength) || 10} 位，含大小写/数字/符号三类以上）</label>`));
      form.appendChild(ui.el('input', { type: 'password', name: 'password', required: 'required' }));
      form.appendChild(ui.h(`<label>确认密码</label>`));
      form.appendChild(ui.el('input', { type: 'password', name: 'password2', required: 'required' }));
      form.appendChild(ui.el('button', { class: 'btn primary', type: 'submit', text: '创建并进入' }));
      card.appendChild(form);
      wrap.appendChild(card);
      root.appendChild(wrap);
      return;

      async function submitSetup(formEl, card) {
        const fd = new FormData(formEl);
        if (fd.get('password') !== fd.get('password2')) {
          ui.toast('两次输入的密码不一致', 'err');
          return;
        }
        try {
          await API.post('/api/setup', {
            username: fd.get('username'), fullName: fd.get('fullName'), password: fd.get('password'),
          });
          ui.toast('管理员账号已创建', 'ok');
          afterLogin();
        } catch (err) {
          ui.toastError(err);
        }
      }
    }

    // ------------------------------------------------- identity cards ------
    const choices = (bootstrap && bootstrap.loginChoices) || [];
    if (bootstrap && !bootstrap.requiresFirstAdmin && !choices.length) {
      const card = ui.el('div', { class: 'card', style: 'max-width:480px;margin:24px auto' });
      card.appendChild(ui.h(`<h3>登录</h3>`));
      const form = ui.el('form', { onsubmit: async (e) => { e.preventDefault(); await doLogin(form); } });
      form.appendChild(ui.h(`<label>用户名</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'username', required: 'required' }));
      form.appendChild(ui.h(`<label>密码</label>`));
      form.appendChild(ui.el('input', { type: 'password', name: 'password', required: 'required' }));
      form.appendChild(ui.el('button', { class: 'btn primary', type: 'submit', text: '登录' }));
      card.appendChild(form);
      wrap.appendChild(card);
      root.appendChild(wrap);
      return;

      async function doLogin(formEl) {
        const fd = new FormData(formEl);
        try {
          const res = await API.post('/api/login', { username: fd.get('username'), password: fd.get('password') });
          if (res.ok === false) {
            ui.toast(res.message || '登录失败', 'err');
            if (res.code === 'TOTP_REQUIRED') {
              const td = ui.modal({ title: '动态口令' });
              td.content.appendChild(ui.h(`<p class="muted">该账号已绑定动态口令（TOTP）。</p>`));
              const tf = ui.el('input', { type: 'text', placeholder: '6 位数字', style: 'margin-top:8px' });
              td.content.appendChild(tf);
              const btn = ui.el('button', { class: 'btn primary', text: '验证', onclick: async () => {
                try {
                  const res2 = await API.post('/api/login', { username: fd.get('username'), password: fd.get('password'), totp: tf.value });
                  if (res2.ok === false) { ui.toast(res2.message || '验证失败', 'err'); return; }
                  td.close(); ui.toast('登录成功', 'ok'); afterLogin();
                } catch (err) { ui.toastError(err); }
              } });
              td.content.appendChild(btn);
            }
            return;
          }
          ui.toast('登录成功', 'ok');
          afterLogin();
        } catch (err) { ui.toastError(err); }
      }
    }

    if (choices.length) {
      wrap.appendChild(ui.h(`
        <div style="max-width:860px;margin:18px auto 0">
          <div class="muted small">选择一个身份，然后键入演示密码 <span class="mono" style="background:#fff;border:1px solid #e3e8ef;border-radius:6px;padding:1px 8px">${UI.escapeHtml(bootstrap.passwordHint || '—')}</span></div>
        </div>
      `));
      const grid = ui.el('div', { class: 'identity-grid' });
      for (const c of choices) {
        const card = ui.el('div', { class: 'identity-card' });
        card.dataset.username = c.username;
        const areas = (c.areas || []).map((a) => `<span class="pill">${UI.escapeHtml(a)}</span>`).join('');
        card.innerHTML = `
          <div class="nm">${UI.escapeHtml(c.fullName)} <span class="badge blue">${UI.escapeHtml(c.roleLabel)}</span></div>
          <div class="rl">${UI.escapeHtml(c.jobTitle || '')}</div>
          <div class="dept">${UI.escapeHtml(c.department || '')}</div>
          <div class="blub">${UI.escapeHtml(c.blurb || '')}</div>
          ${c.highlight ? `<div class="small" style="color:#0e7490;margin-top:6px">✦ ${UI.escapeHtml(c.highlight)}</div>` : ''}
          <div class="pillars">${areas}</div>
        `;
        card.addEventListener('click', () => openPasswordDialog(c));
        grid.appendChild(card);
      }
      wrap.appendChild(grid);
      if (bootstrap.demoMode) {
        wrap.appendChild(ui.h(`
          <div class="alert warn" style="max-width:860px;margin:18px auto 0">
            <strong>演示配置警示</strong>：内置身份共用同一密码，这不符合"账号唯一"的账户安全要求
            （21 CFR Part 11 §11.300(a) 之精神）。真实部署必须为每位成员签发独立凭证：
            以 <span class="mono">PE_BUILTIN_ACCOUNTS=0</span> 启动并经过「用户与权限」创建正式账号。
          </div>
        `));
      }
    }

    root.appendChild(wrap);
    return;

    function openPasswordDialog(choice) {
      const m = ui.modal({ title: `${choice.fullName} · ${choice.roleLabel}` });
      m.content.appendChild(ui.h(`<div class="alert info">${UI.escapeHtml(choice.blurb || '')}</div>`));
      m.content.appendChild(ui.h(`<label>密码（演示统一密码：<span class="mono">${UI.escapeHtml(bootstrap.passwordHint || '')}</span>）</label>`));
      const pwd = ui.el('input', { type: 'password', autofocus: 'true' });
      m.content.appendChild(pwd);
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none;margin-top:10px' });
      m.content.appendChild(errBox);
      const row = ui.el('div', { class: 'btn-row' });
      const btn = ui.el('button', { class: 'btn primary', text: '进入' });
      const cancel = ui.el('button', { class: 'btn', text: '取消', onclick: () => m.close() });
      row.appendChild(btn); row.appendChild(cancel);
      m.content.appendChild(row);
      const submit = async () => {
        btn.disabled = true;
        try {
          const res = await API.post('/api/login', { username: choice.username, password: pwd.value });
          if (res.ok === false) {
            errBox.style.display = '';
            errBox.textContent = res.message || '登录失败';
            btn.disabled = false;
            if (res.code === 'TOTP_REQUIRED') {
              m.content.appendChild(ui.h(`<label>动态口令</label>`));
              const totp = ui.el('input', { type: 'text' });
              m.content.appendChild(totp);
              res._totp = totp;
            }
            return;
          }
          m.close();
          ui.toast(`已进入：${choice.fullName}（${choice.roleLabel}）`, 'ok');
          afterLogin();
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
          btn.disabled = false;
        }
      };
      btn.addEventListener('click', submit);
      pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      pwd.focus();
    }
  },
});