import { redrawDrawings } from './drawings.js';
import { state } from './state.js';
import { getCurrentDrawings, saveStorage } from './storage.js';
import { $, escHtml, showToast } from './util.js';

// ============================================================
// Drawing templates UI
// ============================================================
function getTemplateContextType() {
  // Priority: active tool > selected drawing's type
  if (state.tool && state.drawTemplates && state.drawTemplates[state.tool]) return state.tool;
  if (state.selectedDrawingId) {
    const d = getCurrentDrawings().find((x) => x.id === state.selectedDrawingId);
    if (d && state.drawTemplates && state.drawTemplates[d.type]) return d.type;
  }
  return null;
}

function refreshTemplatesPanel() {
  const panel = $('templates-panel');
  if (!panel || !panel.classList.contains('show')) return;
  const ctxType = getTemplateContextType();
  const title = $('tpl-title');
  const hint = $('tpl-context-hint');
  const list = $('tpl-list');
  const TYPE_LABEL = {
    trend: '趨勢線',
    hline: '水平線',
    rect: '矩形',
    fib: '斐波那契',
    ray: '射線',
    extline: '延伸線',
    vline: '垂直線',
    channel: '平行通道',
    ellipse: '橢圓',
    arrow: '箭頭',
    text: '文字',
    pricelabel: '價格標籤',
    measure: '測量',
  };
  if (!ctxType) {
    title.textContent = '模板';
    hint.style.display = 'block';
    list.innerHTML = '';
    return;
  }
  hint.style.display = 'none';
  const sel = state.selectedDrawingId
    ? getCurrentDrawings().find((x) => x.id === state.selectedDrawingId)
    : null;
  if (sel && sel.type === ctxType) {
    title.innerHTML = `${TYPE_LABEL[ctxType]} 模板 <span style="color:var(--text-3);font-weight:400;">— 已選取一筆</span>`;
  } else {
    title.textContent = `${TYPE_LABEL[ctxType]} 模板`;
  }
  const tpls = state.drawTemplates[ctxType] || [];
  const activeId = sel ? null : state.activeTplId[ctxType];
  list.innerHTML = tpls
    .map(
      (t) => `
    <div class="tpl-row ${t.id === activeId ? 'active' : ''}" data-tpl-id="${t.id}">
<span class="swatch" style="background:${t.style.color};"></span>
<span class="preview-line">${tplPreviewSvg(t.style)}</span>
<span class="name">${escHtml(t.name)}</span>
${t.style.label ? `<span class="label-pill">${escHtml(t.style.label)}</span>` : ''}
<button class="del" data-del-tpl="${t.id}" title="刪除">✕</button>
    </div>
  `,
    )
    .join('');
  // Click row to apply
  list.querySelectorAll('.tpl-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-tpl]')) return;
      const tplId = row.dataset.tplId;
      applyTemplate(ctxType, tplId);
    });
  });
  list.querySelectorAll('[data-del-tpl]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.delTpl;
      deleteTemplate(ctxType, id);
    });
  });
  // Pre-fill editor with active or selected style
  fillTemplateEditor(sel ? sel.style : tpls.find((t) => t.id === activeId)?.style);
}

function tplPreviewSvg(style) {
  const dash = { 1: '2,2', 2: '4,2', 3: '6,3', 4: '1,3' }[style.lineStyle] || '';
  const sw = style.lineWidth || 1.5;
  return `<svg width="26" height="14" viewBox="0 0 26 14"><line x1="2" y1="7" x2="24" y2="7" stroke="${style.color}" stroke-width="${sw}" ${dash ? `stroke-dasharray="${dash}"` : ''}/></svg>`;
}

function fillTemplateEditor(style) {
  if (!style) {
    $('tpl-edit-name').value = '';
    return;
  }
  $('tpl-edit-color').value = style.color || '#3b82f6';
  $('tpl-edit-width').value = String(style.lineWidth ?? 2);
  $('tpl-edit-linestyle').value = String(style.lineStyle ?? 0);
  $('tpl-edit-label').value = style.label || '';
}
function getEditorStyle() {
  return {
    color: $('tpl-edit-color').value,
    lineWidth: +$('tpl-edit-width').value,
    lineStyle: +$('tpl-edit-linestyle').value,
    label: $('tpl-edit-label').value.trim(),
  };
}

function applyTemplate(toolType, tplId) {
  const tpl = state.drawTemplates[toolType].find((x) => x.id === tplId);
  if (!tpl) return;
  // Always set as active for new drawings
  state.activeTplId[toolType] = tplId;
  // If a drawing of this type is selected, also apply to it
  if (state.selectedDrawingId) {
    const d = getCurrentDrawings().find((x) => x.id === state.selectedDrawingId);
    if (d && d.type === toolType) {
      d.style = { ...tpl.style };
      d.color = tpl.style.color;
    }
  }
  saveStorage();
  redrawDrawings();
  refreshTemplatesPanel();
  showToast(`已套用「${tpl.name}」`, 'success');
}

function deleteTemplate(toolType, tplId) {
  const arr = state.drawTemplates[toolType];
  if (arr.length <= 1) {
    showToast('至少保留 1 個模板', 'error');
    return;
  }
  if (!confirm('刪除這個模板？')) return;
  state.drawTemplates[toolType] = arr.filter((x) => x.id !== tplId);
  if (state.activeTplId[toolType] === tplId) {
    state.activeTplId[toolType] = state.drawTemplates[toolType][0].id;
  }
  saveStorage();
  refreshTemplatesPanel();
  showToast('已刪除模板', 'success');
}

function saveStyleAsNewTemplate() {
  const ctxType = getTemplateContextType();
  if (!ctxType) {
    showToast('請先選一個工具或圖形', 'error');
    return;
  }
  const name = $('tpl-edit-name').value.trim();
  if (!name) {
    showToast('請輸入模板名稱', 'error');
    return;
  }
  const style = getEditorStyle();
  const tpl = {
    id: 'tpl-' + ctxType + '-' + Date.now().toString(36),
    name,
    style,
  };
  state.drawTemplates[ctxType].push(tpl);
  state.activeTplId[ctxType] = tpl.id;
  saveStorage();
  refreshTemplatesPanel();
  showToast(`已新增「${name}」`, 'success');
  $('tpl-edit-name').value = '';
}

function applyEditorStyleToSelectedOrActive() {
  const ctxType = getTemplateContextType();
  if (!ctxType) {
    showToast('請先選一個工具或圖形', 'error');
    return;
  }
  const style = getEditorStyle();
  // If a drawing is selected, apply to it
  if (state.selectedDrawingId) {
    const d = getCurrentDrawings().find((x) => x.id === state.selectedDrawingId);
    if (d && d.type === ctxType) {
      d.style = { ...style };
      d.color = style.color;
      saveStorage();
      redrawDrawings();
      showToast('已套用樣式', 'success');
      return;
    }
  }
  // Otherwise update active template's style
  const activeId = state.activeTplId[ctxType];
  const tpl = state.drawTemplates[ctxType].find((x) => x.id === activeId);
  if (tpl) {
    tpl.style = { ...style };
    saveStorage();
    refreshTemplatesPanel();
    showToast('已更新模板樣式', 'success');
  }
}

function wireTemplatesPanel() {
  const btn = $('btn-templates');
  const panel = $('templates-panel');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close indicators panel if open
    $('indicators-panel').classList.remove('show');
    panel.classList.toggle('show');
    refreshTemplatesPanel();
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      panel.classList.remove('show');
    }
  });
  $('btn-tpl-saveas').addEventListener('click', saveStyleAsNewTemplate);
  $('btn-tpl-save-current').addEventListener('click', applyEditorStyleToSelectedOrActive);
  // Live preview when editor changes
  ['tpl-edit-color', 'tpl-edit-width', 'tpl-edit-linestyle', 'tpl-edit-label'].forEach((id) => {
    $(id).addEventListener('input', () => {
      // If a drawing is selected, preview style live
      if (state.selectedDrawingId) {
        const d = getCurrentDrawings().find((x) => x.id === state.selectedDrawingId);
        const ctxType = getTemplateContextType();
        if (d && ctxType && d.type === ctxType) {
          d.style = getEditorStyle();
          d.color = d.style.color;
          redrawDrawings();
        }
      }
    });
  });
}

export { refreshTemplatesPanel, wireTemplatesPanel };
