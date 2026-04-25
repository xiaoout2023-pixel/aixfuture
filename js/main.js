(function () {
  'use strict';

  var allData = {};
  var leaderboards = {};
  var currentBoard = 'general';
  var filteredModels = [];
  var sortColumn = 'rank';
  var sortDirection = 'asc';
  var updateTime = '';

  var modelCardsEl, loadingEl, emptyEl, searchInput, clearBtn, updateTimeEl, updateTextEl;

  function log(tag, message) {
    var timestamp = new Date().toISOString().substring(11, 23);
    console.log('[AIX][' + tag + '][' + timestamp + '] ' + message);
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

    var missingElements = [];
    if (!modelCardsEl) missingElements.push('modelCards');
    if (!loadingEl) missingElements.push('loadingState');
    if (!emptyEl) missingElements.push('emptyState');
    if (!searchInput) missingElements.push('searchInput');
    if (!clearBtn) missingElements.push('clearSearch');
    if (!updateTimeEl) missingElements.push('updateTime');
    if (!updateTextEl) missingElements.push('updateText');
    
    if (missingElements.length > 0) {
      log('ERROR', 'Missing DOM elements: ' + missingElements.join(', '));
    } else {
      log('INIT', 'All DOM elements found');
    }
    
    fetchData();
    bindSearch();
    bindSidebarNav();
    handleHashChange();
    log('INIT', 'Initialization complete');
  }

  function fetchData() {
    log('FETCH', 'Starting data fetch');
    loadingEl.style.display = '';
    modelCardsEl.style.display = 'none';
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
          updateTextEl.textContent = '排行榜更新时间：' + updateTime;
          updateTimeEl.style.display = '';
        }

        switchBoard(currentBoard, false);
        loadingEl.style.display = 'none';
        modelCardsEl.style.display = '';
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

    updateSidebarItems();
    sortAndRender();

    if (saveHash) {
      log('BOARD', 'Saving hash to URL: #' + board);
      window.location.hash = board;
    }
  }

  function updateSidebarItems() {
    var items = document.querySelectorAll('.board-btn');
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      item.classList.toggle('active', item.getAttribute('data-board') === currentBoard);
    }
  }

  function bindSidebarNav() {
    log('EVENT', 'Binding sidebar navigation');
    var items = document.querySelectorAll('.board-btn');
    log('EVENT', 'Found ' + items.length + ' sidebar buttons');
    
    for (var i = 0; i < items.length; i++) {
      (function(item, index) {
        item.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var board = item.getAttribute('data-board');
          log('EVENT', 'Sidebar button clicked (index=' + index + '): ' + board);
          try {
            switchBoard(board, true);
            log('EVENT', 'switchBoard completed successfully');
          } catch (err) {
            log('ERROR', 'switchBoard threw error: ' + err.message);
          }
        });
      })(items[i], i);
    }
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
      modelCardsEl.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.querySelector('p').textContent = '未找到匹配的模型';
    } else {
      modelCardsEl.style.display = '';
      emptyEl.style.display = 'none';
      renderCards();
    }
  }

  function renderCards() {
    var html = '';
    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      var rankClass = m.rank === 1 ? 'rank-1' : '';
      var typeClass = m.type === '开源' ? 'open' : m.type === '闭源' ? 'closed' : '';
      var scoreClass = m.rank <= 3 ? '' : 'rank-normal';
      
      html += '<div class="model-card ' + rankClass + '" style="animation-delay:' + (i * 0.03) + 's">';
      html += '<div class="card-grid">';
      html += '<div class="card-rank ' + scoreClass + '">#' + escapeHtml(m.rank) + '</div>';
      html += '<div class="card-name">';
      html += '<div class="card-icon"><span class="material-symbols-outlined">' + getIconForRank(m.rank) + '</span></div>';
      html += '<span class="card-name-text">' + escapeHtml(m.name) + '</span>';
      html += '</div>';
      html += '<div class="card-vendor">' + escapeHtml(m.vendor) + '</div>';
      html += '<div class="card-type ' + typeClass + '">' + escapeHtml(m.type) + '</div>';
      html += '<div class="card-languages">' + escapeHtml(m.languages) + '</div>';
      html += '<div class="card-score ' + scoreClass + '">' + escapeHtml(m.score) + '</div>';
      html += '<div class="card-dim">' + formatDim(m.math_reasoning) + '</div>';
      html += '<div class="card-dim">' + formatDim(m.hallucination_control) + '</div>';
      html += '<div class="card-dim">' + formatDim(m.science_reasoning) + '</div>';
      html += '<div class="card-dim">' + formatDim(m.instruction_following) + '</div>';
      html += '<div class="card-dim">' + formatDim(m.code_generation) + '</div>';
      html += '<div class="card-dim">' + formatDim(m.agent_planning) + '</div>';
      html += '</div>';
      html += '</div>';
    }
    modelCardsEl.innerHTML = html;
  }

  function getIconForRank(rank) {
    if (rank === 1) return 'auto_awesome';
    if (rank === 2) return 'psychology';
    if (rank === 3) return 'smart_toy';
    return 'memory';
  }

  function formatDim(val) {
    if (val === '-' || val == null || val === '') return '-';
    return escapeHtml(val) + '<span class="unit">%</span>';
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
