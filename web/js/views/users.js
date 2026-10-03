/* PE-Workbench · 用户与权限：账号、角色矩阵、安全策略。 */

window.Views.register('users', {
  routes: [{ pattern: '/users' }],
  async render() {
    const ui = UI;
    const esc = UI.escapeHtml;
    const frag = document.createDocumentFragment();
    const me = App.currentUser();

    frag.appendChild(ui.h(`<h1>用户与权限 <span class="muted small">/ 账号唯一 · 角色即权限 · 职责分离</span></h1>`));
    frag.appendChild(ui.h(`
      <div class="philosophy-quote">理念：<strong>岗位不是标签，是 40+ 项权限与服务端步骤门的绑定。</strong>
      角色决定权限；工作流步骤决定谁能执行哪一步；约束清单决定哪些操作在界面上说"允许"、内核仍会拒绝（独立性与职责分离）。</div>
    `));

    const [userData, roleData, settingsData] = await Promise.all([
      API.get('/api/users'),
      API.get('/api/roles'),
      App.hasPerm('policy.manage') ? API.get('/api/settings') : Promise.resolve(null),
    ]);

    // ------------------------------------------------------------- accounts --
    if (App.hasPerm('user.manage')) {
      const btn = ui.el('button', { class: 'btn primary', text: '+ 新增用户', onclick: () => openCreate(roleData.roles, userData.users) });
      frag.appendChild(ui.el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [btn]));
    }
    const card = ui.el('div', { class: 'card' });
    const tbl = ui.el('div', { class: 'table-wrap' });
    tbl.appendChild(ui.h(`
      <table class="pe"><thead><tr><th>用户名</th><th>姓名</th><th>岗位</th><th>部门</th><th>领域</th><th>状态</th><th>双要素</th><th>最近登录</th><th>操作</th></tr></thead><tbody></tbody></table>
    `));
    const tbody = tbl.querySelector('tbody');
    for (const u of userData.users) {
      const tr = ui.h(`
        <tr>
          <td class="mono">${esc(u.username)}</td><td>${esc(u.fullName)}</td>
          <td><span class="badge blue">${esc(u.roleLabel || u.role)}</span></td>
          <td>${esc(u.department || '')}</td>
          <td>${(u.gxpAreas || []).map(esc).join(', ') || '—'}</td>
          <td><span class="badge ${u.status === 'active' ? 'green' : 'red'}">${esc(u.status)}</span></td>
          <td>${u.totpEnabled ? '✓' : '—'}</td>
          <td class="small">${ui.fmtDate(u.lastLoginAt)}</td>
          <td></td>
        </tr>`);
      const td = tr.querySelector('td:last-child');
      if (App.hasPerm('user.manage') && u.username !== me.username) {
        const editBtn = ui.el('button', { class: 'btn small', text: '管理', onclick: () => openManage(u, roleData.roles) });
        const pwdBtn = ui.el('button', { class: 'btn small', text: '重置密码', onclick: () => openReset(u) });
        td.appendChild(editBtn);
        td.appendChild(ui.el('div', {}, [pwdBtn]));
      }
      tbody.appendChild(tr);
    }
    card.appendChild(tbl);
    frag.appendChild(card);

    // ---------------------------------------------------------------- roles --
    frag.appendChild(ui.h(`<h2>角色与权限 <span class="muted small">/ 点击权限矩阵查看</span></h2>`));
    const rGrid = ui.el('div', { class: 'grid c3' });
    for (const r of roleData.roles) {
      const rcard = ui.el('div', { class: 'card', style: 'margin:0' });
      const isMe = me && me.role === r.code;
      rcard.innerHTML = `
        <h3>${esc(r.labelZh)} ${isMe ? '<span class="badge green">当前</span>' : ''} <span class="muted small mono">${esc(r.code)}</span></h3>
        <div class="card-sub">${esc(r.description || '')}</div>
        <div class="btn-row"><span class="pill">${r.permissionCount} 项权限</span>${r.readOnly ? '<span class="pill">只读</span>' : ''}${r.isRecordParty ? '<span class="pill">记录参与方</span>' : ''}</div>
        <div class="small muted" style="margin-top:8px">${(r.permissions || []).slice(0, 8).map(esc).join('、')}${(r.permissions || []).length > 8 ? '…' : ''}</div>
      `;
      rGrid.appendChild(rcard);
    }
    frag.appendChild(rGrid);

    // ------------------------------------------------------------- policy ----
    if (App.hasPerm('policy.manage') && settingsData) {
      const p = settingsData.policy || {};
      const pCard = ui.el('div', { class: 'card' });
      pCard.appendChild(ui.h(`<h3>安全策略 <span class="muted small">/ 由系统管理员维护</span></h3>`));
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); savePolicy(form); } });
      const row = ui.el('div', { class: 'form-row' });
      row.appendChild(ui.h(`<div><label>密码最小长度</label><input type="number" name="passwordMinLength" value="${p.passwordMinLength ?? ''}"></div>`));
      row.appendChild(ui.h(`<div><label>密码历史深度（不可重用）</label><input type="number" name="passwordHistoryDepth" value="${p.passwordHistoryDepth ?? ''}"></div>`));
      row.appendChild(ui.h(`<div><label>密码最长有效期（天）</label><input type="number" name="passwordMaxAgeDays" value="${p.passwordMaxAgeDays ?? ''}"></div>`));
      row.appendChild(ui.h(`<div><label>失败锁定次数</label><input type="number" name="maxFailedLogins" value="${p.maxFailedLogins ?? ''}"></div>`));
      row.appendChild(ui.h(`<div><label>会话空闲超时（分钟）</label><input type="number" name="idleTimeoutMinutes" value="${p.idleTimeoutMinutes ?? ''}"></div>`));
      row.appendChild(ui.h(`<div><label>会话绝对时长（小时）</label><input type="number" name="sessionAbsoluteHours" value="${p.sessionAbsoluteHours ?? ''}"></div>`));
      form.appendChild(row);
      const ck = ui.h(`<div style="margin-top:10px"><label><input type="checkbox" name="signatureSecondFactor" ${p.signatureSecondFactor ? 'checked' : ''}> 电子签名要求第二要素（TOTP/挑战码）</label></div>`);
      form.appendChild(ck);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">保存策略</button></div>`));
      pCard.appendChild(form);
      frag.appendChild(pCard);

      async function savePolicy(formEl) {
        const fd = new FormData(formEl);
        try {
          await API.patch('/api/settings', {
            passwordMinLength: Number(fd.get('passwordMinLength')),
            passwordHistoryDepth: Number(fd.get('passwordHistoryDepth')),
            passwordMaxAgeDays: Number(fd.get('passwordMaxAgeDays')),
            maxFailedLogins: Number(fd.get('maxFailedLogins')),
            idleTimeoutMinutes: Number(fd.get('idleTimeoutMinutes')),
            sessionAbsoluteHours: Number(fd.get('sessionAbsoluteHours')),
            signatureSecondFactor: fd.get('signatureSecondFactor') === 'on',
          });
          UI.toast('策略已保存（变更已入审计）', 'ok');
        } catch (err) { UI.toastError(err); }
      }
    }

    return frag;

    // ------------------------------------------------------------- helpers --
    function openCreate(roles, users) {
      const m = ui.modal({ title: '新增用户' });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(ui.h(`<label>用户名</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'username', required: 'required', minlength: '3' }));
      form.appendChild(ui.h(`<label>姓名</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'fullName', required: 'required' }));
      form.appendChild(ui.h(`<label>岗位（角色）</label>`));
      const sel = ui.el('select', { name: 'role' });
      for (const r of roles) {
        const o = document.createElement('option');
        o.value = r.code; o.textContent = `${r.labelZh}（${r.code}）`;
        sel.appendChild(o);
      }
      form.appendChild(sel);
      form.appendChild(ui.h(`<label>部门</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'department' }));
      form.appendChild(ui.h(`<label>职责领域（逗号分隔，如 RSD,MDL）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'gxpAreas' }));
      form.appendChild(ui.h(`<label>初始密码（留空则之后用"重置密码"签发）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'initialPassword' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">创建</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
      m.content.appendChild(form);
      async function submit() {
        const fd = new FormData(form);
        try {
          await API.post('/api/users', {
            username: fd.get('username'), fullName: fd.get('fullName'), role: fd.get('role'),
            department: fd.get('department') || undefined,
            gxpAreas: String(fd.get('gxpAreas')).split(',').map((s) => s.trim()).filter(Boolean),
            initialPassword: fd.get('initialPassword') || undefined,
          });
          m.close();
          UI.toast('用户已创建', 'ok');
          App.route();
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }

    function openManage(u, roles) {
      const m = ui.modal({ title: `管理账号 ${u.username}` });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(ui.h(`<label>状态</label>`));
      const sel = ui.el('select', { name: 'status' });
      for (const s of ['active', 'disabled', 'locked', 'pending']) {
        const o = document.createElement('option');
        o.value = s; o.textContent = s; o.selected = s === u.status;
        sel.appendChild(o);
      }
      form.appendChild(sel);
      form.appendChild(ui.h(`<label>岗位（角色）</label>`));
      const rsel = ui.el('select', { name: 'role' });
      for (const r of roles) {
        const o = document.createElement('option');
        o.value = r.code; o.textContent = `${r.labelZh}（${r.code}）`;
        o.selected = r.code === u.role;
        rsel.appendChild(o);
      }
      form.appendChild(rsel);
      form.appendChild(ui.h(`<label>职责领域</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'gxpAreas', value: (u.gxpAreas || []).join(',') }));
      form.appendChild(ui.h(`<label>访问到期时间（外部评审用，留空=不过期）</label>`));
      form.appendChild(ui.el('input', { type: 'date', name: 'accessExpiresAt', value: (u.accessExpiresAt || '').slice(0, 10) }));
      form.appendChild(ui.h(`<label>变更理由（审计留痕）</label>`));
      form.appendChild(ui.el('textarea', { name: 'reason', required: 'required', minlength: '3' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
      m.content.appendChild(form);
      async function submit() {
        const fd = new FormData(form);
        try {
          await API.patch('/api/users/' + u.id, {
            status: fd.get('status'), role: fd.get('role'),
            gxpAreas: String(fd.get('gxpAreas')).split(',').map((s) => s.trim()).filter(Boolean),
            accessExpiresAt: fd.get('accessExpiresAt') || null,
            reason: fd.get('reason'),
          });
          m.close();
          UI.toast('账号已更新', 'ok');
          App.route();
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }

    function openReset(u) {
      const m = ui.modal({ title: `重置密码 ${u.username}` });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(ui.h(`<label>新密码（≥10 位，含三类字符）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'newPassword', required: 'required' }));
      form.appendChild(ui.h(`<label><input type="checkbox" name="mustChange" checked> 首次登录必须修改密码</label>`));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">重置</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
      m.content.appendChild(form);
      async function submit() {
        const fd = new FormData(form);
        try {
          await API.post(`/api/users/${u.id}/reset-password`, {
            newPassword: fd.get('newPassword'), mustChange: fd.get('mustChange') === 'on',
          });
          m.close();
          UI.toast('密码已重置', 'ok');
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }
  },
});