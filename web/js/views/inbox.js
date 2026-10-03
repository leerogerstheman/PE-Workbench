/* PE-Workbench · 我的待办：按后果排序，标明签名项与超期天数，并解释权限边界。 */

window.Views.register('inbox', {
  routes: [{ pattern: '/inbox' }],
  async render(params, ctx) {
    const data = await API.get('/api/inbox');
    const ui = UI;
    const frag = document.createDocumentFragment();
    const esc = UI.escapeHtml;

    frag.appendChild(ui.h(`
      <h1>我的待办 <span class="muted small">/ 按后果轻重排序：严重优先 → 需签名优先 → 超期优先</span></h1>
      <div class="kpi-row">
        <div class="kpi"><div class="num">${data.total}</div><div class="lbl">全部待办</div></div>
        <div class="kpi ${data.requiresSignature ? 'danger' : ''}"><div class="num">${data.requiresSignature}</div><div class="lbl">需电子签名</div></div>
        <div class="kpi ${data.overdue ? 'danger' : ''}"><div class="num">${data.overdue}</div><div class="lbl">已超期</div></div>
        <div class="kpi"><div class="num">${data.byKind.finding}</div><div class="lbl">缺陷处置</div></div>
      </div>
    `));

    if (!data.items.length) {
      frag.appendChild(ui.h(`
        <div class="alert ok">当前没有等待你的条目。这不是系统故障——见下方"你的权限范围"。</div>
      `));
    }
    for (const item of data.items) {
      const row = ui.el('div', { class: 'item-row' });
      let icon = '📄';
      if (item.kind === 'notification') icon = item.criticality === 'critical' ? '🔴' : '🟠';
      let badges = `<span class="badge ${item.criticality === 'critical' ? 'red' : item.criticality === 'major' ? 'amber' : 'gray'}">${esc(item.criticality || '')}</span>`;
      if (item.requiresSignature) badges += ' <span class="badge amber">✍ 需签名</span>';
      if (item.overdue) badges += ` <span class="badge red">超期 ${item.overdueDays} 天</span>`;
      row.innerHTML = `
        <div class="ic">${icon}</div>
        <div class="body" style="cursor:pointer">
          <div class="tt">${esc(item.title)}</div>
          <div class="meta"><span class="mono">${esc(item.recordKey || '')}</span> · 动作：${esc(item.action || '')} · ${esc(item.stepName || '')} ${badges}</div>
        </div>
        ${item.link ? '<button class="btn small primary" data-go="1">去处理 →</button>' : ''}
      `;
      row.querySelector('.body').addEventListener('click', () => { if (item.link) location.hash = item.link; });
      const goBtn = row.querySelector('[data-go]');
      if (goBtn) {
        goBtn.addEventListener('click', () => {
          if (!item.link) return;
          const sep = item.link.includes('?') ? '&' : '?';
          location.hash = item.link + (item.stepCode ? sep + 'step=' + encodeURIComponent(item.stepCode) : '');
        });
      }
      frag.appendChild(row);
    }

    // ----------------------------------------------------- permission scope ---
    const ps = data.permissionScope || {};
    const scopeCard = ui.el('div', { class: 'card' });
    scopeCard.appendChild(ui.h(`<h3>你的权限范围 <span class="muted small">/ ${esc(ps.roleLabel || ps.role)}${ps.readonly ? ' · 只读岗位' : ''}</span></h3>`));
    const granted = (ps.granted || []);
    scopeCard.appendChild(ui.h(`
      <div class="grid c2">
        <div>
          <div class="small" style="font-weight:700;color:var(--c-green)">能做什么（${granted.length} 项写权限）</div>
          <div class="small" style="margin-top:6px">${granted.length ? granted.map(esc).join('、') : '无写权限（只读）'}</div>
        </div>
        <div>
          <div class="small" style="font-weight:700;color:var(--c-amber)">有约束（代码强制）</div>
          <div class="small" style="margin-top:6px">
            ${(ps.constrained || []).slice(0, 4).map((c) => `⚠ ${esc(c.constraint)}：${esc(c.reason)}`).join('<br>') || '无（或为系统管理员）'}
          </div>
        </div>
      </div>
    `));
    frag.appendChild(scopeCard);

    return frag;
  },
});