(function () {
  'use strict';

  var API_BASE = window.AIX_CONFIG.apiBase;

  var METRIC_CONFIG = {
    aa_intelligence_index: { name: 'AA综合智能', icon: 'auto_awesome', group: 'aa', source: 'Artificial Analysis' },
    aa_coding_index: { name: 'AA代码能力', icon: 'code', group: 'aa', source: 'Artificial Analysis' },
    aa_math_index: { name: 'AA数学能力', icon: 'calculate', group: 'aa', source: 'Artificial Analysis' },
    lmarena_elo: { name: '综合对战', icon: 'emoji_events', group: 'lmarena', source: 'LMArena' },
    lmarena_coding: { name: '代码对战', icon: 'terminal', group: 'lmarena', source: 'LMArena' },
    lmarena_math: { name: '数学对战', icon: 'functions', group: 'lmarena', source: 'LMArena' },
    lmarena_hard: { name: '难题对战', icon: 'fitness_center', group: 'lmarena', source: 'LMArena' },
    tokens_per_second: { name: '输出速度', icon: 'speed', group: 'performance', source: 'Artificial Analysis' }
  };

  var METRIC_GROUPS = [
    { key: 'aa', name: 'Artificial Analysis', icon: 'analytics' },
    { key: 'lmarena', name: 'LMArena', icon: 'arena' },
    { key: 'performance', name: '性能指标', icon: 'bolt' }
  ];

  var currentMetric = 'aa_intelligence_index';
  var currentProviderType = 'all';
  var currentSource = '';
  var currentData = [];
  var filteredModels = [];
  var currentPage = 1;
  var totalPages = 1;
  var totalItems = 0;
  var PAGE_SIZE = 20;
  var sortColumn = '';
  var sortDirection = 'asc';
  var isLoading = false;

  var modelCardsEl, loadingEl, emptyEl, searchInput, clearBtn;
  var updateTimeEl, updateTextEl, sourceBadgeEl, sourceTextEl, boardListEl, tableHeaderEl;
  var paginationEl;

  function log(tag, message) {
    var timestamp = new Date().toISOString().substring(11, 23);
    console.log('[AIX][' + tag + '][' + timestamp + '] ' + message);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatScore(val) {
    if (val == null || val === '') return '-';
    var num = parseFloat(val);
    if (isNaN(num)) return escapeHtml(String(val));
    if (num > 100) return num.toFixed(1);
    return num.toFixed(2);
  }

  function getIconForRank(rank) {
    var r = parseInt(rank, 10);
    if (r === 1) return 'auto_awesome';
    if (r === 2) return 'psychology';
    if (r === 3) return 'smart_toy';
    return 'memory';
  }

  function formatContextLength(tokens) {
    if (tokens == null) return '-';
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(0) + 'M';
    if (tokens >= 1000) return (tokens / 1000).toFixed(0) + 'K';
    return tokens.toString();
  }

  function init() {
    log('INIT', 'Initializing application');

    modelCardsEl = document.getElementById('modelCards');
    loadingEl = document.getElementById('loadingState');
    emptyEl = document.getElementById('emptyState');
    searchInput = document.getElementById('searchInput');
    clearBtn = document.getElementById('clearSearch');
    updateTimeEl = document.getElementById('updateTime');
    updateTextEl = document.getElementById('updateText');
    sourceBadgeEl = document.getElementById('sourceBadge');
    sourceTextEl = document.getElementById('sourceText');
    boardListEl = document.getElementById('boardList');
    tableHeaderEl = document.getElementById('tableHeader');
    paginationEl = document.getElementById('leaderboardPagination');

    bindSearch();
    bindProviderTypeFilter();
    handleHashChange();
    renderSidebar();

    var hash = window.location.hash.replace('#', '');
    var metric = (hash && METRIC_CONFIG[hash]) ? hash : 'aa_intelligence_index';
    switchMetric(metric, false);
  }

  function fetchLeaderboard() {
    if (isLoading) return;
    isLoading = true;
    log('FETCH', 'Fetching leaderboard: metric=' + currentMetric + ', page=' + currentPage + ', provider_type=' + currentProviderType);
    showLoading();

    var url = API_BASE + '/api/leaderboard?metric=' + encodeURIComponent(currentMetric) + '&page=' + currentPage + '&page_size=' + PAGE_SIZE;
    if (currentProviderType !== 'all') {
      url += '&provider_type=' + encodeURIComponent(currentProviderType);
    }

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json.code !== 200) throw new Error(json.message || 'Invalid response');

        currentSource = json.source || '';
        currentData = json.data || [];
        filteredModels = currentData.slice();
        totalItems = json.total || 0;
        totalPages = json.total_pages || Math.ceil(totalItems / PAGE_SIZE);
        currentPage = json.page || currentPage;
        sortColumn = '';
        sortDirection = 'asc';

        log('FETCH', 'Leaderboard loaded: ' + currentData.length + ' items, total=' + totalItems + ', pages=' + totalPages);

        renderTableHeader();
        sortAndRender();
        renderPagination();
        updateSidebar();
        updateSourceDisplay();
        updateTimeDisplay();

        hideLoading();
        isLoading = false;
      })
      .catch(function (err) {
        log('ERROR', 'fetchLeaderboard failed: ' + (err.message || err));
        showLoadError('数据加载失败，请稍后重试');
        isLoading = false;
      });
  }

  function renderSidebar() {
    var html = '';
    for (var g = 0; g < METRIC_GROUPS.length; g++) {
      var group = METRIC_GROUPS[g];
      html += '<li class="board-group">';
      html += '<button class="board-parent expanded" data-group="' + escapeHtml(group.key) + '">';
      html += '<span class="material-symbols-outlined icon">' + group.icon + '</span>';
      html += '<span class="label">' + escapeHtml(group.name) + '</span>';
      html += '<span class="material-symbols-outlined arrow">expand_less</span>';
      html += '</button>';
      html += '<div class="sub-board-list" style="display:flex;">';

      var keys = Object.keys(METRIC_CONFIG);
      for (var i = 0; i < keys.length; i++) {
        var metricKey = keys[i];
        var config = METRIC_CONFIG[metricKey];
        if (config.group !== group.key) continue;
        html += '<button class="sub-board-item" data-metric="' + escapeHtml(metricKey) + '">';
        html += '<span class="material-symbols-outlined icon">' + config.icon + '</span>';
        html += '<span class="label">' + escapeHtml(config.name) + '</span>';
        html += '</button>';
      }

      html += '</div></li>';
    }
    boardListEl.innerHTML = html;
    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    var parentBtns = boardListEl.querySelectorAll('.board-parent');
    for (var i = 0; i < parentBtns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          var groupKey = btn.getAttribute('data-group');
          var subList = btn.nextElementSibling;
          var arrow = btn.querySelector('.arrow');
          var isExpanded = subList && subList.style.display !== 'none';
          if (isExpanded) {
            btn.classList.remove('expanded');
            if (subList) subList.style.display = 'none';
            if (arrow) arrow.textContent = 'expand_more';
          } else {
            btn.classList.add('expanded');
            if (subList) subList.style.display = 'flex';
            if (arrow) arrow.textContent = 'expand_less';
          }
        });
      })(parentBtns[i]);
    }

    var subBtns = boardListEl.querySelectorAll('.sub-board-item');
    for (var j = 0; j < subBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          switchMetric(btn.getAttribute('data-metric'), true);
        });
      })(subBtns[j]);
    }
  }

  function updateSidebar() {
    var subBtns = boardListEl.querySelectorAll('.sub-board-item');
    for (var j = 0; j < subBtns.length; j++) {
      subBtns[j].classList.toggle('active', subBtns[j].getAttribute('data-metric') === currentMetric);
    }

    var config = METRIC_CONFIG[currentMetric];
    if (config) {
      var parentBtn = boardListEl.querySelector('.board-parent[data-group="' + config.group + '"]');
      if (parentBtn) {
        parentBtn.classList.add('expanded');
        var subList = parentBtn.nextElementSibling;
        var arrow = parentBtn.querySelector('.arrow');
        if (subList) subList.style.display = 'flex';
        if (arrow) arrow.textContent = 'expand_less';
      }
    }
  }

  function switchMetric(metric, saveHash) {
    currentMetric = metric;
    currentPage = 1;
    if (saveHash) window.location.hash = metric;
    resetFiltersQuiet();
    fetchLeaderboard();
  }

  function resetFiltersQuiet() {
    isLoading = true;
    if (searchInput) { searchInput.value = ''; clearBtn.style.display = 'none'; }
    isLoading = false;
  }

  function bindProviderTypeFilter() {
    var btns = document.querySelectorAll('.provider-filter-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
        this.classList.add('active');
        currentProviderType = this.getAttribute('data-type');
        currentPage = 1;
        fetchLeaderboard();
      });
    }
  }

  function updateSourceDisplay() {
    var config = METRIC_CONFIG[currentMetric];
    if (config && sourceBadgeEl && sourceTextEl) {
      sourceTextEl.textContent = config.source;
      sourceBadgeEl.style.display = '';
    }
  }

  function updateTimeDisplay() {
    if (updateTimeEl) {
      updateTimeEl.style.display = '';
    }
  }

  function renderTableHeader() {
    var html = '';
    html += '<div class="header-cell cell-rank" data-sort="rank">排名</div>';
    html += '<div class="header-cell cell-name" data-sort="model_name">模型名称</div>';
    html += '<div class="header-cell cell-vendor" data-sort="provider">厂商</div>';
    html += '<div class="header-cell cell-score" data-sort="rank_score">评分</div>';
    html += '<div class="header-cell cell-dim" data-sort="context_length">上下文</div>';
    html += '<div class="header-cell cell-dim" data-sort="input_price">输入价格</div>';
    html += '<div class="header-cell cell-dim" data-sort="output_price">输出价格</div>';
    tableHeaderEl.innerHTML = html;
    tableHeaderEl.style.gridTemplateColumns = '50px 1fr 100px 80px 80px 90px 90px';
    bindHeaderSort();
  }

  function bindHeaderSort() {
    var cells = tableHeaderEl.querySelectorAll('.header-cell[data-sort]');
    for (var i = 0; i < cells.length; i++) {
      (function (cell) {
        cell.addEventListener('click', function () {
          var col = cell.getAttribute('data-sort');
          if (sortColumn === col) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
          } else {
            sortColumn = col;
            sortDirection = col === 'rank' ? 'asc' : 'desc';
          }
          sortAndRender();
        });
      })(cells[i]);
    }
  }

  function renderCards() {
    var html = '';
    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      var rank = m.rank || (i + 1);
      var rankClass = rank === 1 ? 'rank-1' : '';
      var scoreClass = rank <= 3 ? '' : 'rank-normal';
      var modelName = m.model_name || m.model_id || '-';
      var provider = m.provider || '-';
      var rankScore = m.rank_score != null ? formatScore(m.rank_score) : '-';
      var ctxLen = m.context_length ? formatContextLength(m.context_length) : '-';
      var pricing = m.pricing || {};
      var inputPrice = pricing.input_per_1m_tokens != null ? '$' + pricing.input_per_1m_tokens.toFixed(2) : '-';
      var outputPrice = pricing.output_per_1m_tokens != null ? '$' + pricing.output_per_1m_tokens.toFixed(2) : '-';

      html += '<div class="model-card ' + rankClass + '" style="animation-delay:' + (i * 0.03) + 's">';
      html += '<div class="card-grid" style="grid-template-columns:50px 1fr 100px 80px 80px 90px 90px">';
      html += '<div class="card-rank ' + scoreClass + '">#' + escapeHtml(rank) + '</div>';
      html += '<div class="card-name">';
      html += '<div class="card-icon"><span class="material-symbols-outlined">' + getIconForRank(rank) + '</span></div>';
      html += '<span class="card-name-text">' + escapeHtml(modelName) + '</span>';
      html += '</div>';
      html += '<div class="card-vendor">' + escapeHtml(provider) + '</div>';
      html += '<div class="card-score ' + scoreClass + '">' + rankScore + '</div>';
      html += '<div class="card-dim">' + escapeHtml(ctxLen) + '</div>';
      html += '<div class="card-dim">' + escapeHtml(inputPrice) + '</div>';
      html += '<div class="card-dim">' + escapeHtml(outputPrice) + '</div>';
      html += '</div></div>';
    }
    modelCardsEl.innerHTML = html;
  }

  function sortAndRender() {
    if (sortColumn) {
      filteredModels.sort(function (a, b) {
        var va, vb;
        if (sortColumn === 'rank') { va = a.rank; vb = b.rank; }
        else if (sortColumn === 'model_name') { va = a.model_name || ''; vb = b.model_name || ''; }
        else if (sortColumn === 'provider') { va = a.provider || ''; vb = b.provider || ''; }
        else if (sortColumn === 'rank_score') { va = a.rank_score; vb = b.rank_score; }
        else if (sortColumn === 'context_length') { va = a.context_length; vb = b.context_length; }
        else if (sortColumn === 'input_price') { va = (a.pricing || {}).input_per_1m_tokens; vb = (b.pricing || {}).input_per_1m_tokens; }
        else if (sortColumn === 'output_price') { va = (a.pricing || {}).output_per_1m_tokens; vb = (b.pricing || {}).output_per_1m_tokens; }

        var na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return sortDirection === 'asc' ? na - nb : nb - na;
        if (!isNaN(na)) return sortDirection === 'asc' ? -1 : 1;
        if (!isNaN(nb)) return sortDirection === 'asc' ? 1 : -1;
        var sa = String(va || '').toLowerCase(), sb = String(vb || '').toLowerCase();
        return sortDirection === 'asc' ? sa.localeCompare(sb, 'zh-CN') : -sa.localeCompare(sb, 'zh-CN');
      });
    }

    if (filteredModels.length === 0) {
      modelCardsEl.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.querySelector('p').textContent = currentData.length === 0 ? '该排行榜暂无数据，请稍后再试' : '未找到匹配的模型';
    } else {
      modelCardsEl.style.display = '';
      emptyEl.style.display = 'none';
      renderCards();
    }
  }

  function bindSearch() {
    var timeout;
    searchInput.addEventListener('input', function () {
      clearTimeout(timeout);
      var val = searchInput.value.trim();
      clearBtn.style.display = val ? '' : 'none';
      timeout = setTimeout(function () {
        if (!val) {
          filteredModels = currentData.slice();
        } else {
          var lower = val.toLowerCase();
          filteredModels = currentData.filter(function (m) {
            var nameVal = (m.model_name || m.model_id || '').toLowerCase();
            var orgVal = (m.provider || '').toLowerCase();
            return nameVal.indexOf(lower) !== -1 || orgVal.indexOf(lower) !== -1;
          });
        }
        sortAndRender();
      }, 200);
    });

    clearBtn.addEventListener('click', function () {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      filteredModels = currentData.slice();
      sortAndRender();
      searchInput.focus();
    });
  }

  function handleHashChange() {
    window.addEventListener('hashchange', function () {
      var hash = window.location.hash.replace('#', '');
      if (hash && METRIC_CONFIG[hash] && hash !== currentMetric) {
        switchMetric(hash, false);
      }
    });
  }

  function showLoading() {
    loadingEl.style.display = '';
    modelCardsEl.style.display = 'none';
    emptyEl.style.display = 'none';
    updateTimeEl.style.display = 'none';
  }

  function hideLoading() {
    loadingEl.style.display = 'none';
  }

  function showLoadError(msg) {
    loadingEl.style.display = 'none';
    modelCardsEl.style.display = 'none';
    emptyEl.style.display = '';
    emptyEl.querySelector('p').textContent = msg || '数据加载失败，请稍后重试';
  }

  function renderPagination() {
    if (!paginationEl) return;
    if (totalPages <= 1) {
      paginationEl.style.display = 'none';
      return;
    }

    paginationEl.style.display = '';

    var html = '';
    html += '<button class="page-btn page-prev" ' + (currentPage <= 1 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '">';
    html += '<span class="material-symbols-outlined">chevron_left</span>';
    html += '</button>';

    var pages = getPageNumbers(currentPage, totalPages);
    for (var i = 0; i < pages.length; i++) {
      if (pages[i] === '...') {
        html += '<span class="page-ellipsis">...</span>';
      } else {
        var activeClass = pages[i] === currentPage ? ' page-active' : '';
        html += '<button class="page-btn page-num' + activeClass + '" data-page="' + pages[i] + '">' + pages[i] + '</button>';
      }
    }

    html += '<button class="page-btn page-next" ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '">';
    html += '<span class="material-symbols-outlined">chevron_right</span>';
    html += '</button>';

    paginationEl.innerHTML = html;
    bindPagination();
  }

  function getPageNumbers(current, total) {
    if (total <= 7) {
      var arr = [];
      for (var i = 1; i <= total; i++) arr.push(i);
      return arr;
    }
    var pages = [];
    pages.push(1);
    if (current > 3) pages.push('...');
    var start = Math.max(2, current - 1);
    var end = Math.min(total - 1, current + 1);
    for (var j = start; j <= end; j++) pages.push(j);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  function bindPagination() {
    var btns = paginationEl.querySelectorAll('.page-btn[data-page]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        if (this.disabled) return;
        var page = parseInt(this.getAttribute('data-page'), 10);
        if (isNaN(page) || page < 1 || page > totalPages || page === currentPage) return;
        currentPage = page;
        fetchLeaderboard();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
