(function () {
  'use strict';

  var allData = {};
  var leaderboards = {};
  var currentBoard = 'general';
  var filteredModels = [];
  var sortColumn = 'rank';
  var sortDirection = 'asc';
  var updateTime = '';

  var tableEl, bodyEl, loadingEl, emptyEl, searchInput, clearBtn, tableContainer, updateTimeEl, rankingsNav, rankingsMenu, boardTitleEl;

  function log(tag, message) {
    var timestamp = new Date().toISOString().substring(11, 23);
    console.log('[AIX][' + tag + '][' + timestamp + '] ' + message);
  }

  function init() {
    log('INIT', 'Initializing application');
    
    tableEl = document.getElementById('rankTable');
    bodyEl = document.getElementById('rankBody');
    loadingEl = document.getElementById('loadingState');
    emptyEl = document.getElementById('emptyState');
    searchInput = document.getElementById('searchInput');
    clearBtn = document.getElementById('clearSearch');
    tableContainer = document.getElementById('tableContainer');
    updateTimeEl = document.getElementById('updateTime');
    rankingsNav = document.getElementById('rankingsNav');
    rankingsMenu = document.getElementById('rankingsMenu');
    boardTitleEl = document.getElementById('boardTitle');

    var missingElements = [];
    if (!tableEl) missingElements.push('rankTable');
    if (!bodyEl) missingElements.push('rankBody');
    if (!loadingEl) missingElements.push('loadingState');
    if (!emptyEl) missingElements.push('emptyState');
    if (!searchInput) missingElements.push('searchInput');
    if (!clearBtn) missingElements.push('clearSearch');
    if (!tableContainer) missingElements.push('tableContainer');
    if (!updateTimeEl) missingElements.push('updateTime');
    if (!rankingsNav) missingElements.push('rankingsNav');
    if (!rankingsMenu) missingElements.push('rankingsMenu');
    if (!boardTitleEl) missingElements.push('boardTitle');
    
    if (missingElements.length > 0) {
      log('ERROR', 'Missing DOM elements: ' + missingElements.join(', '));
    } else {
      log('INIT', 'All DOM elements found');
    }
    
    fetchData();
    bindSearch();
    bindSortHeaders();
    bindDropdownNav();
    handleHashChange();
    log('INIT', 'Initialization complete');
  }

  function fetchData() {
    log('FETCH', 'Starting data fetch');
    loadingEl.style.display = '';
    tableEl.style.display = 'none';
    emptyEl.style.display = 'none';
    updateTimeEl.style.display = 'none';

    fetch('data/models.json')
      .then(function (res) {
        if (!res.ok) {
          log('ERROR', 'Fetch failed with status ' + res.status);
          throw new Error('Failed to load data');
        }
        log('FETCH', 'Response received, parsing JSON');
        return res.json();
      })
      .then(function (data) {
        allData = data || {};
        updateTime = allData.update_time || '';
        leaderboards = allData.leaderboards || {};

        log('FETCH', 'Data loaded: update_time=' + updateTime + ', leaderboards=' + Object.keys(leaderboards).join(','));

        if (!leaderboards[currentBoard]) {
          log('WARN', 'Current board "' + currentBoard + '" not found, switching to general');
          currentBoard = 'general';
        }

        if (updateTime) {
          updateTimeEl.textContent = '榜单更新时间：' + updateTime;
          updateTimeEl.style.display = 'block';
        }

        switchBoard(currentBoard, false);
        loadingEl.style.display = 'none';
        tableEl.style.display = '';
        log('FETCH', 'Data load complete, board=' + currentBoard);
      })
      .catch(function (err) {
        log('ERROR', 'Data fetch failed: ' + (err.message || err));
        loadingEl.style.display = 'none';
        emptyEl.style.display = '';
        emptyEl.querySelector('p').textContent = '数据加载失败，请稍后重试';
      });
  }

  function switchBoard(board, saveHash) {
    log('BOARD', 'Attempting to switch board: ' + board + ' (saveHash=' + saveHash + ')');
    log('BOARD', 'Available leaderboards: ' + Object.keys(leaderboards).join(','));
    
    if (!leaderboards[board]) {
      log('ERROR', 'Board "' + board + '" not found in leaderboards');
      return;
    }
    
    currentBoard = board;
    filteredModels = (leaderboards[board].models || []).slice();
    sortColumn = 'rank';
    sortDirection = 'asc';

    log('BOARD', 'Switched to board "' + board + '" with ' + filteredModels.length + ' models');

    updateBoardTitle();
    updateDropdownItems();
    updateSortIndicators();
    sortAndRender();

    if (saveHash) {
      log('BOARD', 'Saving hash to URL: #' + board);
      window.location.hash = board;
    }
  }

  function updateBoardTitle() {
    var boardName = leaderboards[currentBoard].name || currentBoard;
    boardTitleEl.textContent = boardName;
    boardTitleEl.style.display = 'block';
    log('BOARD', 'Updated board title to: ' + boardName);
  }

  function updateDropdownItems() {
    var items = rankingsMenu.querySelectorAll('.dropdown-item');
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      item.classList.toggle('active', item.getAttribute('data-board') === currentBoard);
    }
  }

  function bindDropdownNav() {
    log('EVENT', 'Binding dropdown navigation');
    var items = rankingsMenu.querySelectorAll('.dropdown-item');
    log('EVENT', 'Found ' + items.length + ' dropdown items');
    
    for (var i = 0; i < items.length; i++) {
      (function(item, index) {
        item.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var board = item.getAttribute('data-board');
          log('EVENT', 'Dropdown item clicked (index=' + index + '): ' + board);
          log('EVENT', 'This element: ' + this.tagName + ', data-board=' + this.getAttribute('data-board'));
          log('EVENT', 'Leaderboards before switchBoard: ' + Object.keys(leaderboards).join(','));
          try {
            switchBoard(board, true);
            log('EVENT', 'switchBoard completed successfully');
          } catch (err) {
            log('ERROR', 'switchBoard threw error: ' + err.message);
          }
          rankingsMenu.classList.remove('show');
        });
      })(items[i], i);
    }

    rankingsNav.addEventListener('click', function (e) {
      e.preventDefault();
      log('EVENT', 'Rankings nav clicked, toggling menu');
      rankingsMenu.classList.toggle('show');
    });

    document.addEventListener('click', function (e) {
      if (!rankingsNav.contains(e.target) && !rankingsMenu.contains(e.target)) {
        rankingsMenu.classList.remove('show');
      }
    });
  }

  function handleHashChange() {
    var hash = window.location.hash.replace('#', '');
    log('HASH', 'Initial hash check: "' + hash + '"');
    log('HASH', 'Leaderboards available at this time: ' + Object.keys(leaderboards).join(','));
    
    if (hash && leaderboards[hash]) {
      log('HASH', 'Hash matches a board, switching to "' + hash + '"');
      switchBoard(hash, false);
    } else if (hash) {
      log('HASH', 'Hash "' + hash + '" does not match any board');
    }
    
    window.addEventListener('hashchange', function () {
      var h = window.location.hash.replace('#', '');
      log('HASH', 'Hash changed to: "' + h + '"');
      log('HASH', 'Leaderboards at hashchange: ' + Object.keys(leaderboards).join(','));
      if (h && leaderboards[h] && h !== currentBoard) {
        log('HASH', 'Switching board from hashchange: ' + h);
        switchBoard(h, false);
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
          filteredModels = (leaderboards[currentBoard].models || []).slice();
        } else {
          var lower = val.toLowerCase();
          var source = leaderboards[currentBoard].models || [];
          filteredModels = source.filter(function (m) {
            return (
              m.name.toLowerCase().indexOf(lower) !== -1 ||
              m.vendor.toLowerCase().indexOf(lower) !== -1
            );
          });
        }
        sortAndRender();
      }, 200);
    });

    clearBtn.addEventListener('click', function () {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      filteredModels = (leaderboards[currentBoard].models || []).slice();
      sortAndRender();
      searchInput.focus();
    });
  }

  function bindSortHeaders() {
    var headers = tableEl.querySelectorAll('th.sortable');
    for (var i = 0; i < headers.length; i++) {
      headers[i].addEventListener('click', (function (el) {
        return function () {
          var col = el.getAttribute('data-sort');
          if (sortColumn === col) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
          } else {
            sortColumn = col;
            sortDirection = col === 'rank' || col === 'score' ? 'desc' : 'asc';
          }
          updateSortIndicators();
          sortAndRender();
        };
      })(headers[i]));
    }
  }

  function updateSortIndicators() {
    var headers = tableEl.querySelectorAll('th.sortable');
    for (var i = 0; i < headers.length; i++) {
      var el = headers[i];
      el.classList.remove('sorted');
      el.removeAttribute('data-direction');
      if (el.getAttribute('data-sort') === sortColumn) {
        el.classList.add('sorted');
        el.setAttribute('data-direction', sortDirection);
      }
    }
  }

  function sortAndRender() {
    filteredModels.sort(function (a, b) {
      var va = a[sortColumn];
      var vb = b[sortColumn];
      if (va == null) va = sortDirection === 'asc' ? Infinity : -Infinity;
      if (vb == null) vb = sortDirection === 'asc' ? Infinity : -Infinity;

      if (typeof va === 'number' && typeof vb === 'number') {
        return sortDirection === 'asc' ? va - vb : vb - va;
      }
      var sa = String(va || '').toLowerCase();
      var sb = String(vb || '').toLowerCase();
      var cmp = sa.localeCompare(sb, 'zh-CN');
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    if (filteredModels.length === 0) {
      tableEl.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.querySelector('p').textContent = '未找到匹配的模型';
    } else {
      tableEl.style.display = '';
      emptyEl.style.display = 'none';
      renderRows();
    }
  }

  function renderRows() {
    var html = '';
    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      var scoreClass = m.score >= 9 ? 'high' : m.score >= 8 ? 'mid' : '';
      var typeClass = m.type === '开源' ? 'open' : m.type === '闭源' ? 'closed' : '';
      html += '<tr style="animation-delay:' + (i * 0.03) + 's">';
      html += '<td class="cell-rank">' + escapeHtml(m.rank) + '</td>';
      html += '<td class="cell-name">' + escapeHtml(m.name) + '</td>';
      html += '<td class="cell-vendor">' + escapeHtml(m.vendor) + '</td>';
      html += '<td class="cell-type ' + typeClass + '">' + escapeHtml(m.type) + '</td>';
      html += '<td class="cell-languages">' + escapeHtml(m.languages) + '</td>';
      html += '<td class="cell-score ' + scoreClass + '">' + escapeHtml(m.score) + '</td>';
      html += '<td class="cell-dim">' + formatDim(m.math_reasoning) + '</td>';
      html += '<td class="cell-dim">' + formatDim(m.hallucination_control) + '</td>';
      html += '<td class="cell-dim">' + formatDim(m.science_reasoning) + '</td>';
      html += '<td class="cell-dim">' + formatDim(m.instruction_following) + '</td>';
      html += '<td class="cell-dim">' + formatDim(m.code_generation) + '</td>';
      html += '<td class="cell-dim">' + formatDim(m.agent_planning) + '</td>';
      html += '</tr>';
    }
    bodyEl.innerHTML = html;
  }

  function formatDim(val) {
    if (val === '-' || val == null || val === '') return '-';
    return escapeHtml(val);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
