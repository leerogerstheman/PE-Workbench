/* PE-Workbench · 领域卡片页：一个领域一张卡，卡上直接写明理念与规模。 */

window.Views.register('domains', {
  routes: [{ pattern: '/domains' }],
  async render() {
    const data = await API.get('/api/domains');
    const ui = UI;
    const frag = document.createDocumentFragment();
    frag.appendChild(ui.h(`
      <h1>领域与流程 <span class="muted small">/ 药物经济学工作的七个专业领域</span></h1>
      <div class="philosophy-quote">理念：<strong>领域是数据，不是代码。</strong>七个领域共用同一套受控工作流引擎——加一个新流程只需往
      <span class="mono">seed/workflows/</span> 放一个 JSON 文件。领域卡片写明了每个领域"为什么这样工作"，点进去就是该领域的流程图。</div>
    `));
    const grid = ui.el('div', { class: 'grid c3' });
    for (const d of data.domains) {
      const card = ui.el('div', { class: 'card', style: 'cursor:pointer;border-top:4px solid ' + (d.colour || '#0e7490') });
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <h3>${UI.escapeHtml(d.code)} · ${UI.escapeHtml(d.name)}</h3>
          <span class="badge blue">${UI.escapeHtml(d.nameEn)}</span>
        </div>
        <div class="small muted" style="margin-bottom:8px">${UI.escapeHtml(d.philosophy || '')}</div>
        <div class="btn-row" style="margin-top:10px">
          <span class="pill">${d.processCount} 条工作流</span>
          <span class="pill">${d.roleCount} 个岗位</span>
          <span class="pill">${d.recordCount} 条记录</span>
          <span class="pill">${d.checklistCount} 张检查表</span>
        </div>
      `;
      card.addEventListener('click', () => { location.hash = '#/domain/' + d.code; });
      grid.appendChild(card);
    }
    frag.appendChild(grid);
    frag.appendChild(ui.h(`
      <div class="card">
        <h3>工作流总览 <span class="muted small">/ 全部 10 条受控流程</span></h3>
        <div class="grid c3" id="wf-overview"></div>
      </div>
    `));
    const wf = await API.get('/api/workflows');
    const grid2 = frag.querySelector('#wf-overview');
    for (const w of wf.workflows) {
      const areas = (w.gxpAreas || []).map((a) => `<span class="pill">${UI.escapeHtml(a)}</span>`).join('');
      const card = ui.el('div', { style: 'cursor:pointer' });
      card.innerHTML = `
        <div class="card" style="margin:0">
          <h3>${UI.escapeHtml(w.code)} · ${UI.escapeHtml(w.name)}</h3>
          <div class="card-sub">${UI.escapeHtml(w.description || '')}</div>
          <div class="btn-row"><span class="pill">${w.stepCount} 步</span><span class="pill">${w.slaDays || '—'} 天 SLA</span>${areas}</div>
        </div>`;
      card.addEventListener('click', () => { location.hash = '#/workflow/' + w.code; });
      grid2.appendChild(card);
    }
    return frag;
  },
});