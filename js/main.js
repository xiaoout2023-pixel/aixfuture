(function () {
  'use strict';

  var models = [];
  var filteredModels = [];
  var sortColumn = 'rank';
  var sortDirection = 'asc';

  var tableEl = document.getElementById('rankTable');
  var bodyEl = document.getElementById('rankBody');
  var loadingEl = document.getElementById('loadingState');
  var emptyEl = document.getElementById('emptyState');
  var searchInput = document.getElementById('searchInput');
  var clearBtn = document.getElementById('clearSearch');
  var tableContainer = document.getElementById('tableContainer');

  function init() {
    fetchData();
    bindSearch();
    bindSortHeaders();
  }

  function fetchData() {
    loadingEl.style.display = '';
    tableEl.style.display = 'none';
    emptyEl.style.display = 'none';

    fetch('data/models.json')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load data');
        return res.json();
      })
      .then(function (data) {
        models = data || [];
        filteredModels = models.slice();
        sortAndRender();
        loadingEl.style.display = 'none';
        tableEl.style.display = '';
      })
      .catch(function () {
        loadingEl.style.display = 'none';
        emptyEl.style.display = '';
        emptyEl.querySelector('p').textContent = '数据加载失败，请稍后重试';
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
          filteredModels = models.slice();
        } else {
          var lower = val.toLowerCase();
          filteredModels = models.filter(function (m) {
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
      filteredModels = models.slice();
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
      html += '<td class="cell-special" title="' + escapeHtml(m.special) + '">' + escapeHtml(m.special) + '</td>';
      html += '</tr>';
    }
    bodyEl.innerHTML = html;
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
