(function () {
  'use strict';

  var allData = {};
  var leaderboards = {};
  var currentBoard = 'general';
  var filteredModels = [];
  var sortColumn = 'rank';
  var sortDirection = 'asc';
  var updateTime = '';

  var tableEl = document.getElementById('rankTable');
  var bodyEl = document.getElementById('rankBody');
  var loadingEl = document.getElementById('loadingState');
  var emptyEl = document.getElementById('emptyState');
  var searchInput = document.getElementById('searchInput');
  var clearBtn = document.getElementById('clearSearch');
  var tableContainer = document.getElementById('tableContainer');
  var updateTimeEl = document.getElementById('updateTime');
  var rankingsNav = document.getElementById('rankingsNav');
  var rankingsMenu = document.getElementById('rankingsMenu');

  function init() {
    fetchData();
    bindSearch();
    bindSortHeaders();
    bindDropdownNav();
    handleHashChange();
  }

  function fetchData() {
    loadingEl.style.display = '';
    tableEl.style.display = 'none';
    emptyEl.style.display = 'none';
    updateTimeEl.style.display = 'none';

    fetch('data/models.json')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load data');
        return res.json();
      })
      .then(function (data) {
        allData = data || {};
        updateTime = allData.update_time || '';
        leaderboards = allData.leaderboards || {};

        if (!leaderboards[currentBoard]) {
          currentBoard = 'general';
        }

        if (updateTime) {
          updateTimeEl.textContent = '榜单更新时间：' + updateTime;
          updateTimeEl.style.display = 'block';
        }

        switchBoard(currentBoard, false);
        loadingEl.style.display = 'none';
        tableEl.style.display = '';
      })
      .catch(function () {
        loadingEl.style.display = 'none';
        emptyEl.style.display = '';
        emptyEl.querySelector('p').textContent = '数据加载失败，请稍后重试';
      });
  }

  function switchBoard(board, saveHash) {
    if (!leaderboards[board]) return;
    currentBoard = board;
    filteredModels = (leaderboards[board].models || []).slice();
    sortColumn = 'rank';
    sortDirection = 'asc';

    updateDropdownItems();
    updateSortIndicators();
    sortAndRender();

    if (saveHash) {
      window.location.hash = board;
    }
  }

  function updateDropdownItems() {
    var items = rankingsMenu.querySelectorAll('.dropdown-item');
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      item.classList.toggle('active', item.getAttribute('data-board') === currentBoard);
    }
  }

  function bindDropdownNav() {
    var items = rankingsMenu.querySelectorAll('.dropdown-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function (e) {
        e.preventDefault();
        switchBoard(this.getAttribute('data-board'), true);
        rankingsMenu.classList.remove('show');
      });
    }

    rankingsNav.addEventListener('click', function (e) {
      e.preventDefault();
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
    if (hash && leaderboards[hash]) {
      switchBoard(hash, false);
    }
    window.addEventListener('hashchange', function () {
      var h = window.location.hash.replace('#', '');
      if (h && leaderboards[h] && h !== currentBoard) {
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
