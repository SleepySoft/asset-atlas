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
      ]);
      allAssets = flattenAssets(catalog);
      renderFilters();
      applyFilters();
    } catch (err) {
      els.resultCount.textContent = '加载失败：' + err.message;
      console.error(err);
    }
  }

  function renderStats(stats) {
    els.stats.innerHTML = `
      <span>资产 ${stats.assets}</span>
      <span>Provider ${stats.providers}</span>
      <span>地区 ${stats.regions}</span>
    `;
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

  // Init
  loadData();
})();
