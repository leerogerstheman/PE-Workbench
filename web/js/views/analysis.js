/* PE-Workbench · 分析工具：受审计的 ICER / BIA / QALY 计算器。
 *
 * 每个计算都在服务端运行并写入审计追踪——报告里的每个数字都能追溯到
 * 一次带输入输出的计算记录。
 */

window.Views.register('analysis', {
  routes: [{ pattern: '/analysis' }],
  async render() {
    const ui = UI;
    const frag = document.createDocumentFragment();
    const esc = UI.escapeHtml;

    frag.appendChild(ui.h(`
      <h1>分析工具 <span class="muted small">/ 受审计的汇总计算器：ICER · 预算影响 · QALY</span></h1>
      <div class="alert info">这些计算器是<strong>汇总计算</strong>，不是建模工具——经济模型仍在 R/Excel/TreeAge 中构建并走 MODEL 流程。
      这里算的是<strong>会落进报告里的数字</strong>，所以每次计算都记录输入、输出与操作者，审计可追溯（CHEERS 2022 第 21-23 项）。</div>
    `));

    const tabs = ui.el('div', { class: 'tabs' });
    const tabDefs = [['cea', '成本-效果（ICER / INMB）'], ['bia', '预算影响分析'], ['qaly', 'QALY 累计与贴现']];
    let activeTab = 'cea';
    for (const [key, label] of tabDefs) {
      const t = ui.el('div', { class: 'tab' + (key === activeTab ? ' active' : ''), text: label });
      t.dataset.tab = key;
      t.addEventListener('click', () => {
        activeTab = key;
        tabs.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === key));
        document.getElementById('calc-panels').querySelectorAll('.calc-panel').forEach((p) => {
          p.style.display = p.dataset.panel === key ? '' : 'none';
        });
      });
      tabs.appendChild(t);
    }
    frag.appendChild(tabs);

    const panels = ui.el('div', { id: 'calc-panels' });
    panels.appendChild(ceaPanel());
    panels.appendChild(biaPanel());
    panels.appendChild(qalyPanel());
    frag.appendChild(panels);

    // ------------------------------------------------------------- history --
    frag.appendChild(ui.h(`<h2 style="margin-top:22px">最近计算 <span class="muted small">/ 全部留痕</span></h2>`));
    const history = await API.get('/api/analysis?limit=20');
    const histCard = ui.el('div', { class: 'card' });
    const tbl = ui.el('div', { class: 'table-wrap' });
    tbl.appendChild(ui.h(`
      <table class="pe"><thead><tr><th>#</th><th>标签</th><th>类型</th><th>关键结果</th><th>时间</th></tr></thead><tbody></tbody></table>
    `));
    const tbody = tbl.querySelector('tbody');
    for (const c of history.calculations) {
      const out = c.output || {};
      let key = '';
      if (c.kind === 'cea') key = `ICER ${out.icer != null ? '¥' + UI.fmtMoney(out.icer) : '—'} · INMB ¥${UI.fmtMoney(out.inmb)}`;
      if (c.kind === 'bia') key = `5 年增量 ¥${UI.fmtMoney(out.totalIncremental)}`;
      if (c.kind === 'qaly') key = `${out.totalQalyDiscounted} QALY（贴现 ${(out.discountRate || 0) * 100}%）`;
      tbody.appendChild(ui.h(`<tr><td class="mono">${c.id}</td><td>${esc(c.label)}</td><td><span class="badge blue">${esc(c.kind)}</span></td><td>${esc(key)}</td><td>${ui.fmtDate(c.createdAt)}</td></tr>`));
    }
    if (!history.calculations.length) {
      tbody.appendChild(ui.h(`<tr><td colspan="5"><div class="empty">还没有计算记录。</div></td></tr>`));
    }
    histCard.appendChild(tbl);
    frag.appendChild(histCard);

    return frag;

    // ------------------------------------------------------------- panels ---
    function ceaPanel() {
      const panel = ui.el('div', { class: 'calc-panel', dataset: { panel: 'cea' } });
      const card = ui.el('div', { class: 'card' });
      card.appendChild(ui.h(`<h3>成本-效果分析 <span class="muted small">/ Δ成本 ÷ Δ效果 = ICER</span></h3>`));
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); run(); } });
      form.appendChild(ui.h(`<label>计算标签（如：PE-001 基础分析）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'label', placeholder: 'PE-001 基础分析' }));
      const row = ui.el('div', { class: 'form-row' });
      row.appendChild(ui.h(`<div><label>新方案总成本（¥）</label><input type="number" name="costNew" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>对照总成本（¥）</label><input type="number" name="costComp" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>新方案效果（QALY）</label><input type="number" name="effectNew" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>对照效果（QALY）</label><input type="number" name="effectComp" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>支付意愿阈值（元/QALY）</label><input type="number" name="wtp" required step="any" value="293000"></div>`));
      form.appendChild(row);
      form.appendChild(ui.h(`<div class="hint">阈值参考：国内定价讨论常以 1-3 倍人均 GDP 为参考区间（2026 年示例值 293,000 ≈ 3× 人均 GDP）；具体以主管部门口径为准。</div>`));

      // 交互式调参预览：拖动价格即时看 ICER（借鉴 Shiny/HTA 的交互式参数探索）。
      // 预览只在本地计算，点"计算并留痕"才写入审计。
      const preview = ui.el('div', { class: 'icer-preview' });
      preview.appendChild(ui.h(`
        <div class="pv-body">
          <div class="small" style="font-weight:700">实时预览（本地计算 · 不写审计）</div>
          <div class="ip-slider">
            <span class="small">新方案价格调整</span>
            <input type="range" name="disc" min="-40" max="30" step="1" value="0">
            <span class="small mono" id="disc-label">0%</span>
          </div>
          <div class="ip-row">
            <div class="ip-cell"><div class="k">Δ成本</div><div class="v" id="pv-dc">—</div></div>
            <div class="ip-cell"><div class="k">Δ效果 (QALY)</div><div class="v" id="pv-de">—</div></div>
            <div class="ip-cell"><div class="k">ICER（元/QALY）</div><div class="v" id="pv-icer">—</div></div>
            <div class="ip-cell"><div class="k">INMB（按阈值）</div><div class="v" id="pv-inmb">—</div></div>
            <div class="ip-cell"><div class="k">结论</div><div class="v" id="pv-verdict" style="font-size:12.5px">—</div></div>
          </div>
        </div>
      `));
      form.appendChild(preview);

      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">计算并留痕</button></div>`));
      const result = ui.el('div');
      form.appendChild(result);
      card.appendChild(form);
      panel.appendChild(card);

      const discInput = preview.querySelector('input[name=disc]');
      const inputs = form.querySelectorAll('input[name=costNew], input[name=costComp], input[name=effectNew], input[name=effectComp], input[name=wtp]');
      const NUM = (name) => Number((form.querySelector('input[name=' + name + ']') || {}).value);

      function renderPreview() {
        const costNew = NUM('costNew');
        const costComp = NUM('costComp');
        const effectNew = NUM('effectNew');
        const effectComp = NUM('effectComp');
        const wtp = NUM('wtp');
        const disc = Number(discInput.value || 0);
        preview.querySelector('#disc-label').textContent = disc + '%';
        const cN = costNew * (1 - disc / 100);
        const valid = [costNew, costComp, effectNew, effectComp, wtp].every((n) => Number.isFinite(n) && n >= 0);
        const fmt = (n) => n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
        if (!valid) return;
        const dc = Math.round((cN - costComp) * 100) / 100;
        const de = effectNew - effectComp;
        const inmb = Math.round((de * wtp - dc) * 100) / 100;
        let icer = '—';
        if (dc > 0 && de > 0) icer = '¥' + fmt(dc / de);
        else if (dc < 0 && de < 0) icer = '¥' + fmt(dc / de) + '（负值）';
        let verdict;
        let cls;
        if (dc <= 0 && de > 0) { verdict = '占优（更省更有效）'; cls = 'good'; }
        else if (dc >= 0 && de < 0) { verdict = '被占优（更贵更差）'; cls = 'bad'; }
        else if (dc > 0 && de > 0) { verdict = dc / de <= wtp ? `有经济性（ICER ≤ 阈值）` : '高于阈值（需谈判降价）'; cls = dc / de <= wtp ? 'good' : 'bad'; }
        else { verdict = '更省钱但效果更少（权衡）'; cls = de === 0 ? 'bad' : ''; }
        preview.querySelector('#pv-dc').textContent = (dc >= 0 ? '+' : '') + '¥' + fmt(dc);
        preview.querySelector('#pv-de').textContent = (de >= 0 ? '+' : '') + de.toFixed(3);
        preview.querySelector('#pv-icer').textContent = icer;
        preview.querySelector('#pv-inmb').textContent = (inmb >= 0 ? '+' : '') + '¥' + fmt(inmb);
        const v = preview.querySelector('#pv-verdict');
        v.textContent = verdict;
        v.className = 'v ' + cls;
      }

      discInput.addEventListener('input', renderPreview);
      inputs.forEach((n) => n.addEventListener('input', renderPreview));
      renderPreview();

      async function run() {
        const fd = new FormData(form);
        const disc = Number(discInput.value || 0);
        const costNew = Number(fd.get('costNew'));
        const input = {
          label: String(fd.get('label') || 'CEA 计算')
            + (disc !== 0 ? `（新方案价格 ${disc > 0 ? '+' : ''}${disc}% 情景）` : ''),
          costNew: disc !== 0 ? Math.round(costNew * (1 - disc / 100) * 100) / 100 : costNew,
          costComp: Number(fd.get('costComp')),
          effectNew: Number(fd.get('effectNew')), effectComp: Number(fd.get('effectComp')), wtp: Number(fd.get('wtp')),
        };
        try {
          const res = await API.post('/api/analysis/cea', input);
          renderCEAResult(result, res.calculation.output);
        } catch (err) {
          result.appendChild(ui.h(`<div class="alert err">${esc(err.message)}</div>`));
        }
      }
      return panel;
    }

    function renderCEAResult(container, out) {
      UI.clear(container);
      const dC = out.deltaCost;
      const dE = out.deltaEffect;
      const quadrantLabel = {
        NE_tradeoff: '更贵且更有效（需要阈值判断）',
        SE_dominant: '更省且更有效（占优 dominant）',
        NW_dominated: '更贵且更差（被占优 dominated）',
        SW_tradeoff: '更省但效果更少（省钱权衡）',
      };
      container.appendChild(ui.h(`
        <div class="alert ${out.quadrant === 'NW_dominated' ? 'err' : out.quadrant === 'SE_dominant' ? 'ok' : 'info'}" style="margin-top:12px">
          <strong>结果（已入审计追踪）</strong><br>
          Δ成本：¥${UI.fmtMoney(dC)} · Δ效果：${dE.toFixed(3)} QALY · 象限：${esc(quadrantLabel[out.quadrant] || out.quadrant)}<br>
          ICER：<strong>${out.icer != null ? '¥' + UI.fmtMoney(out.icer) + ' / QALY' : '不计算（无效果差异或占优）'}</strong> · INMB（阈值 ¥${UI.fmtMoney(out.inputsSnapshot.wtp)}）：¥${UI.fmtMoney(out.inmb)}
        </div>
      `));
      for (const line of (out.interpretation || [])) {
        container.appendChild(ui.h(`<div class="small" style="margin-top:4px">· ${esc(line)}</div>`));
      }
    }

    function biaPanel() {
      const panel = ui.el('div', { class: 'calc-panel', dataset: { panel: 'bia' }, style: 'display:none' });
      const card = ui.el('div', { class: 'card' });
      card.appendChild(ui.h(`<h3>预算影响分析 <span class="muted small">/ 医保基金的增量支出</span></h3>`));
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); run(); } });
      form.appendChild(ui.h(`<label>计算标签</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'label', placeholder: 'PE-001 医保准入（5 年）' }));
      const row = ui.el('div', { class: 'form-row' });
      row.appendChild(ui.h(`<div><label>适用人群规模（人/年）</label><input type="number" name="population" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>新药人均年费用（¥）</label><input type="number" name="costNewPerPatient" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>对照组合人均年费用（¥）</label><input type="number" name="costCompPerPatient" required step="any"></div>`));
      row.appendChild(ui.h(`<div><label>测算年限</label><input type="number" name="horizonYears" value="5" min="1" max="10"></div>`));
      form.appendChild(row);
      form.appendChild(ui.h(`<label>逐年市场份额（逗号分隔，如 0.08,0.12,0.16,0.19,0.21）</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'shareNew', placeholder: '0.08,0.12,0.16,0.19,0.21' }));
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">计算并留痕</button></div>`));
      const result = ui.el('div');
      form.appendChild(result);
      card.appendChild(form);
      panel.appendChild(card);

      async function run() {
        const fd = new FormData(form);
        const shareNew = String(fd.get('shareNew')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        if (!shareNew.length) { result.innerHTML = '<div class="alert err">请填写市场份额</div>'; return; }
        const input = {
          label: fd.get('label'), population: Number(fd.get('population')),
          costNewPerPatient: Number(fd.get('costNewPerPatient')), costCompPerPatient: Number(fd.get('costCompPerPatient')),
          horizonYears: Number(fd.get('horizonYears')) || 5, shareNew,
        };
        try {
          const res = await API.post('/api/analysis/bia', input);
          const out = res.calculation.output;
          UI.clear(result);
          result.appendChild(ui.h(`
            <div class="alert info" style="margin-top:12px"><strong>${esc(out.horizonYears)} 年增量累计：¥${UI.fmtMoney(out.totalIncremental)}（已入审计追踪）</strong></div>
            <div class="table-wrap" style="margin-top:8px"><table class="pe"><thead><tr><th>年</th><th>份额</th><th>新药患者数</th><th>方案总成本</th><th>对照总成本</th><th>增量</th></tr></thead><tbody>
            ${out.years.map((y) => `<tr><td>${y.year}</td><td>${y.share}%</td><td>${y.patientsOnNew}</td><td>¥${UI.fmtMoney(y.totalCost)}</td><td>¥${UI.fmtMoney(y.comparatorCost)}</td><td><span class="${y.incremental >= 0 ? 'sev-critical' : 'sev-major'}">¥${UI.fmtMoney(y.incremental)}</span></td></tr>`).join('')}
            </tbody></table></div>
            ${(out.interpretation || []).map((l) => `<div class="small" style="margin-top:4px">· ${esc(l)}</div>`).join('')}
          `));
        } catch (err) {
          result.appendChild(ui.h(`<div class="alert err">${esc(err.message)}</div>`));
        }
      }
      return panel;
    }

    function qalyPanel() {
      const panel = ui.el('div', { class: 'calc-panel', dataset: { panel: 'qaly' }, style: 'display:none' });
      const card = ui.el('div', { class: 'card' });
      card.appendChild(ui.h(`<h3>QALY 累计与贴现 <span class="muted small">/ 效用值 × 生存时间，按年贴现</span></h3>`));
      const form = ui.el('form', { onsubmit: (e) => { e.preventDefault(); run(); } });
      form.appendChild(ui.h(`<label>计算标签</label>`));
      form.appendChild(ui.el('input', { type: 'text', name: 'label', placeholder: 'PE-001 组 QALY' }));
      form.appendChild(ui.h(`<label>贴现率（如 0.05 = 5%）</label>`));
      form.appendChild(ui.el('input', { type: 'number', name: 'discountRate', value: '0.05', required: true, step: 'any' }));
      form.appendChild(ui.h(`<label>健康状态周期（每行：效用值, 持续年数；可多行）</label>`));
      const ta = ui.el('textarea', { name: 'cycles', rows: '4', placeholder: '0.71, 1.1\n0.62, 1.4\n0.45, 1.9' });
      form.appendChild(ta);
      form.appendChild(ui.h(`<div class="hint">效用值 0-1（1=完全健康，0=死亡）。连续行按时间顺序依次贴现。</div>`));
      form.appendChild(ui.h(`<div class="btn-row"><button class="btn primary" type="submit">计算并留痕</button></div>`));
      const result = ui.el('div');
      form.appendChild(result);
      card.appendChild(form);
      panel.appendChild(card);

      async function run() {
        const fd = new FormData(form);
        const cycles = String(fd.get('cycles')).split('\n').map((line) => {
          const parts = line.split(/[,，\s]+/).filter(Boolean);
          if (parts.length < 2) return null;
          return { utility: Number(parts[0]), years: Number(parts[1]) };
        }).filter(Boolean);
        if (!cycles.length) { result.innerHTML = '<div class="alert err">请至少填写一行：效用值, 年数</div>'; return; }
        try {
          const res = await API.post('/api/analysis/qaly', {
            label: fd.get('label'), discountRate: Number(fd.get('discountRate')), cycles,
          });
          const out = res.calculation.output;
          UI.clear(result);
          result.appendChild(ui.h(`
            <div class="alert info" style="margin-top:12px"><strong>贴现后合计：${out.totalQalyDiscounted} QALY</strong>（未贴现 ${out.totalQalyUndiscounted}）— 已入审计追踪</div>
            <div class="table-wrap" style="margin-top:8px"><table class="pe"><thead><tr><th>起点 t</th><th>效用</th><th>持续(年)</th><th>贴现 QALY</th></tr></thead><tbody>
            ${out.cycles.map((c) => `<tr><td>${c.t}</td><td>${c.utility}</td><td>${c.years}</td><td>${c.qalyDiscounted}</td></tr>`).join('')}
            </tbody></table></div>
            ${(out.interpretation || []).map((l) => `<div class="small" style="margin-top:4px">· ${esc(l)}</div>`).join('')}
          `));
        } catch (err) {
          result.appendChild(ui.h(`<div class="alert err">${esc(err.message)}</div>`));
        }
      }
      return panel;
    }
  },
});