(function () {
  'use strict';

  function tt(key, fallback) {
    try {
      if (typeof t === 'function') return t(key, fallback);
    } catch (e) {}
    return fallback != null ? fallback : key;
  }

  function getScore(model) {
    if (model.scores && model.scores.overall_score != null) return model.scores.overall_score;
    if (model.evaluation && model.evaluation.aa_intelligence_index != null) return model.evaluation.aa_intelligence_index;
    return null;
  }

  var API_BASE = window.AIX_CONFIG.apiBase + '/api';
  var providersData = [];
  var lastModelsItems = [];
  var currentPage = 1;
  var totalPages = 1;
  var totalItems = 0;
  var PAGE_SIZE = 20;

  var searchQuery = '';
  var selectedProviders = [];
  var selectedType = null;
  var selectedAccess = 'all';

  var providerExpanded = false;
  var COLLAPSE_COUNT = 10;

  var modelsGridEl, loadingEl, emptyEl, searchInput, clearBtn, paginationEl, resultCountEl;

  function log(tag, message) {
    var timestamp = new Date().toISOString().substring(11, 23);
    console.log('[AIX][Models][' + tag + '][' + timestamp + '] ' + message);
  }

  function init() {
    log('INIT', 'Initializing models page');

    modelsGridEl = document.getElementById('modelsGrid');
    loadingEl = document.getElementById('modelsLoading');
    emptyEl = document.getElementById('modelsEmpty');
    searchInput = document.getElementById('modelSearchInput');
    clearBtn = document.getElementById('clearModelSearch');
    paginationEl = document.getElementById('modelsPagination');
    resultCountEl = document.getElementById('resultCount');

    var missingElements = [];
    if (!modelsGridEl) missingElements.push('modelsGrid');
    if (!loadingEl) missingElements.push('modelsLoading');
    if (!emptyEl) missingElements.push('modelsEmpty');
    if (!searchInput) missingElements.push('modelSearchInput');
    if (!clearBtn) missingElements.push('clearModelSearch');

    if (missingElements.length > 0) {
      log('ERROR', 'Missing DOM elements: ' + missingElements.join(', '));
    } else {
      log('INIT', 'All DOM elements found');
    }

    fetchProviders();
    fetchModels();
    bindSearch();
    bindTypeFilters();
    bindAccessFilters();
  }

  function fetchProviders() {
    fetch(API_BASE + '/providers')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load providers');
        return res.json();
      })
      .then(function (result) {
        providersData = result.data || [];
        log('INIT', 'Providers loaded: ' + providersData.length);
        updateProviderFilters();
      })
      .catch(function (err) {
        log('ERROR', 'Providers fetch failed: ' + (err.message || err));
      });
  }

  function buildApiUrl() {
    var url = API_BASE + '/models?page=' + currentPage + '&page_size=' + PAGE_SIZE;

    if (searchQuery) {
      url += '&q=' + encodeURIComponent(searchQuery);
    }

    if (selectedProviders.length === 1) {
      url += '&provider=' + encodeURIComponent(selectedProviders[0]);
    }

    if (selectedType) {
      var capMap = {
        '大语言模型': 'text',
        '多模态': 'vision',
        '视觉': 'vision',
        '音频': 'audio',
        '代码': 'code',
        '推理': 'reasoning',
        '图像生成': 'image_gen'
      };
      var cap = capMap[selectedType];
      if (cap) url += '&capability=' + cap;
    }

    if (selectedAccess !== 'all') {
      var accessMap = { '开源': 'open_source', '闭源': 'closed' };
      var apiAccess = accessMap[selectedAccess];
      if (apiAccess) url += '&provider_type=' + apiAccess;
    }

    url += '&sort_by=overall_score&sort_order=desc';

    return url;
  }

  function fetchModels() {
    log('FETCH', 'Starting data fetch, page=' + currentPage);
    showLoading();

    var url = buildApiUrl();
    log('FETCH', 'URL: ' + url);

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load models, status=' + res.status);
        return res.json();
      })
      .then(function (data) {
        var items = data.data || [];
        totalItems = data.total || 0;
        totalPages = data.total_pages || Math.ceil(totalItems / PAGE_SIZE);
        currentPage = data.page || currentPage;

        log('FETCH', 'Loaded: ' + items.length + ' items, total=' + totalItems + ', pages=' + totalPages);

        hideLoading();

        if (items.length === 0) {
          var emptyMsg = searchQuery
            ? tt('models.empty_search', '未找到与 "{q}" 相关的模型').replace('{q}', searchQuery)
            : tt('models.empty', '未找到匹配的模型');
          showEmpty(emptyMsg);
        } else {
          lastModelsItems = items;
          renderModels(items);
          renderPagination();
          updateResultCount();
        }
      })
      .catch(function (err) {
        log('ERROR', 'Data fetch failed: ' + (err.message || err));
        hideLoading();
        showEmpty(tt('models.load_error', '数据加载失败，请稍后重试'));
      });
  }

  function showLoading() {
    if (loadingEl) loadingEl.style.display = '';
    if (modelsGridEl) modelsGridEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';
    if (paginationEl) paginationEl.style.display = 'none';
  }

  function hideLoading() {
    if (loadingEl) loadingEl.style.display = 'none';
  }

  function showEmpty(msg) {
    if (modelsGridEl) modelsGridEl.style.display = 'none';
    if (emptyEl) {
      emptyEl.style.display = '';
      var p = emptyEl.querySelector('p');
      if (p) p.textContent = msg || tt('models.empty', '未找到匹配的模型');
    }
    if (paginationEl) paginationEl.style.display = 'none';
    if (resultCountEl) resultCountEl.textContent = '';
  }

  function updateResultCount() {
    if (!resultCountEl) return;
    var start = (currentPage - 1) * PAGE_SIZE + 1;
    var end = Math.min(currentPage * PAGE_SIZE, totalItems);
    resultCountEl.textContent = tt('models.result_count_range', '共 {total} 个模型，当前显示 {start}-{end}')
      .replace('{total}', totalItems)
      .replace('{start}', start)
      .replace('{end}', end);
  }

  function updateProviderFilters() {
    var container = document.getElementById('providerFilters');
    if (!container) return;

    var total = providersData.length;
    var showCount = providerExpanded ? total : Math.min(COLLAPSE_COUNT, total);

    var html = '';
    for (var j = 0; j < showCount; j++) {
      var p = providersData[j];
      var key = p.provider;
      var name = formatProviderName(p.provider);
      var count = p.model_count;
      var checked = selectedProviders.indexOf(key) !== -1 ? ' checked' : '';
      html += '<label class="checkbox-item">';
      html += '<input type="checkbox" value="' + escapeAttr(key) + '" class="filter-checkbox"' + checked + '>';
      html += '<span class="checkbox-label">' + escapeHtml(name) + ' (' + count + ')</span>';
      html += '</label>';
    }

    if (total > COLLAPSE_COUNT) {
      if (providerExpanded) {
        html += '<button type="button" class="provider-toggle-btn" id="providerToggleBtn">';
        html += '<span class="toggle-icon-up">▲</span> ' + escapeHtml(tt('models.collapse', '收起'));
        html += '</button>';
      } else {
        html += '<div class="provider-summary">';
        html += '<span class="provider-total-text">' + escapeHtml(tt('models.provider_count', '共 {total} 个供应商').replace('{total}', total)) + '</span>';
        html += '<button type="button" class="provider-toggle-btn" id="providerToggleBtn">';
        html += escapeHtml(tt('models.expand_all', '展开全部')) + ' <span class="toggle-icon-down">▼</span>';
        html += '</button>';
        html += '</div>';
      }
    }

    container.innerHTML = html;
    container.classList.toggle('provider-expanded', providerExpanded);
    bindProviderFilters();
    bindProviderToggle();
  }

  function bindProviderToggle() {
    var btn = document.getElementById('providerToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      providerExpanded = !providerExpanded;
      updateProviderFilters();
    });
  }

  function formatProviderName(key) {
    var nameMap = {
      'openai': 'OpenAI',
      'anthropic': 'Anthropic',
      'aliyun': '阿里云',
      'google': 'Google',
      'meta': 'Meta',
      'mistral': 'Mistral AI',
      'deepseek': '深度求索'
    };
    return nameMap[key] || key;
  }

  function bindSearch() {
    var timeout;
    searchInput.addEventListener('input', function () {
      clearTimeout(timeout);
      var val = searchInput.value.trim();
      clearBtn.style.display = val ? '' : 'none';
      timeout = setTimeout(function () {
        searchQuery = val;
        currentPage = 1;
        fetchModels();
      }, 400);
    });

    clearBtn.addEventListener('click', function () {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      searchQuery = '';
      currentPage = 1;
      fetchModels();
      searchInput.focus();
    });
  }

  function bindProviderFilters() {
    var checkboxes = document.querySelectorAll('#providerFilters .filter-checkbox');
    for (var i = 0; i < checkboxes.length; i++) {
      checkboxes[i].removeEventListener('change', handleProviderChange);
      checkboxes[i].addEventListener('change', handleProviderChange);
    }
  }

  function handleProviderChange() {
    updateSelectedProviders();
    currentPage = 1;
    fetchModels();
  }

  function updateSelectedProviders() {
    var checkboxes = document.querySelectorAll('#providerFilters .filter-checkbox:checked');
    selectedProviders = [];
    for (var i = 0; i < checkboxes.length; i++) {
      selectedProviders.push(checkboxes[i].value);
    }
    log('FILTER', 'Selected providers: ' + selectedProviders.join(', '));
  }

  function bindTypeFilters() {
    var tagBtns = document.querySelectorAll('#typeFilters .tag-btn');
    for (var i = 0; i < tagBtns.length; i++) {
      tagBtns[i].addEventListener('click', function () {
        var type = this.getAttribute('data-type');
        if (this.classList.contains('active')) {
          this.classList.remove('active');
          selectedType = null;
        } else {
          for (var j = 0; j < tagBtns.length; j++) {
            tagBtns[j].classList.remove('active');
          }
          this.classList.add('active');
          selectedType = type;
        }
        log('FILTER', 'Selected type: ' + (selectedType || 'none'));
        currentPage = 1;
        fetchModels();
      });
    }
  }

  function bindAccessFilters() {
    var radios = document.querySelectorAll('.filter-radio');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () {
        selectedAccess = this.value;
        log('FILTER', 'Selected access: ' + selectedAccess);
        currentPage = 1;
        fetchModels();
      });
    }
  }

  function renderModels(items) {
    modelsGridEl.style.display = '';
    emptyEl.style.display = 'none';

    var html = '';
    for (var i = 0; i < items.length; i++) {
      var m = items[i];
      html += '<div class="model-card" style="animation-delay:' + (i * 0.03) + 's">';
      html += '<div class="model-card-header">';
      html += '<h2 class="model-card-title">' + escapeHtml(m.model_name || m.model_id) + '</h2>';
      html += '<div class="model-card-icon"><span class="material-symbols-outlined">' + getIconForModel(m) + '</span></div>';
      html += '</div>';
      html += '<p class="model-card-description">' + getModelDescription(m) + '</p>';
      html += '<div class="model-card-tags">';
      var tags = m.tags || [];
      for (var j = 0; j < Math.min(tags.length, 4); j++) {
        var tagClass = getTagClass(tags[j]);
        html += '<span class="model-tag ' + tagClass + '">' + escapeHtml(tags[j]) + '</span>';
      }
      html += '</div>';
      html += '</div>';
    }
    modelsGridEl.innerHTML = html;
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

    for (var j = start; j <= end; j++) {
      pages.push(j);
    }

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
        fetchModels();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  function getIconForModel(model) {
    var caps = model.capabilities || {};
    if (caps.audio_gen) return 'mic';
    if (caps.audio) return 'hearing';
    if (caps.image_gen) return 'image';
    if (caps.vision) return 'visibility';
    if (caps.code) return 'code';
    if (caps.reasoning) return 'psychology';
    return 'language';
  }

  function getModelDescription(model) {
    var parts = [];

    var providerName = formatProviderName(model.provider);
    parts.push(providerName + ' · ' + formatDate(model.release_date));

    if (model.context_length) {
      var ctx = formatContextLength(model.context_length);
      parts.push(ctx + ' ' + tt('models.ctx_label', '上下文'));
    }

    var scoreValue = getScore(model);
    if (scoreValue != null) {
      parts.push(tt('models.score_label', '综合评分') + ' ' + scoreValue);
    }

    return parts.join(' | ');
  }

  function formatContextLength(tokens) {
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(0) + 'M';
    if (tokens >= 1000) return (tokens / 1000).toFixed(0) + 'K';
    return tokens.toString();
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    return tt('models.date_format', '{y}年{m}月')
      .replace('{y}', d.getFullYear())
      .replace('{m}', (d.getMonth() + 1));
  }

  function getTagClass(tag) {
    var primaryTags = ['reasoning', 'coding', 'vision', 'multimodal', 'cheap', 'premium'];
    return primaryTags.indexOf(tag) !== -1 ? 'tag-primary' : 'tag-secondary';
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  document.addEventListener('languagechange', function () {
    try {
      log('I18N', 'Language changed, re-rendering models page');
      if (lastModelsItems && lastModelsItems.length > 0) {
        renderModels(lastModelsItems);
      }
      renderPagination();
      updateResultCount();
      updateProviderFilters();
    } catch (e) {
      log('ERROR', 'languagechange handler failed: ' + (e.message || e));
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
