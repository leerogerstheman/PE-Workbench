/* PE-Workbench · 记录详情：受控步骤的执行界面。
 *
 * 服务的核心呈现：一条记录 = 一串有角色门槛、部分需签名的步骤。
 * 每一步显示：负责人（角色）、签名门槛、必填字段、操作指引；仅当当前步骤
 * 允许你的角色时显示"完成"表单。签名步骤走电子签名对话框（双要素）。
 */

window.Views.register('record', {
  routes: [{ pattern: '/records/:id' }],
  async render(params, ctx) {
    const ui = UI;
    const esc = UI.escapeHtml;
    const frag = document.createDocumentFragment();
    const me = App.currentUser();

    const data = await API.get('/api/records/' + params.id);
    const r = data.record;
    const wfData = await API.get('/api/workflows/' + r.processCode);
    const wf = wfData.workflow;

    frag.appendChild(ui.h(`
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h1><span class="mono">${esc(r.recordKey)}</span> · ${esc(r.title)}</h1>
        <div class="btn-row">
          <button class="btn small" onclick="navigator.clipboard && navigator.clipboard.writeText('${esc(r.recordKey)}').then(()=>UI.toast('已复制记录号 ${esc(r.recordKey)}','ok')).catch(()=>{})">⧉ 复制编号</button>
          <span class="badge ${r.overdue ? 'red' : 'blue'}">${esc(I18N.statusLabel(r.status))}</span>
          <span class="badge ${r.criticality === 'critical' ? 'red' : r.criticality === 'major' ? 'amber' : 'gray'}">${esc(r.criticality)}</span>
          <a class="btn small" href="#/records">← 列表</a>
        </div>
      </div>
    `));
    frag.appendChild(ui.h(`<div class="small muted">流程：${esc(r.processName || r.processCode)} · 期限 ${ui.fmtDate(r.dueDate)}${r.overdue ? ' <span class="sev-critical">已超期</span>' : ''} · 版本 v${r.recordVersion}</div>`));

    // --------------------------------------------------- stepper progress ----
    const totalSteps = r.steps.length;
    const firstOpenIdx = r.steps.findIndex((s) => s.status !== 'completed');
    const stepper = ui.el('div', { class: 'stepper' });
    r.steps.forEach((s, i) => {
      const state = s.status === 'completed' ? 'done' : (i === firstOpenIdx ? 'next' : '');
      stepper.appendChild(ui.h(`
        <span class="sp ${state}"><span class="dot">${state === 'done' ? '✓' : i + 1}</span><span class="lb">${esc(s.name || s.code)}</span></span>
      `));
      if (i < totalSteps - 1) stepper.appendChild(ui.h(`<span class="sp-line"></span>`));
    });
    const stepCard = ui.el('div', { class: 'card' });
    stepCard.appendChild(ui.h(`<h3>流程进度 <span class="muted small">/ 共 ${totalSteps} 步，当前第 ${Math.max(0, firstOpenIdx) + 1} 步</span></h3>`));
    stepCard.appendChild(stepper);
    frag.appendChild(stepCard);

    // ----------------------------------------------- next-action CTA card ---
    const chainDef = {};
    for (const node of wf.chain) chainDef[node.code] = node;
    const roleLabelZh = (r) => {
      const p = (wf.participants || []).find((x) => x.role === r);
      return p ? p.label : r;
    };
    const nextStep = firstOpenIdx >= 0 ? r.steps[firstOpenIdx] : null;
    const nextDef = nextStep ? (chainDef[nextStep.code] || {}) : {};
    const canAct = nextStep && userCanAct(nextDef.roles, me);
    const cta = ui.el('div', { class: 'next-action' });
    if (!nextStep) {
      cta.innerHTML = `<div class="na-body"><div class="na-title">🎉 全部步骤已完成</div>
        <div class="na-meta">记录 ${esc(r.recordKey)} 已走完流程。${isTerminal(r) ? '本记录处于终态，只读。' : '如需继续推进，请联系 QA 完成更新。'}</div></div>`;
    } else if (canAct) {
      cta.innerHTML = `
        <div class="na-body">
          <div class="na-title">下一步：${esc(nextStep.name || nextStep.code)}</div>
          <div class="na-meta">${nextStep.signatureMeaning ? '✍ 需要电子签名' : '填写表单即可'}`
            + (r.dueDate ? ` · 完成期限 ${ui.fmtDate(r.dueDate)}${r.overdue ? '（已超期）' : ''}` : '') + `</div>
        </div>
        <button class="btn primary" id="cta-go" type="button">开始处理</button>`;
    } else {
      cta.innerHTML = `
        <div class="na-body">
          <div class="na-title">等待：<span class="sev-major">${esc((nextDef.roles || []).map(roleLabelZh).join(' / ') || '相关岗位')}</span></div>
          <div class="na-meta">当前步骤「${esc(nextStep.name || nextStep.code)}」不在你的职责范围（${esc((me && me.roleLabel) || me && me.role || '未登录')}）。该步骤的负责人会在「我的待办」中收到提示，你可以先行查看与审阅。</div>
        </div>`;
    }
    frag.appendChild(cta);

    // -------------------------------------------------------- basic info -----
    const infoCard = ui.el('div', { class: 'card' });
    infoCard.appendChild(ui.h(`<h3>记录信息 <span class="muted small">/ ${esc(r.processNameEn || r.processCode)}</span></h3>`));
    const rows = [];
    if (r.summary) rows.push(['目的/摘要', r.summary]);
    if (r.product) rows.push(['药品/技术', r.product]);
    if (r.studyCode) rows.push(['研究编号', r.studyCode]);
    for (const f of (r.definition && r.definition.fields) || []) {
      const v = r.data[f.key];
      if (v) rows.push([f.label || f.key, typeof v === 'string' ? v : JSON.stringify(v)]);
    }
    if (r.parent) rows.push(['上级记录', `<a href="#/records/${r.parent.id}">${esc(r.parent.recordKey)} · ${esc(r.parent.title)}</a>`]);
    for (const c of r.children) rows.push(['关联记录', `<a href="#/records/${c.id}">${esc(c.recordKey)} · ${esc(c.title)}</a>（${esc(c.link_type || 'related')}）`]);
    const tbl = ui.el('div', { class: 'table-wrap' });
    tbl.appendChild(ui.h(`<table class="pe"><tbody></tbody></table>`));
    for (const [k, v] of rows) {
      tbl.querySelector('tbody').appendChild(ui.h(`<tr><th style="width:140px;white-space:nowrap">${esc(k)}</th><td>${v}</td></tr>`));
    }
    infoCard.appendChild(tbl);

    // ------------------------------------------------- edits / cancel -------
    const actions = ui.el('div', { class: 'btn-row' });
    if (App.hasPerm('record.edit') && !isTerminal(r)) {
      const editBtn = ui.el('button', { class: 'btn', text: '编辑记录（需理由）', onclick: () => openEditDialog(r) });
      actions.appendChild(editBtn);
    }
    if (App.hasPerm('record.close') && !isTerminal(r)) {
      const cancelBtn = ui.el('button', { class: 'btn danger', text: '取消记录', onclick: () => cancelRecord(r) });
      actions.appendChild(cancelBtn);
    }
    infoCard.appendChild(actions);
    frag.appendChild(infoCard);

    // ------------------------------------------------------------- steps -----
    frag.appendChild(ui.h(`<h2>步骤 <span class="muted small">/ 当前行为：<strong>${esc(r.currentStep || '—')}</strong></span></h2>`));
    const stepsCard = ui.el('div', { class: 'card' });

    let actionable = null;
    for (const s of r.steps) {
      const def = chainDef[s.code] || {};
      const done = s.status === 'completed';
      const isCurrent = s.status !== 'completed';
      const node = ui.el('div', { class: 'cnode' + (done ? ' done' : (actionable === null ? ' next' : '')) });
      node.id = 'step-' + s.code;
      let html = `
        <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
          <strong>${s.seq}. ${esc(s.name || s.code)}</strong>
          ${s.signatureMeaning ? `<span class="badge amber">✍ 签名：${esc(s.signatureMeaning)}</span>` : ''}
          ${done ? '<span class="badge green">已完成</span>' : (isCurrent ? '<span class="badge blue">当前</span>' : '')}
          ${s.completedAt ? `<span class="small muted">${ui.fmtDate(s.completedAt)}</span>` : ''}
        </div>
        <div class="small muted">负责角色：${(def.roles || []).map(esc).join(' / ') || '—'}</div>
      `;
      if (def.guidance) html += `<div class="small" style="color:#0e7490;margin-top:4px">💡 ${esc(def.guidance)}</div>`;
      node.innerHTML = html;

      // Render the actionable form for the next incomplete step the user's role fits.
      if (isCurrent && actionable === null && userCanAct(def.roles, me)) {
        actionable = s;
        node.appendChild(renderStepForm(r, s, def));
      } else if (isCurrent && actionable === null && !userCanAct(def.roles, me)) {
        node.appendChild(ui.h(`<div class="alert warn">这一步需要：${(def.roles || []).map(esc).join(' / ') || '—'}。当前岗位（${esc(me ? me.role : '未登录')}）不能执行——见流程页的权限矩阵。</div>`));
        actionable = { skip: true }; // show reason for the first blocked step only
      }
      if (s.formData && Object.keys(s.formData).length) {
        const fd = Object.entries(s.formData).map(([k, v]) => `<tr><th style="white-space:nowrap">${esc(k)}</th><td>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('');
        node.appendChild(ui.h(`<div class="small muted" style="margin-top:8px"><details><summary>本步骤填写内容</summary><div class="table-wrap"><table class="pe"><tbody>${fd}</tbody></table></div></details></div>`));
      }
      stepsCard.appendChild(node);
    }
    frag.appendChild(stepsCard);

    // ------------------------------------------------------------ history ----
    const histCard = ui.el('div', { class: 'card' });
    histCard.appendChild(ui.h(`<h3>历史 <span class="muted small">/ 每一步都有留痕</span></h3>`));
    const tl = ui.el('div', { class: 'timeline' });
    for (const h of r.history) {
      tl.appendChild(ui.h(`
        <div class="te">
          <div>${esc(h.action)} <span class="mono">${esc(h.stepCode || '')}</span> → ${esc(I18N.statusLabel(h.toStatus || ''))}
          ${h.signatureId ? '<span class="badge amber">已签名</span>' : ''}</div>
          <div class="small muted">${esc(h.actor || '')} · ${ui.fmtDate(h.at)}</div>
          ${h.comment ? `<div class="small">${esc(h.comment)}</div>` : ''}
        </div>`));
    }
    histCard.appendChild(tl);
    frag.appendChild(histCard);

    // ---------------------------------------------------------- signature ----
    if (r.signatures && r.signatures.length) {
      frag.appendChild(ui.h(`<h2>电子签名 <span class="muted small">/ 双要素：密码 + 动态口令/一次性挑战码</span></h2>`));
      const sigCard = ui.el('div', { class: 'card' });
      const st = ui.el('div', { class: 'table-wrap' });
      st.appendChild(ui.h(`<table class="pe"><thead><tr><th>含义</th><th>签署人</th><th>步骤</th><th>理由</th><th>时间</th></tr></thead><tbody></tbody></table>`));
      for (const s of r.signatures) {
        st.querySelector('tbody').appendChild(ui.h(`
          <tr><td><span class="badge amber">${esc(s.meaningCode || s.meaning)}</span></td><td>${esc(s.printedName)}</td>
          <td class="mono">${esc(s.stepCode || '')}</td><td class="small">${esc(s.reason || '')}</td><td>${ui.fmtDate(s.signedAt)}</td></tr>`));
      }
      sigCard.appendChild(st);
      frag.appendChild(sigCard);
    }

    // --------------------------------------------------- CTA + ?step= action ---
    const goBtn = frag.querySelector('#cta-go');
    if (goBtn && nextStep) {
      goBtn.addEventListener('click', () => {
        const el = document.getElementById('step-' + nextStep.code);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    const wantStep = new URLSearchParams(String(ctx.hash.split('?')[1] || '')).get('step');
    if (wantStep) {
      setTimeout(() => {
        const el = document.getElementById('step-' + wantStep);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 250);
    }

    return frag;

    // ------------------------------------------------------------- helpers ---
    function userCanAct(roles, user) {
      if (!user) return false;
      if (!roles || !roles.length) return true;
      if (roles.includes('*')) return true;
      if (roles.includes(user.role)) return true;
      // heor_lead override is server-side; mirror it for UX
      if (user.role === 'heor_lead') return true;
      return false;
    }

    function isTerminal(rec) {
      const t = (rec.definition && rec.definition.terminalStates) || [];
      return t.includes(rec.status);
    }

    function renderStepForm(rec, step, def) {
      const wrap = ui.el('div', { style: 'margin-top:10px;border-top:1px dashed #e3e8ef;padding-top:10px' });
      wrap.appendChild(ui.h(`<div class="small" style="font-weight:700">完成此步骤</div>`));
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(form); } });
      for (const f of def.form || []) {
        form.appendChild(ui.h(`<label>${esc(f.label || f.key)}${f.required ? ' *' : ''}</label>`));
        if (f.type === 'select') {
          const sel = ui.el('select', { name: f.key, required: f.required ? 'required' : null });
          for (const o of (f.options || [])) {
            const opt = document.createElement('option');
            opt.value = o; opt.textContent = o;
            sel.appendChild(opt);
          }
          if (!f.required) {
            const opt0 = document.createElement('option');
            opt0.value = ''; opt0.textContent = '（选填）';
            opt0.selected = true;
            sel.prepend(opt0);
          }
          form.appendChild(sel);
        } else if (f.type === 'textarea') {
          form.appendChild(ui.el('textarea', { name: f.key, required: f.required ? 'required' : null }));
        } else if (f.type === 'date') {
          form.appendChild(ui.el('input', { type: 'date', name: f.key, required: f.required ? 'required' : null }));
        } else {
          form.appendChild(ui.el('input', { type: 'text', name: f.key, required: f.required ? 'required' : null }));
        }
        if (f.help) form.appendChild(ui.h(`<div class="hint">${esc(f.help)}</div>`));
      }
      form.appendChild(ui.h(`<label>备注 / 说明（选填）</label>`));
      form.appendChild(ui.el('textarea', { name: '_comment' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      const row = ui.el('div', { class: 'btn-row' });
      const btn = ui.el('button', {
        class: 'btn primary',
        text: step.signatureMeaning ? `✍ 签名并完成（${step.signatureMeaning}）` : '完成本步骤',
        type: 'submit',
      });
      row.appendChild(btn);
      form.appendChild(row);
      wrap.appendChild(form);

      async function submit(formEl) {
        const fd = new FormData(formEl);
        const formData = {};
        for (const f of def.form || []) {
          const v = fd.get(f.key);
          if (v !== null && v !== '') formData[f.key] = v;
        }
        const comment = fd.get('_comment');
        let signatureId;
        if (step.signatureMeaning) {
          btn.disabled = true;
          const sig = await UI.signatureDialog({
            title: `签署「${step.name || step.code}」`,
            meaning: step.signatureMeaning,
            meaningLabel: step.signatureMeaning,
            entityType: 'workflow_instances',
            entityId: rec.id,
            recordKey: rec.recordKey,
            stepCode: step.code,
            username: me ? me.username : '',
          });
          if (!sig) { btn.disabled = false; return; }
          signatureId = sig.signature.id;
        }
        btn.disabled = true;
        try {
          const res = await API.post(`/api/records/${rec.id}/steps/${step.code}/complete`, {
            formData, comment: comment || null, signatureId: signatureId || undefined,
          });
          UI.toast(`步骤「${step.name || step.code}」已完成`, 'ok');
          location.hash = '#/records/' + rec.id;
          App.route();
        } catch (err) {
          btn.disabled = false;
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
      return wrap;
    }

    function openEditDialog(rec) {
      const m = ui.modal({ title: `编辑记录 ${rec.recordKey}` });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(form); } });
      form.appendChild(ui.h(`<label>标题</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'title', value: rec.title }));
      form.appendChild(ui.h(`<label>严重程度</label>`));
      const cs = ui.el('select', { name: 'criticality' });
      for (const c of ['minor', 'major', 'critical']) {
        const o = document.createElement('option');
        o.value = c; o.textContent = c; o.selected = c === rec.criticality;
        cs.appendChild(o);
      }
      form.appendChild(cs);
      form.appendChild(ui.h(`<label>完成期限</label>`));
      form.appendChild(ui.el('input', { type: 'date', name: 'dueDate', value: (rec.dueDate || '').slice(0, 10) }));
      form.appendChild(ui.h(`<label>修改理由（必填，审计留痕）</label>`));
      form.appendChild(ui.el('textarea', { name: 'reason', required: 'required', minlength: '3' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" onclick="UI.closeModal()">取消</button></div>`));
      m.content.appendChild(form);

      async function submit(formEl) {
        const fd = new FormData(formEl);
        const patch = {};
        if (fd.get('title')) patch.title = fd.get('title');
        if (fd.get('criticality')) patch.criticality = fd.get('criticality');
        if (fd.get('dueDate')) patch.dueDate = fd.get('dueDate');
        patch.reason = fd.get('reason');
        try {
          await API.patch('/api/records/' + rec.id, patch);
          m.close();
          UI.toast('已保存（修改已入审计追踪）', 'ok');
          App.route();
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }

    function cancelRecord(rec) {
      const m = ui.modal({ title: `取消记录 ${rec.recordKey}` });
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
      form.appendChild(ui.h(`<div class="alert warn">取消是不可逆的：记录进入终态"已取消"。取消理由至少 10 个字。</div>`));
      form.appendChild(ui.h(`<label>取消理由</label>`));
      form.appendChild(ui.el('textarea', { name: 'reason', required: 'required', minlength: '10' }));
      const errBox = ui.el('div', { class: 'alert err', style: 'display:none' });
      form.appendChild(errBox);
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn danger" type="submit">确认取消</button><button class="btn" type="button" onclick="UI.closeModal()">返回</button></div>`));
      m.content.appendChild(form);

      async function submit() {
        const fd = new FormData(form);
        try {
          await API.post(`/api/records/${rec.id}/cancel`, { reason: fd.get('reason') });
          m.close();
          UI.toast('记录已取消', 'ok');
          App.route();
        } catch (err) {
          errBox.style.display = '';
          errBox.textContent = err.message;
        }
      }
    }
  },
});