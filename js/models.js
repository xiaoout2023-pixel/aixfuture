(function () {
  'use strict';

  var API_BASE = 'https://aixfutureapi.vercel.app/api';
  var modelsData = [];
  var providersData = [];
  var filteredModels = [];
  var searchQuery = '';
  var selectedProviders = [];
  var selectedType = null;
  var selectedAccess = 'all';

  var modelsGridEl, loadingEl, emptyEl, searchInput, clearBtn;

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

    fetchData();
    bindSearch();
    bindProviderFilters();
    bindTypeFilters();
    bindAccessFilters();
  }

  function fetchData() {
    log('FETCH', 'Starting data fetch');
    loadingEl.style.display = '';
    modelsGridEl.style.display = 'none';
    emptyEl.style.display = 'none';

    Promise.all([
      fetch(API_BASE + '/models').then(function (res) {
        if (!res.ok) throw new Error('Failed to load models');
        return res.json();
      }),
      fetch(API_BASE + '/providers').then(function (res) {
        if (!res.ok) throw new Error('Failed to load providers');
        return res.json();
      })
    ])
    .then(function (results) {
      modelsData = (results[0].data || []).sort(function(a, b) {
        var sa = (a.scores && a.scores.overall_score) || 0;
        var sb = (b.scores && b.scores.overall_score) || 0;
        return sb - sa;
      });
      providersData = results[1].data || [];

      log('FETCH', 'Models loaded: ' + modelsData.length);
      log('FETCH', 'Providers loaded: ' + providersData.length);

      filteredModels = modelsData.slice();
      updateProviderFilters();
      loadingEl.style.display = 'none';
      modelsGridEl.style.display = '';
      renderModels();
      log('FETCH', 'Render complete');
    })
    .catch(function (err) {
      log('ERROR', 'Data fetch failed: ' + (err.message || err));
      loadingEl.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.querySelector('p').textContent = '数据加载失败，请稍后重试';
    });
  }

  function updateProviderFilters() {
    var container = document.getElementById('providerFilters');
    if (!container) return;

    var html = '';
    for (var j = 0; j < providersData.length; j++) {
      var p = providersData[j];
      var key = p.provider;
      var name = formatProviderName(p.provider);
      var count = p.model_count;
      html += '<label class="checkbox-item">';
      html += '<input type="checkbox" value="' + escapeAttr(key) + '" class="filter-checkbox">';
      html += '<span class="checkbox-label">' + escapeHtml(name) + ' (' + count + ')</span>';
      html += '</label>';
    }
    container.innerHTML = html;
    bindProviderFilters();
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
        searchQuery = val.toLowerCase();
        applyFilters();
      }, 200);
    });

    clearBtn.addEventListener('click', function () {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      searchQuery = '';
      applyFilters();
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
    applyFilters();
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
        applyFilters();
      });
    }
  }

  function bindAccessFilters() {
    var radios = document.querySelectorAll('.filter-radio');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () {
        selectedAccess = this.value;
        log('FILTER', 'Selected access: ' + selectedAccess);
        applyFilters();
      });
    }
  }

  function applyFilters() {
    filteredModels = modelsData.filter(function (model) {
      if (searchQuery && !matchSearch(model, searchQuery)) return false;
      if (selectedProviders.length > 0 && !matchProvider(model)) return false;
      if (selectedType && !matchType(model, selectedType)) return false;
      if (selectedAccess !== 'all' && !matchAccess(model, selectedAccess)) return false;
      return true;
    });

    log('FILTER', 'Filtered results: ' + filteredModels.length + '/' + modelsData.length);
    renderModels();
  }

  function matchSearch(model, query) {
    var name = (model.model_name || '').toLowerCase();
    var provider = (model.provider || '').toLowerCase();
    var tags = (model.tags || []).join(' ').toLowerCase();
    return name.indexOf(query) !== -1 || provider.indexOf(query) !== -1 || tags.indexOf(query) !== -1;
  }

  function matchProvider(model) {
    for (var i = 0; i < selectedProviders.length; i++) {
      if (model.provider === selectedProviders[i]) return true;
    }
    return false;
  }

  function matchType(model, type) {
    var caps = model.capabilities || {};
    if (type === '大语言模型') return !caps.multimodal && !caps.vision && !caps.audio;
    if (type === '多模态') return caps.multimodal;
    if (type === '视觉') return caps.vision && !caps.multimodal;
    if (type === '音频') return caps.audio;
    return true;
  }

  function matchAccess(model, access) {
    var provider = model.provider || '';
    var isOpenSource = provider === 'meta' || provider === 'mistral' || provider === 'deepseek';
    if (access === '开源') return isOpenSource;
    if (access === '闭源') return !isOpenSource;
    return true;
  }

  function renderModels() {
    if (filteredModels.length === 0) {
      modelsGridEl.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.querySelector('p').textContent = '未找到匹配的模型';
      return;
    }

    modelsGridEl.style.display = '';
    emptyEl.style.display = 'none';

    var html = '';
    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      html += '<div class="model-card" style="animation-delay:' + (i * 0.03) + 's">';
      html += '<div class="model-card-header">';
      html += '<h2 class="model-card-title">' + escapeHtml(m.model_name) + '</h2>';
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

  function getIconForModel(model) {
    var caps = model.capabilities || {};
    if (caps.audio) return 'mic';
    if (caps.multimodal) return 'view_in_ar';
    if (caps.vision) return 'image';
    return 'language';
  }

  function getModelDescription(model) {
    var caps = model.capabilities || {};
    var scores = model.scores || {};
    var pricing = model.pricing || {};
    var parts = [];
    
    var providerName = formatProviderName(model.provider);
    parts.push(providerName + ' · ' + formatDate(model.release_date));
    
    if (caps.context_length) {
      var ctx = formatContextLength(caps.context_length);
      parts.push(ctx + ' 上下文');
    }
    
    if (scores.overall_score != null) {
      parts.push('综合评分 ' + scores.overall_score);
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
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
