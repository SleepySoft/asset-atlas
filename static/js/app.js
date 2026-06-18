/**
 * Market Catalog Engine - frontend.
 *
 * Responsibilities:
 * - Fetch catalog data from backend API.
 * - Render responsive dashboard with search, filters, cards, detail panel.
 * - Preview TradingView embed widgets.
 */

(function () {
  'use strict';

  // State
  let catalog = null;
  let allAssets = [];
  let filteredAssets = [];
  let selectedAssetId = null;
  let meta = null;
  let editingAsset = null;
  let deletingAsset = null;

  const filters = {
    regions: new Set(),
    groups: new Set(),
    providers: new Set(),
  };

  // DOM refs
  const els = {
    menuToggle: document.getElementById('menuToggle'),
    sidebar: document.getElementById('sidebar'),
    overlay: document.getElementById('overlay'),
    searchInput: document.getElementById('searchInput'),
    regionFilters: document.getElementById('regionFilters'),
    groupFilters: document.getElementById('groupFilters'),
    providerFilters: document.getElementById('providerFilters'),
    assetGrid: document.getElementById('assetGrid'),
    resultCount: document.getElementById('resultCount'),
    detailPanel: document.getElementById('detailPanel'),
    detailContent: document.getElementById('detailContent'),
    closeDetail: document.getElementById('closeDetail'),
    reloadBtn: document.getElementById('reloadBtn'),
    exportBtn: document.getElementById('exportBtn'),
    stats: document.getElementById('stats'),
    addAssetBtn: document.getElementById('addAssetBtn'),
    addAssetModal: document.getElementById('addAssetModal'),
    addAssetModalOverlay: document.getElementById('addAssetModalOverlay'),
    addAssetModalClose: document.getElementById('addAssetModalClose'),
    addAssetForm: document.getElementById('addAssetForm'),
    addRegion: document.getElementById('addRegion'),
    addGroup: document.getElementById('addGroup'),
    addId: document.getElementById('addId'),
    addNameZh: document.getElementById('addNameZh'),
    addNameEn: document.getElementById('addNameEn'),
    addMarket: document.getElementById('addMarket'),
    addCurrency: document.getElementById('addCurrency'),
    addExchange: document.getElementById('addExchange'),
    addCode: document.getElementById('addCode'),
    derivedSymbolsList: document.getElementById('derivedSymbolsList'),
    addOverrideRow: document.getElementById('addOverrideRow'),
    overrideRows: document.getElementById('overrideRows'),
    addTags: document.getElementById('addTags'),
    addNote: document.getElementById('addNote'),
    addAssetErrors: document.getElementById('addAssetErrors'),
    addAssetCancel: document.getElementById('addAssetCancel'),
    addAssetSubmit: document.getElementById('addAssetSubmit'),
    addOldId: document.getElementById('addOldId'),
    addModalTitle: document.querySelector('#addAssetModal .modal-header h2'),
    deleteModal: document.getElementById('deleteModal'),
    deleteModalOverlay: document.getElementById('deleteModalOverlay'),
    deleteModalClose: document.getElementById('deleteModalClose'),
    deleteCancel: document.getElementById('deleteCancel'),
    deleteConfirm: document.getElementById('deleteConfirm'),
    deleteAssetName: document.getElementById('deleteAssetName'),
    toast: document.getElementById('toast'),
  };

  // Helpers
  function fetchJSON(url, options) {
    return fetch(url, options).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json();
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function nameOf(asset) {
    const n = asset.name || {};
    return n.zh || n.en || asset.id;
  }

  function englishNameOf(asset) {
    const n = asset.name || {};
    return n.en || n.zh || asset.id;
  }

  function primarySymbol(asset) {
    const syms = asset.symbols || {};
    return syms.tradingview || syms.yahoo || syms.google || Object.values(syms)[0] || '-';
  }

  function assetProviders(asset) {
    const providers = new Set();
    const links = asset.links || {};
    ['jump', 'embed', 'crawl'].forEach((kind) => {
      (links[kind] || []).forEach((item) => {
        if (item.provider) providers.add(item.provider);
      });
    });
    return Array.from(providers);
  }

  function flattenAssets(cat) {
    const out = [];
    (cat.regions || []).forEach((region) => {
      (region.market_groups || []).forEach((group) => {
        (group.assets || []).forEach((asset) => {
          out.push({
            ...asset,
            _region: region.region,
            _region_zh: region.region_zh || region.region,
            _group: group.market_group,
            _group_zh: group.label_zh || group.market_group,
          });
        });
      });
    });
    return out;
  }

  // Data loading
  async function loadData() {
    try {
      [catalog] = await Promise.all([
        fetchJSON('/api/catalog'),
        fetchJSON('/api/stats').then(renderStats),
        loadMeta(),
      ]);
      allAssets = flattenAssets(catalog);
      renderFilters();
      applyFilters();
    } catch (err) {
      els.resultCount.textContent = '加载失败：' + err.message;
      console.error(err);
    }
  }

  async function loadMeta() {
    if (meta) return meta;
    meta = await fetchJSON('/api/meta');
    return meta;
  }

  function renderStats(stats) {
    els.stats.innerHTML = `
      <span>资产 ${stats.assets}</span>
      <span>Provider ${stats.providers}</span>
      <span>地区 ${stats.regions}</span>
    `;
  }

  // Add/Edit asset modal
  function openAddAssetModal(asset) {
    editingAsset = asset || null;
    resetAddAssetForm(asset);
    els.addAssetModal.setAttribute('aria-hidden', 'false');
    els.addAssetModal.classList.add('open');
    if (asset) {
      els.addNameZh.focus();
    } else {
      els.addExchange.focus();
    }
  }

  function closeAddAssetModal() {
    els.addAssetModal.setAttribute('aria-hidden', 'true');
    els.addAssetModal.classList.remove('open');
    els.addAssetErrors.innerHTML = '';
    editingAsset = null;
  }

  function resetAddAssetForm(asset) {
    els.addAssetForm.reset();
    renderAddAssetOptions();
    lastDerivedResult = { symbols: {}, variants: {} };
    renderDerivedSymbols();
    renderOverrideRows([]);
    els.addAssetErrors.innerHTML = '';
    els.addAssetSubmit.disabled = false;
    els.addAssetSubmit.textContent = '保存';

    if (asset) {
      // Edit mode
      els.addModalTitle.textContent = '编辑标的';
      els.addOldId.value = asset.id;
      els.addRegion.value = asset._region_code || inferRegionCode(asset._region);
      els.addGroup.value = asset._group;
      const { exchange, code } = inferExchangeCode(asset);
      els.addExchange.value = exchange;
      els.addCode.value = code;
      els.addId.value = asset.id;
      els.addId.dataset.auto = 'false';
      els.addMarket.value = asset.market || '';
      els.addMarket.dataset.auto = 'false';
      els.addCurrency.value = asset.currency || '';
      els.addNameZh.value = (asset.name && asset.name.zh) || '';
      els.addNameEn.value = (asset.name && asset.name.en) || '';
      els.addTags.value = (asset.tags || []).join(', ');
      els.addNote.value = asset.note || '';

      updateAutoDerivedFields(false).then(() => {
        const expected = lastDerivedResult.symbols || {};
        const allSymbols = asset.symbols || {};
        const derivedSymbols = {};
        const overrideSymbols = [];
        Object.entries(allSymbols).forEach(([key, value]) => {
          if (expected[key] === value) {
            derivedSymbols[key] = value;
          } else {
            overrideSymbols.push({ key, value });
          }
        });
        lastDerivedResult.symbols = derivedSymbols;
        renderDerivedSymbols();
        renderOverrideRows(overrideSymbols.length ? overrideSymbols : []);
      });
    } else {
      // Add mode
      els.addModalTitle.textContent = '添加标的';
      els.addOldId.value = '';
      els.addExchange.value = '';
      els.addCode.value = '';
      els.addId.value = '';
      els.addId.dataset.auto = 'true';
      els.addMarket.value = '';
      els.addMarket.dataset.auto = 'true';
      updateCurrencyFromRegion();
    }
  }

  function inferRegionCode(regionName) {
    if (!meta) return '';
    for (const [code, info] of Object.entries(meta.regions || {})) {
      if (info.name === regionName || info.name_zh === regionName) return code;
    }
    return '';
  }

  function inferExchangeCode(asset) {
    const syms = asset.symbols || {};
    const tv = syms.tradingview || '';
    if (tv && tv.includes(':')) {
      const [exchange, code] = tv.split(':');
      return { exchange, code };
    }
    const yahoo = syms.yahoo || '';
    if (yahoo.endsWith('.SS')) return { exchange: 'SSE', code: yahoo.slice(0, -3) };
    if (yahoo.endsWith('.SZ')) return { exchange: 'SZSE', code: yahoo.slice(0, -3) };
    if (yahoo.endsWith('.HK')) return { exchange: 'HKEX', code: yahoo.slice(0, -3) };
    return { exchange: '', code: '' };
  }

  function renderAddAssetOptions() {
    if (!meta) return;

    const regionSelect = els.addRegion;
    const groupSelect = els.addGroup;

    regionSelect.innerHTML = Object.entries(meta.regions || {})
      .map(([code, info]) => `<option value="${escapeHtml(code)}">${escapeHtml(info.name_zh || code)} (${escapeHtml(info.currency_default || '')})</option>`)
      .join('');

    groupSelect.innerHTML = Object.entries(meta.groups || {})
      .map(([code, info]) => `<option value="${escapeHtml(code)}">${escapeHtml(info.label_zh || code)}</option>`)
      .join('');
  }

  function updateCurrencyFromRegion() {
    if (!meta) return;
    const regionCode = els.addRegion.value;
    const regionInfo = (meta.regions || {})[regionCode];
    if (regionInfo && regionInfo.currency_default) {
      els.addCurrency.value = regionInfo.currency_default;
    }
  }

  const EXCHANGE_MARKET_MAP = {
    SSE: 'Shanghai Stock Exchange',
    SZSE: 'Shenzhen Stock Exchange',
    HKEX: 'Hong Kong Stock Exchange',
    NASDAQ: 'NASDAQ',
    NYSE: 'New York Stock Exchange',
    AMEX: 'NYSE American',
    TSE: 'Tokyo Stock Exchange',
    TWSE: 'Taiwan Stock Exchange',
    LSE: 'London Stock Exchange',
  };

  function exchangeToMarket(exchange) {
    return EXCHANGE_MARKET_MAP[exchange] || exchange;
  }

  function generateSuggestedId() {
    const region = els.addRegion.value.trim();
    const group = els.addGroup.value.trim();
    const code = els.addCode.value.trim();
    if (!region || !group || !code) return '';
    const normalizedCode = code.replace(/[^a-zA-Z0-9]+/g, '_');
    return `${region}_${group}_${normalizedCode}`;
  }

  function updateAutoDerivedFields(runDerive = true) {
    const exchange = els.addExchange.value.trim();
    const code = els.addCode.value.trim();

    // 只有当 ID/市场还是空或看起来是自动生成的，才更新；用户手动改过则不覆盖
    const suggestedId = generateSuggestedId();
    if (suggestedId && (!els.addId.value.trim() || els.addId.dataset.auto === 'true')) {
      els.addId.value = suggestedId;
      els.addId.dataset.auto = 'true';
    }

    if (exchange && (!els.addMarket.value.trim() || els.addMarket.dataset.auto === 'true')) {
      els.addMarket.value = exchangeToMarket(exchange);
      els.addMarket.dataset.auto = 'true';
    }

    if (runDerive) {
      return deriveSymbols();
    }
    return Promise.resolve();
  }

  let lastDerivedResult = { symbols: {}, variants: {} };

  async function deriveSymbols() {
    const exchange = els.addExchange.value.trim();
    const code = els.addCode.value.trim();
    const region = els.addRegion.value.trim();
    const group = els.addGroup.value.trim();

    if (!exchange || !code || !region || !group) {
      lastDerivedResult = { symbols: {}, variants: {} };
      renderDerivedSymbols();
      return;
    }

    try {
      const result = await fetchJSON(`/api/derive-symbols?exchange=${encodeURIComponent(exchange)}&code=${encodeURIComponent(code)}&region=${encodeURIComponent(region)}&group=${encodeURIComponent(group)}`);
      lastDerivedResult = {
        symbols: result.symbols || {},
        variants: result.variants || {},
      };
      renderDerivedSymbols();
    } catch (err) {
      console.error('derive symbols failed', err);
      lastDerivedResult = { symbols: {}, variants: {} };
      renderDerivedSymbols();
    }
  }

  function renderDerivedSymbols() {
    const symbols = lastDerivedResult.symbols || {};
    const variants = lastDerivedResult.variants || {};
    const symbolKeys = Object.keys(symbols);
    const variantKeys = Object.keys(variants);

    if (symbolKeys.length === 0) {
      els.derivedSymbolsList.innerHTML = '<p class="empty-tip">选择交易所并输入代码后自动推导</p>';
      return;
    }

    const symbolHtml = symbolKeys
      .map((key) => `
        <div class="derived-symbol-item derived-symbol-main">
          <span class="derived-symbol-key">${escapeHtml(key)}</span>
          <span class="derived-symbol-value">${escapeHtml(symbols[key])}</span>
        </div>
      `)
      .join('');

    const variantHtml = variantKeys.length
      ? `
        <div class="derived-variants">
          <div class="derived-variants-title">模板变体（自动用于各 provider）</div>
          <div class="derived-variants-list">
            ${variantKeys
              .map(
                (key) => `
              <div class="derived-variant-item">
                <span class="derived-variant-name">${escapeHtml(key)}</span>
                <span class="derived-variant-value">${escapeHtml(variants[key])}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `
      : '';

    els.derivedSymbolsList.innerHTML = symbolHtml + variantHtml;
  }

  function getOverrideKeyOptions(selectedKey) {
    if (!meta) return '';
    const knownKeys = new Set();
    Object.values(meta.providers || {}).forEach((cfg) => {
      if (cfg.symbol_key) knownKeys.add(cfg.symbol_key);
    });
    // 排除已由自动推导覆盖的 key
    const derived = lastDerivedResult.symbols || {};
    const keys = Array.from(knownKeys).filter((k) => !(k in derived)).sort();
    return keys
      .map((k) => `<option value="${escapeHtml(k)}" ${k === selectedKey ? 'selected' : ''}>${escapeHtml(k)}</option>`)
      .join('');
  }

  function getDerivedSymbolsFromDOM() {
    return { ...lastDerivedResult.symbols };
  }

  function renderOverrideRows(rows) {
    els.overrideRows.innerHTML = (rows || [])
      .map(
        (row, idx) => `
        <div class="symbol-row" data-idx="${idx}">
          <select class="symbol-key" name="override_key_${idx}" required>${getOverrideKeyOptions(row.key)}</select>
          <input type="text" class="symbol-value" name="override_value_${idx}" value="${escapeHtml(row.value || '')}" placeholder="代码" required>
          <button type="button" class="btn btn-small symbol-remove" data-idx="${idx}">删除</button>
        </div>
      `
      )
      .join('');

    els.overrideRows.querySelectorAll('.symbol-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeOverrideRow(Number(btn.dataset.idx)));
    });
  }

  function addOverrideRow() {
    const rows = readOverrideRows();
    rows.push({ key: '', value: '' });
    renderOverrideRows(rows);
  }

  function removeOverrideRow(idx) {
    const rows = readOverrideRows();
    rows.splice(idx, 1);
    if (rows.length === 0) rows.push({ key: '', value: '' });
    renderOverrideRows(rows);
  }

  function readOverrideRows() {
    const rows = [];
    els.overrideRows.querySelectorAll('.symbol-row').forEach((row) => {
      const key = row.querySelector('.symbol-key').value.trim();
      const value = row.querySelector('.symbol-value').value.trim();
      if (key) rows.push({ key, value });
    });
    return rows;
  }

  function gatherFormData() {
    const symbols = { ...getDerivedSymbolsFromDOM() };
    readOverrideRows().forEach(({ key, value }) => {
      if (key && value) symbols[key] = value;
    });

    const tagsStr = els.addTags.value.trim();
    const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()).filter(Boolean) : [];

    const payload = {
      region: els.addRegion.value.trim(),
      group: els.addGroup.value.trim(),
      id: els.addId.value.trim(),
      name: {
        zh: els.addNameZh.value.trim(),
        en: els.addNameEn.value.trim(),
      },
      market: els.addMarket.value.trim(),
      currency: els.addCurrency.value.trim(),
      symbols,
      tags,
      note: els.addNote.value.trim(),
    };

    // 编辑时保留显式 links（如 investing.com 等无法模板生成的链接）
    if (editingAsset && editingAsset.links) {
      payload.links = editingAsset.links;
    }

    return payload;
  }

  function showFormErrors(errors) {
    if (!errors || errors.length === 0) {
      els.addAssetErrors.innerHTML = '';
      return;
    }
    els.addAssetErrors.innerHTML = errors
      .map((e) => `<div class="form-error">${escapeHtml(String(e))}</div>`)
      .join('');
  }

  function showToast(message, type = 'success') {
    els.toast.textContent = message;
    els.toast.className = `toast toast-${type} show`;
    setTimeout(() => {
      els.toast.classList.remove('show');
    }, 2500);
  }

  // Delete modal
  function openDeleteModal(asset) {
    deletingAsset = asset;
    els.deleteAssetName.textContent = nameOf(asset);
    els.deleteModal.setAttribute('aria-hidden', 'false');
    els.deleteModal.classList.add('open');
  }

  function closeDeleteModal() {
    els.deleteModal.setAttribute('aria-hidden', 'true');
    els.deleteModal.classList.remove('open');
    deletingAsset = null;
  }

  async function confirmDelete() {
    if (!deletingAsset) return;
    els.deleteConfirm.disabled = true;
    els.deleteConfirm.textContent = '删除中...';

    try {
      const result = await fetchJSON(`/api/assets/${encodeURIComponent(deletingAsset.id)}`, {
        method: 'DELETE',
      });

      if (!result.ok) {
        alert('删除失败：' + (result.errors || []).join('; '));
        return;
      }

      closeDeleteModal();
      closeDetailPanel();
      showToast(`已删除：${nameOf(deletingAsset)}`);
      await loadData();
    } catch (err) {
      alert('删除失败：' + err.message);
    } finally {
      els.deleteConfirm.disabled = false;
      els.deleteConfirm.textContent = '删除';
    }
  }

  async function submitAddAsset(e) {
    e.preventDefault();
    const payload = gatherFormData();
    showFormErrors([]);
    els.addAssetSubmit.disabled = true;
    els.addAssetSubmit.textContent = '保存中...';

    const isEdit = Boolean(els.addOldId.value);
    const url = isEdit ? `/api/assets/${encodeURIComponent(els.addOldId.value)}` : '/api/assets';
    const method = isEdit ? 'PUT' : 'POST';

    try {
      const result = await fetchJSON(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!result.ok) {
        showFormErrors(result.errors || ['保存失败']);
        return;
      }

      closeAddAssetModal();
      showToast(isEdit ? `已更新：${payload.name.zh || payload.id}` : `已添加：${payload.name.zh || payload.id}`);
      await loadData();
      const updatedAsset = allAssets.find((a) => a.id === payload.id);
      if (updatedAsset) selectAsset(updatedAsset);
    } catch (err) {
      showFormErrors([err.message]);
    } finally {
      els.addAssetSubmit.disabled = false;
      els.addAssetSubmit.textContent = '保存';
    }
  }

  // Filters
  function renderFilters() {
    const regions = new Map();
    const groups = new Map();
    const providers = new Map();

    allAssets.forEach((a) => {
      regions.set(a._region, {
        count: (regions.get(a._region)?.count || 0) + 1,
        label: a._region_zh || a._region,
      });
      groups.set(a._group, {
        count: (groups.get(a._group)?.count || 0) + 1,
        label: a._group_zh || a._group,
      });
      assetProviders(a).forEach((p) => {
        providers.set(p, (providers.get(p) || 0) + 1);
      });
    });

    els.regionFilters.innerHTML = renderFilterList(regions, 'regions', filters.regions);
    els.groupFilters.innerHTML = renderFilterList(groups, 'groups', filters.groups);
    els.providerFilters.innerHTML = renderFilterList(providers, 'providers', filters.providers);

    document.querySelectorAll('.filter-item input').forEach((input) => {
      input.addEventListener('change', onFilterChange);
    });
  }

  function renderFilterList(map, type, selectedSet) {
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, info]) => {
        const checked = selectedSet.has(name) ? 'checked' : '';
        const label = typeof info === 'object' ? info.label : name;
        const count = typeof info === 'object' ? info.count : info;
        return `
          <label class="filter-item ${checked ? 'active' : ''}">
            <input type="checkbox" data-type="${type}" value="${escapeHtml(name)}" ${checked}>
            <span>${escapeHtml(label)}</span>
            <span class="filter-count">${count}</span>
          </label>
        `;
      })
      .join('');
  }

  function onFilterChange(e) {
    const input = e.target;
    const type = input.dataset.type;
    const value = input.value;
    const set = filters[type];
    if (input.checked) set.add(value);
    else set.delete(value);

    input.closest('.filter-item').classList.toggle('active', input.checked);
    applyFilters();
  }

  // Search & filter logic
  function applyFilters() {
    const q = els.searchInput.value.trim().toLowerCase();

    filteredAssets = allAssets.filter((a) => {
      // Region filter
      if (filters.regions.size > 0 && !filters.regions.has(a._region)) return false;
      // Group filter
      if (filters.groups.size > 0 && !filters.groups.has(a._group)) return false;
      // Provider filter
      if (filters.providers.size > 0) {
        const providers = assetProviders(a);
        const hasProvider = Array.from(filters.providers).some((p) => providers.includes(p));
        if (!hasProvider) return false;
      }
      // Text search
      if (q) {
        const haystack = [
          nameOf(a),
          englishNameOf(a),
          a.id,
          a.note || '',
          a.market || '',
          (a.tags || []).join(' '),
          Object.values(a.symbols || {}).join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    els.resultCount.textContent = `共 ${filteredAssets.length} 个资产`;
    renderGrid(filteredAssets);
  }

  // Grid rendering
  const GROUP_ORDER = {
    index: 1,
    stock: 2,
    commodity: 3,
    fx: 4,
    crypto: 5,
  };

  function renderCard(a) {
    const isSelected = a.id === selectedAssetId;
    const tags = (a.tags || [])
      .slice(0, 4)
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join('');
    return `
      <article class="asset-card ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(a.id)}">
        <div class="asset-header">
          <h3 class="asset-name">${escapeHtml(nameOf(a))}</h3>
          <span class="asset-class">${escapeHtml(a._group_zh || a.asset_class || a._group)}</span>
        </div>
        <div class="asset-symbol">${escapeHtml(primarySymbol(a))}</div>
        <div class="asset-meta">
          <span>${escapeHtml(a._region_zh || a._region)}</span>
          <span>·</span>
          <span>${escapeHtml(a.currency || '')}</span>
        </div>
        <div class="asset-tags">${tags}</div>
      </article>
    `;
  }

  function renderGrid(assets) {
    if (assets.length === 0) {
      els.assetGrid.innerHTML = '<p class="empty-tip">没有匹配的资产</p>';
      return;
    }

    // 按分类分组
    const groups = {};
    assets.forEach((a) => {
      const key = a._group;
      if (!groups[key]) {
        groups[key] = {
          label: a._group_zh || a._group,
          order: GROUP_ORDER[key] || 99,
          assets: [],
        };
      }
      groups[key].assets.push(a);
    });

    const sortedKeys = Object.keys(groups).sort((a, b) => groups[a].order - groups[b].order);

    els.assetGrid.innerHTML = sortedKeys
      .map((key) => {
        const group = groups[key];
        const cards = group.assets.map(renderCard).join('');
        return `
          <section class="asset-group">
            <h2 class="asset-group-title">
              ${escapeHtml(group.label)}
              <span class="asset-group-count">${group.assets.length}</span>
            </h2>
            <div class="asset-group-grid">${cards}</div>
          </section>
        `;
      })
      .join('');

    document.querySelectorAll('.asset-card').forEach((card) => {
      card.addEventListener('click', () => {
        const asset = allAssets.find((a) => a.id === card.dataset.id);
        if (asset) selectAsset(asset);
      });
    });
  }

  // Detail panel
  function selectAsset(asset) {
    selectedAssetId = asset.id;
    renderGrid(filteredAssets); // update selection highlight
    renderDetail(asset);
    openDetail();
  }

  function renderDetail(asset) {
    const links = asset.links || {};
    const jumpLinks = links.jump || [];
    const crawlLinks = links.crawl || [];
    const embeds = links.embed || [];

    const jumpHtml =
      jumpLinks.length === 0
        ? '<p class="empty-tip">无跳转链接</p>'
        : `<div class="link-list">${jumpLinks
            .map(
              (l) => `
            <div class="link-item">
              <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(
                l.url
              )}</a>
              <span class="link-kind">${escapeHtml(l.provider)} · ${escapeHtml(l.kind)}</span>
            </div>
          `
            )
            .join('')}</div>`;

    const crawlHtml =
      crawlLinks.length === 0
        ? '<p class="empty-tip">无可抓取链接</p>'
        : `<div class="link-list">${crawlLinks
            .map(
              (l) => `
            <div class="link-item">
              <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(
                l.url
              )}</a>
              <span class="link-kind">${escapeHtml(l.provider)} · ${escapeHtml(l.kind || l.type)}</span>
            </div>
          `
            )
            .join('')}</div>`;

    let widgetHtml = '<p class="empty-tip">无嵌入预览</p>';
    if (embeds.length > 0) {
      const widgets = embeds[0].widgets || {};
      const widgetNames = Object.keys(widgets);
      if (widgetNames.length > 0) {
        const tabs = widgetNames
          .map(
            (name, idx) => `
            <button class="widget-tab ${idx === 0 ? 'active' : ''}" data-widget="${escapeHtml(name)}">
              ${escapeHtml(name)}
            </button>
          `
          )
          .join('');
        widgetHtml = `
          <div class="widget-tabs">${tabs}</div>
          <div class="widget-preview" id="widgetPreview"></div>
        `;
      }
    }

    const tags = (asset.tags || [])
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join('');

    els.detailContent.innerHTML = `
      <div class="detail-actions">
        <button class="btn btn-small" id="editAssetBtn">编辑</button>
        <button class="btn btn-small btn-danger" id="deleteAssetBtn">删除</button>
      </div>
      <h2 class="detail-title">${escapeHtml(nameOf(asset))}</h2>
      <div class="detail-subtitle">
        ${escapeHtml(englishNameOf(asset))} · ${escapeHtml(asset.id)} · ${escapeHtml(
      asset._region_zh || asset._region
    )} · ${escapeHtml(asset._group_zh || asset._group)}
      </div>
      <div class="detail-section">
        <h3>信息</h3>
        <div class="link-list">
          <div class="link-item"><span>地区</span><span class="link-kind">${escapeHtml(
            asset._region_zh || asset._region || '-'
          )}</span></div>
          <div class="link-item"><span>分类</span><span class="link-kind">${escapeHtml(
            asset._group_zh || asset.asset_class || asset._group || '-'
          )}</span></div>
          <div class="link-item"><span>市场</span><span class="link-kind">${escapeHtml(
            asset.market || '-'
          )}</span></div>
          <div class="link-item"><span>货币</span><span class="link-kind">${escapeHtml(
            asset.currency || '-'
          )}</span></div>
          <div class="link-item"><span>代码</span><span class="link-kind">${escapeHtml(
            primarySymbol(asset)
          )}</span></div>
        </div>
        ${tags ? `<div class="asset-tags" style="margin-top:10px">${tags}</div>` : ''}
        ${asset.note ? `<p style="color:var(--muted);font-size:13px;margin-top:10px">${escapeHtml(asset.note)}</p>` : ''}
      </div>
      <div class="detail-section">
        <h3>跳转链接</h3>
        ${jumpHtml}
      </div>
      <div class="detail-section">
        <h3>可抓取链接</h3>
        ${crawlHtml}
      </div>
      <div class="detail-section">
        <h3>Widget 预览</h3>
        ${widgetHtml}
      </div>
    `;

    // Render first widget preview if available
    if (embeds.length > 0) {
      const widgets = embeds[0].widgets || {};
      const firstName = Object.keys(widgets)[0];
      if (firstName) renderWidgetPreview(firstName, widgets[firstName]);

      document.querySelectorAll('.widget-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.widget-tab').forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          renderWidgetPreview(tab.dataset.widget, widgets[tab.dataset.widget]);
        });
      });
    }

    // Wire edit/delete buttons
    const editBtn = document.getElementById('editAssetBtn');
    const deleteBtn = document.getElementById('deleteAssetBtn');
    if (editBtn) editBtn.addEventListener('click', () => openAddAssetModal(asset));
    if (deleteBtn) deleteBtn.addEventListener('click', () => openDeleteModal(asset));
  }

  function renderWidgetPreview(name, widget) {
    const container = document.getElementById('widgetPreview');
    if (!container) return;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'tradingview-widget-container';
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';

    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'tradingview-widget-container__widget';
    wrapper.appendChild(widgetDiv);

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = widget.script;
    script.async = true;
    script.textContent = JSON.stringify(widget.config);
    wrapper.appendChild(script);

    container.appendChild(wrapper);
  }

  // Mobile UI toggles
  function isMobile() {
    return window.innerWidth <= 900;
  }

  function openSidebar() {
    els.sidebar.classList.add('open');
    if (isMobile()) els.overlay.classList.add('show');
  }

  function closeSidebar() {
    els.sidebar.classList.remove('open');
    if (isMobile() && !els.detailPanel.classList.contains('open')) {
      els.overlay.classList.remove('show');
    }
  }

  function openDetail() {
    els.detailPanel.classList.add('open');
    if (isMobile()) els.overlay.classList.add('show');
  }

  function closeDetailPanel() {
    els.detailPanel.classList.remove('open');
    selectedAssetId = null;
    renderGrid(filteredAssets);
    if (isMobile()) els.overlay.classList.remove('show');
  }

  // Event listeners
  els.menuToggle.addEventListener('click', () => {
    if (els.sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });

  els.closeDetail.addEventListener('click', closeDetailPanel);

  els.overlay.addEventListener('click', () => {
    closeSidebar();
    closeDetailPanel();
  });

  els.searchInput.addEventListener('input', applyFilters);

  els.reloadBtn.addEventListener('click', async () => {
    els.reloadBtn.textContent = '刷新中...';
    try {
      await fetchJSON('/api/reload');
      await loadData();
    } catch (err) {
      alert('刷新失败：' + err.message);
    } finally {
      els.reloadBtn.textContent = '刷新';
    }
  });

  els.exportBtn.addEventListener('click', () => {
    window.open('/api/export', '_blank');
  });

  els.addAssetBtn.addEventListener('click', openAddAssetModal);
  els.addAssetModalClose.addEventListener('click', closeAddAssetModal);
  els.addAssetModalOverlay.addEventListener('click', closeAddAssetModal);
  els.addAssetCancel.addEventListener('click', closeAddAssetModal);
  els.addOverrideRow.addEventListener('click', addOverrideRow);
  els.addRegion.addEventListener('change', () => {
    updateCurrencyFromRegion();
    updateAutoDerivedFields();
  });
  els.addGroup.addEventListener('change', updateAutoDerivedFields);
  els.addExchange.addEventListener('change', updateAutoDerivedFields);
  els.addCode.addEventListener('input', debounce(updateAutoDerivedFields, 300));
  els.addId.addEventListener('input', () => {
    els.addId.dataset.auto = 'false';
  });
  els.addMarket.addEventListener('input', () => {
    els.addMarket.dataset.auto = 'false';
  });
  els.addAssetForm.addEventListener('submit', submitAddAsset);

  els.deleteModalClose.addEventListener('click', closeDeleteModal);
  els.deleteModalOverlay.addEventListener('click', closeDeleteModal);
  els.deleteCancel.addEventListener('click', closeDeleteModal);
  els.deleteConfirm.addEventListener('click', confirmDelete);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.addAssetModal.classList.contains('open')) closeAddAssetModal();
      if (els.deleteModal.classList.contains('open')) closeDeleteModal();
    }
  });

  // Init
  loadData();
})();
