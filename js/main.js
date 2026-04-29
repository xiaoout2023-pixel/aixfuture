(function () {
  'use strict';

  var API_BASE = window.AIX_CONFIG.apiBase;

  var GROUP_CONFIG = {
    general: { name: '通用排行榜', icon: 'auto_awesome' },
    multimodal: { name: '多模态排行榜', icon: 'photo_library' }
  };

  var CATEGORY_SHORT_NAMES = {
    general_overall: '总排行榜',
    general_reasoning: '推理模型',
    general_base: '基础模型',
    general_reasoning_task: '推理任务',
    general_opensource: '开源排行榜',
    multimodal_edit: '图像编辑',
    multimodal_image: '文生图',
    multimodal_image_1: '图像质量',
    multimodal_image_2: '图文一致性',
    multimodal_image_3: '汉字生成',
    multimodal_image_4: '现实复现',
    multimodal_image_5: '创作与推理',
    multimodal_edit_1: '通用能力',
    multimodal_edit_2: '应用场景能力',
    multimodal_edit_3: '测评模型列表'
  };

  var MODEL_LIST_CATEGORIES = ['multimodal_edit_3'];

  var CATEGORY_DISPLAY_NAMES = {
    '总榜': '总榜'
  };

  var CATEGORY_ICONS = {
    general_overall: 'leaderboard',
    general_reasoning: 'psychology',
    general_base: 'foundation',
    general_reasoning_task: 'lightbulb',
    general_opensource: 'code',
    multimodal_edit: 'edit',
    multimodal_image: 'image',
    multimodal_image_1: 'image',
    multimodal_image_2: 'image',
    multimodal_image_3: 'image',
    multimodal_image_4: 'image',
    multimodal_image_5: 'image',
    multimodal_edit_1: 'edit',
    multimodal_edit_2: 'edit',
    multimodal_edit_3: 'list'
  };

  var RANK_HEADER_NAMES = ['排名', 'rank'];
  var NAME_HEADER_NAMES = ['模型名称', '模型', 'model_name', 'name'];
  var ORG_HEADER_NAMES = ['机构', 'organization', 'org'];
  var SCORE_HEADER_NAMES = ['总分', '分数', 'score', 'median', '平均分', '综合得分'];
  var SKIP_HEADER_NAMES = ['开/闭源', '属地', '使用方式', '使用\n方式', '是否推理', '发布日期',
    '参数量(B)', '激活参数量(B)', 'is_opensource', 'is_domestic',
    'usage_type', 'is_reasoning', 'release_date', 'ciLow', 'ciHigh', 'battles'];

  var categoriesData = { general: [], multimodal: [] };
  var currentCategory = 'general_overall';
  var currentData = [];
  var filteredModels = [];
  var currentGroup = 'general';
  var currentCategoryName = '';
  var currentSourceDate = '';
  var currentCrawlTime = '';

  var colMap = {};
  var displayCols = [];
  var sortColumn = '';
  var sortDirection = 'asc';
  var expandedGroups = new Set(['general']);
  var isLoading = false;
  var currentPage = 1;
  var totalPages = 1;
  var totalItems = 0;
  var PAGE_SIZE = 10;

  var modelCardsEl, loadingEl, emptyEl, searchInput, clearBtn;
  var updateTimeEl, updateTextEl, boardListEl, tableHeaderEl;
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

  function formatDim(val) {
    if (val === '-' || val == null || val === '') return '-';
    var num = parseFloat(val);
    if (isNaN(num)) return escapeHtml(String(val));
    return num.toFixed(2);
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

  function getCategoryIcon(key) {
    return CATEGORY_ICONS[key] || 'label';
  }

  function getCategoryShortName(cat) {
    if (CATEGORY_SHORT_NAMES[cat.key]) return CATEGORY_SHORT_NAMES[cat.key];
    if (CATEGORY_DISPLAY_NAMES[cat.name]) return CATEGORY_DISPLAY_NAMES[cat.name];
    return cat.name || cat.key;
  }

  function normalizeStr(s) {
    return String(s || '').replace(/[\s\n\r]+/g, '').toLowerCase();
  }

  function matchesAny(name, candidates) {
    if (!name) return false;
    var normalized = normalizeStr(name);
    for (var i = 0; i < candidates.length; i++) {
      if (normalized === normalizeStr(candidates[i])) return true;
    }
    return false;
  }

  function isSkipHeader(name) {
    return matchesAny(name, SKIP_HEADER_NAMES);
  }

  function isRankHeader(name) {
    return matchesAny(name, RANK_HEADER_NAMES);
  }

  function isNameHeader(name) {
    return matchesAny(name, NAME_HEADER_NAMES);
  }

  function isOrgHeader(name) {
    return matchesAny(name, ORG_HEADER_NAMES);
  }

  function isScoreHeader(name) {
    return matchesAny(name, SCORE_HEADER_NAMES);
  }

  var HEADER_DISPLAY_NAMES = {
    'rank': '排名',
    'model_name': '模型名称',
    'name': '模型名称',
    'organization': '机构',
    'org': '厂商',
    'score': '总分',
    'median': '分数',
    'release_date': '发布日期',
    'model': '模型'
  };

  function getDisplayHeaderName(headerOrKey) {
    if (HEADER_DISPLAY_NAMES[headerOrKey]) return HEADER_DISPLAY_NAMES[headerOrKey];
    return headerOrKey;
  }

  function buildColumnMap(headers, firstRow) {
    var map = {
      rank: null,
      name: null,
      org: null,
      score: null,
      scoreHeaders: [],
      allHeaders: []
    };

    var validHeaders = (headers || []).filter(function (h) { return h && String(h).trim() !== ''; });
    var rowKeys = firstRow ? Object.keys(firstRow) : [];

    var headerToKey = {};
    if (validHeaders.length > 0 && rowKeys.length > 0) {
      for (var i = 0; i < Math.min(validHeaders.length, rowKeys.length); i++) {
        headerToKey[validHeaders[i]] = rowKeys[i];
      }
    } else if (rowKeys.length > 0) {
      for (var j = 0; j < rowKeys.length; j++) {
        headerToKey[rowKeys[j]] = rowKeys[j];
      }
    }

    var keys = Object.keys(headerToKey);
    for (var k = 0; k < keys.length; k++) {
      var headerName = keys[k];
      var rowKey = headerToKey[headerName];

      if (isRankHeader(headerName) || isRankHeader(rowKey)) {
        map.rank = { header: headerName, key: rowKey };
        continue;
      }
      if (isNameHeader(headerName) || isNameHeader(rowKey)) {
        map.name = { header: headerName, key: rowKey };
        continue;
      }
      if (isOrgHeader(headerName) || isOrgHeader(rowKey)) {
        map.org = { header: headerName, key: rowKey };
        continue;
      }
      if (isScoreHeader(headerName) || isScoreHeader(rowKey)) {
        map.score = { header: headerName, key: rowKey };
        continue;
      }

      if (!isSkipHeader(headerName) && !isSkipHeader(rowKey)) {
        map.scoreHeaders.push({ header: headerName, key: rowKey });
      }

      map.allHeaders.push({ header: headerName, key: rowKey });
    }

    if (!map.rank) {
      map.rank = { header: '排名', key: '__index__' };
    }
    if (!map.name && rowKeys.length > 0) {
      for (var n = 0; n < rowKeys.length; n++) {
        if (!map.rank || map.rank.key !== rowKeys[n]) {
          map.name = { header: '模型名称', key: rowKeys[n] };
          break;
        }
      }
    }

    log('COLMAP', 'rank=' + JSON.stringify(map.rank) + ', name=' + JSON.stringify(map.name) +
      ', org=' + JSON.stringify(map.org) + ', score=' + JSON.stringify(map.score) +
      ', scoreHeaders=' + map.scoreHeaders.length);

    return map;
  }

  function getVal(row, key) {
    if (!key) return null;
    if (row[key] !== undefined) return row[key];
    return null;
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
    boardListEl = document.getElementById('boardList');
    tableHeaderEl = document.getElementById('tableHeader');
    paginationEl = document.getElementById('leaderboardPagination');

    bindSearch();
    handleHashChange();

    fetchCategories()
      .then(function () {
        var hash = window.location.hash.replace('#', '');
        if (hash && findCategoryInData(hash)) {
          loadCategory(hash);
        } else {
          loadCategory('general_overall');
        }
      })
      .catch(function (err) {
        log('ERROR', 'Init chain failed: ' + (err.message || err));
        showLoadError('初始化失败，请稍后重试');
      });
  }

  function findCategoryInData(key) {
    var groups = ['general', 'multimodal'];
    for (var g = 0; g < groups.length; g++) {
      var cats = categoriesData[groups[g]] || [];
      for (var i = 0; i < cats.length; i++) {
        if (cats[i].key === key) return true;
      }
    }
    return false;
  }

  function deduplicateCategories(data) {
    var result = {};
    var groups = Object.keys(data);
    for (var g = 0; g < groups.length; g++) {
      var cats = data[groups[g]] || [];
      var seen = {};
      var deduped = [];
      for (var i = 0; i < cats.length; i++) {
        var key = cats[i].key;
        if (seen[key] !== undefined) {
          deduped[seen[key]] = cats[i];
        } else {
          seen[key] = deduped.length;
          deduped.push(cats[i]);
        }
      }
      result[groups[g]] = deduped;
    }
    return result;
  }

  function fetchCategories() {
    log('FETCH', 'Fetching categories from API');
    return fetch(API_BASE + '/api/leaderboard/categories')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to fetch categories: ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json.code !== 200 || !json.data) {
          throw new Error(json.message || 'Invalid categories response');
        }
        var rawData = json.data || { general: [], multimodal: [] };
        categoriesData = deduplicateCategories(rawData);
        var totalCount = (categoriesData.general || []).length + (categoriesData.multimodal || []).length;
        log('FETCH', 'Categories loaded: ' + totalCount + ' categories');
        renderSidebar();
      })
      .catch(function (err) {
        log('ERROR', 'fetchCategories failed: ' + (err.message || err));
        throw err;
      });
  }

  function renderSidebar() {
    var html = '';
    var groups = ['general', 'multimodal'];

    for (var g = 0; g < groups.length; g++) {
      var groupKey = groups[g];
      var groupConfig = GROUP_CONFIG[groupKey] || { name: groupKey, icon: 'leaderboard' };
      var cats = categoriesData[groupKey] || [];
      var isExpanded = expandedGroups.has(groupKey);

      html += '<li class="board-group">';
      html += '<button class="board-parent' + (isExpanded ? ' expanded' : '') + '" data-group="' + escapeHtml(groupKey) + '">';
      html += '<span class="material-symbols-outlined icon">' + groupConfig.icon + '</span>';
      html += '<span class="label">' + escapeHtml(groupConfig.name) + '</span>';
      html += '<span class="board-count">' + cats.length + '</span>';
      html += '<span class="material-symbols-outlined arrow">' + (isExpanded ? 'expand_less' : 'expand_more') + '</span>';
      html += '</button>';

      html += '<div class="sub-board-list" style="' + (isExpanded ? 'display:flex;' : 'display:none;') + '">';
      for (var j = 0; j < cats.length; j++) {
        var cat = cats[j];
        var icon = getCategoryIcon(cat.key);
        var shortName = getCategoryShortName(cat);
        var total = cat.total || 0;
        html += '<button class="sub-board-item" data-category="' + escapeHtml(cat.key) + '">';
      html += '<span class="material-symbols-outlined icon">' + icon + '</span>';
      html += '<span class="label">' + escapeHtml(shortName) + '</span>';
      if (total === 0) {
        html += '<span class="coming-soon">暂无数据</span>';
      } else if (MODEL_LIST_CATEGORIES.indexOf(cat.key) !== -1) {
        html += '<span class="model-list-tag">列表</span>';
      }
      html += '</button>';
      }
      html += '</div>';
      html += '</li>';
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
          if (expandedGroups.has(groupKey)) {
            expandedGroups.delete(groupKey);
          } else {
            expandedGroups.add(groupKey);
          }
          var subList = btn.nextElementSibling;
          var arrow = btn.querySelector('.arrow');
          if (expandedGroups.has(groupKey)) {
            btn.classList.add('expanded');
            if (subList) subList.style.display = 'flex';
            if (arrow) arrow.textContent = 'expand_less';
          } else {
            btn.classList.remove('expanded');
            if (subList) subList.style.display = 'none';
            if (arrow) arrow.textContent = 'expand_more';
          }
        });
      })(parentBtns[i]);
    }

    var subBtns = boardListEl.querySelectorAll('.sub-board-item');
    for (var j = 0; j < subBtns.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          switchCategory(btn.getAttribute('data-category'), true);
        });
      })(subBtns[j]);
    }
  }

  function updateSidebar() {
    var parentBtns = boardListEl.querySelectorAll('.board-parent');
    for (var i = 0; i < parentBtns.length; i++) {
      parentBtns[i].classList.toggle('active', parentBtns[i].getAttribute('data-group') === currentGroup);
    }
    var subBtns = boardListEl.querySelectorAll('.sub-board-item');
    for (var j = 0; j < subBtns.length; j++) {
      subBtns[j].classList.toggle('active', subBtns[j].getAttribute('data-category') === currentCategory);
    }
    if (!expandedGroups.has(currentGroup)) {
      expandedGroups.add(currentGroup);
      var parentBtn = boardListEl.querySelector('.board-parent[data-group="' + currentGroup + '"]');
      if (parentBtn) {
        parentBtn.classList.add('expanded');
        var subList = parentBtn.nextElementSibling;
        var arrow = parentBtn.querySelector('.arrow');
        if (subList) subList.style.display = 'flex';
        if (arrow) arrow.textContent = 'expand_less';
      }
    }
  }

  function switchCategory(categoryKey, saveHash) {
    currentCategory = categoryKey;
    currentPage = 1;
    if (saveHash) window.location.hash = categoryKey;
    resetFiltersQuiet();
    loadCategory(categoryKey);
  }

  function resetFiltersQuiet() {
    isLoading = true;
    if (searchInput) { searchInput.value = ''; clearBtn.style.display = 'none'; }
    isLoading = false;
  }

  function loadCategory(categoryKey) {
    if (isLoading) return;
    isLoading = true;
    log('LOAD', 'Loading category: ' + categoryKey);
    showLoading();

    var url = API_BASE + '/api/leaderboard/' + encodeURIComponent(categoryKey) + '?page=' + currentPage + '&page_size=' + PAGE_SIZE;

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load leaderboard: ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json.code !== 200) throw new Error(json.message || 'Invalid leaderboard response');

        var data = json.data || {};
        currentCategory = data.key || categoryKey;
        currentGroup = data.group || 'general';
        currentCategoryName = data.name || '';
        currentSourceDate = data.source_date || '';
        currentCrawlTime = data.crawl_time || '';

        var rows = data.rows || data.entries || [];
        currentData = rows;
        filteredModels = currentData.slice();
        totalItems = data.total || rows.length;
        totalPages = data.total_pages || Math.ceil(totalItems / PAGE_SIZE);
        currentPage = data.page || currentPage;
        sortColumn = '';
        sortDirection = 'asc';

        var firstRow = rows.length > 0 ? rows[0] : null;
        colMap = buildColumnMap(data.headers, firstRow);

        displayCols = [];
        if (colMap.score) {
          displayCols.push({ type: 'score', header: colMap.score.header, key: colMap.score.key });
        }
        for (var s = 0; s < colMap.scoreHeaders.length; s++) {
          displayCols.push({ type: 'dim', header: colMap.scoreHeaders[s].header, key: colMap.scoreHeaders[s].key });
        }

        log('LOAD', 'Category loaded: ' + currentCategory + ', rows: ' + rows.length + ', displayCols: ' + displayCols.length);

        renderTableHeader();
        sortAndRender();
        renderPagination();
        updateSidebar();
        updateTimeDisplay();

        hideLoading();
        isLoading = false;
      })
      .catch(function (err) {
        log('ERROR', 'loadCategory failed: ' + (err.message || err));
        showLoadError('数据加载失败，请稍后重试');
        isLoading = false;
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

  function renderTableHeader() {
    var html = '';
    html += '<div class="header-cell cell-rank" data-sort="__rank__">排名</div>';
    html += '<div class="header-cell cell-name" data-sort="__name__">模型名称</div>';
    html += '<div class="header-cell cell-vendor" data-sort="__org__">厂商</div>';

    for (var i = 0; i < displayCols.length; i++) {
      var col = displayCols[i];
      var cellClass = col.type === 'score' ? 'cell-score' : 'cell-dim';
      html += '<div class="header-cell ' + cellClass + '" data-sort="' + escapeHtml(col.key) + '">' + escapeHtml(getDisplayHeaderName(col.header)) + '</div>';
    }

    tableHeaderEl.innerHTML = html;

    var gridCols = '50px 1fr 100px';
    for (var j = 0; j < displayCols.length; j++) {
      gridCols += displayCols[j].type === 'score' ? ' 80px' : ' 90px';
    }
    tableHeaderEl.style.gridTemplateColumns = gridCols;

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
            sortDirection = col === '__rank__' ? 'asc' : 'desc';
          }
          sortAndRender();
        });
      })(cells[i]);
    }
  }

  function renderCards() {
    var gridCols = '50px 1fr 100px';
    for (var g = 0; g < displayCols.length; g++) {
      gridCols += displayCols[g].type === 'score' ? ' 80px' : ' 90px';
    }

    var html = '';
    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      var rankVal = (colMap.rank && colMap.rank.key !== '__index__') ? getVal(m, colMap.rank.key) : (i + 1);
      var rank = parseInt(rankVal, 10) || (i + 1);
      if (isNaN(rank) || rank <= 0) rank = i + 1;
      var rankClass = rank === 1 ? 'rank-1' : '';
      var scoreClass = rank <= 3 ? '' : 'rank-normal';
      var modelName = colMap.name ? (getVal(m, colMap.name.key) || '-') : '-';
      var orgName = colMap.org ? (getVal(m, colMap.org.key) || '-') : '-';

      html += '<div class="model-card ' + rankClass + '" style="animation-delay:' + (i * 0.03) + 's">';
      html += '<div class="card-grid" style="grid-template-columns:' + gridCols + '">';
      html += '<div class="card-rank ' + scoreClass + '">#' + escapeHtml(rank) + '</div>';
      html += '<div class="card-name">';
      html += '<div class="card-icon"><span class="material-symbols-outlined">' + getIconForRank(rank) + '</span></div>';
      html += '<span class="card-name-text">' + escapeHtml(modelName) + '</span>';
      html += '</div>';
      html += '<div class="card-vendor">' + escapeHtml(orgName) + '</div>';

      for (var j = 0; j < displayCols.length; j++) {
        var col = displayCols[j];
        var val = getVal(m, col.key);
        if (col.type === 'score') {
          html += '<div class="card-score ' + scoreClass + '">' + formatScore(val) + '</div>';
        } else {
          html += '<div class="card-dim">' + formatDim(val) + '</div>';
        }
      }

      html += '</div>';
      html += '</div>';
    }
    modelCardsEl.innerHTML = html;
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
        loadCategory(currentCategory);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  function updateTimeDisplay() {
    var timeStr = currentCrawlTime || currentSourceDate;
    if (timeStr) {
      var dateStr = timeStr.substring(0, 10);
      var label = currentSourceDate ? '数据来源：' + currentSourceDate : '更新时间：' + dateStr;
      updateTextEl.textContent = label;
      updateTimeEl.style.display = '';
    } else {
      updateTimeEl.style.display = 'none';
    }
  }

  function sortAndRender() {
    if (sortColumn) {
      filteredModels.sort(function (a, b) {
        var va, vb;
        if (sortColumn === '__rank__') {
          va = (colMap.rank && colMap.rank.key !== '__index__') ? getVal(a, colMap.rank.key) : null;
          vb = (colMap.rank && colMap.rank.key !== '__index__') ? getVal(b, colMap.rank.key) : null;
        } else if (sortColumn === '__name__') {
          va = colMap.name ? getVal(a, colMap.name.key) : null;
          vb = colMap.name ? getVal(b, colMap.name.key) : null;
        } else if (sortColumn === '__org__') {
          va = colMap.org ? getVal(a, colMap.org.key) : null;
          vb = colMap.org ? getVal(b, colMap.org.key) : null;
        } else {
          va = getVal(a, sortColumn);
          vb = getVal(b, sortColumn);
        }

        var na = parseFloat(va);
        var nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return sortDirection === 'asc' ? na - nb : nb - na;
        if (!isNaN(na)) return sortDirection === 'asc' ? -1 : 1;
        if (!isNaN(nb)) return sortDirection === 'asc' ? 1 : -1;

        var sa = String(va || '').toLowerCase();
        var sb = String(vb || '').toLowerCase();
        var cmp = sa.localeCompare(sb, 'zh-CN');
        return sortDirection === 'asc' ? cmp : -cmp;
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

  function handleHashChange() {
    window.addEventListener('hashchange', function () {
      var hash = window.location.hash.replace('#', '');
      if (hash && findCategoryInData(hash) && hash !== currentCategory) {
        switchCategory(hash, false);
      }
    });
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
            var nameVal = colMap.name ? (getVal(m, colMap.name.key) || '') : '';
            var orgVal = colMap.org ? (getVal(m, colMap.org.key) || '') : '';
            return nameVal.toLowerCase().indexOf(lower) !== -1 || orgVal.toLowerCase().indexOf(lower) !== -1;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
