(function () {
  'use strict';

  var API_BASE = window.AIX_CONFIG.apiBase + '/api';
  var modelsData = [];
  var filteredModels = [];
  var displayModels = [];
  var searchQuery = '';
  var selectedTaskType = 'text';
  var inputTokens = 4096;
  var outputTokens = 1024;
  var dailyRequests = 50000;
  var currentPage = 1;
  var PAGE_SIZE = 20;

  var modelListEl, loadingEl, emptyEl, searchInput, clearBtn, paginationEl;
  var inputSlider, outputSlider, dailySlider;
  var inputTokenValueEl, outputTokenValueEl, dailyRequestsValueEl;
  var totalCostEl, inputCostEl, outputCostEl, modelCountEl, tipTextEl;

  var exchangeRate = 7.25;
  var selectedModelId = null;
  var currentSortBy = 'cost';

  function log(tag, message) {
    var timestamp = new Date().toISOString().substring(11, 23);
    console.log('[AIX][Calc][' + tag + '] ' + message);
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    return n.toLocaleString('en-US');
  }

  function formatCost(usd) {
    if (isNaN(usd) || usd == null) return '$0.00';
    return '$' + usd.toFixed(2) + ' (¥' + (usd * exchangeRate).toFixed(2) + ')';
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getProviderName(provider) {
    var nameMap = {
      'openai': 'OpenAI',
      'anthropic': 'Anthropic',
      'aliyun': '阿里云',
      'google': 'Google',
      'meta': 'Meta',
      'mistral': 'Mistral AI',
      'deepseek': '深度求索',
      'zhipu': '智谱AI',
      'moonshot': '月之暗面',
      'stability': 'Stability AI'
    };
    return nameMap[provider] || provider;
  }

  function init() {
    log('INIT', 'Starting calculator page');

    modelListEl = document.getElementById('modelList');
    loadingEl = document.getElementById('calcLoading');
    emptyEl = document.getElementById('calcEmpty');
    searchInput = document.getElementById('modelSearch');
    clearBtn = document.getElementById('clearSearch');
    paginationEl = document.getElementById('calcPagination');
    inputSlider = document.getElementById('inputTokens');
    outputSlider = document.getElementById('outputTokens');
    dailySlider = document.getElementById('dailyRequests');
    inputTokenValueEl = document.getElementById('inputTokenValue');
    outputTokenValueEl = document.getElementById('outputTokenValue');
    dailyRequestsValueEl = document.getElementById('dailyRequestsValue');
    totalCostEl = document.getElementById('totalCost');
    inputCostEl = document.getElementById('inputCost');
    outputCostEl = document.getElementById('outputCost');
    modelCountEl = document.getElementById('modelCount');
    tipTextEl = document.getElementById('tipText');

    bindSliders();
    bindSearch();
    bindTaskTypeChips();
    bindSort();
    fetchData();
  }

  function bindSort() {
    var sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        currentSortBy = this.value;
        currentPage = 1;
        applyFilters();
      });
    }
  }

  function fetchData() {
    log('FETCH', 'Fetching models from API');
    loadingEl.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';

    fetchAllModels()
      .then(function (allModels) {
        log('FETCH', 'Received ' + allModels.length + ' models');

        modelsData = allModels.filter(function(m) {
          var pricing = m.pricing || {};
          var inp = pricing.input_per_1m_tokens || pricing.input_price_per_1m_tokens || 0;
          var out = pricing.output_per_1m_tokens || pricing.output_price_per_1m_tokens || 0;
          return (inp > 0 || out > 0);
        });

        log('FETCH', 'Models with pricing: ' + modelsData.length);
        loadingEl.style.display = 'none';
        filteredModels = modelsData.slice();
        loadExchangeRate();
        applyFilters();
      })
      .catch(function (err) {
        log('ERROR', 'Fetch failed: ' + err.message);
        loadingEl.style.display = 'none';
        if (emptyEl) {
          emptyEl.style.display = '';
          emptyEl.querySelector('p').textContent = '数据加载失败: ' + err.message;
        }
      });
  }

  function fetchAllModels() {
    var allModels = [];
    var page = 1;
    var pageSize = 100;

    function fetchPage() {
      var url = API_BASE + '/models?page=' + page + '&page_size=' + pageSize;
      return fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          var items = data.data || [];
          allModels = allModels.concat(items);
          var totalPages = data.total_pages || Math.ceil((data.total || 0) / pageSize);
          if (page < totalPages) {
            page++;
            return fetchPage();
          }
          return allModels;
        });
    }

    return fetchPage();
  }

  function loadExchangeRate() {
    fetch(API_BASE + '/exchange-rate')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var rates = (data.data && data.data.rates) || {};
        exchangeRate = rates.CNY || 7.25;
        log('FETCH', 'Exchange rate: 1 USD = ' + exchangeRate + ' CNY');
      })
      .catch(function (err) {
        log('ERROR', 'Exchange rate failed: ' + err.message);
        exchangeRate = 7.25;
      });
  }

  function bindSliders() {
    inputSlider.addEventListener('input', function () {
      inputTokens = parseInt(this.value, 10) || 0;
      inputTokenValueEl.textContent = formatNumber(inputTokens);
      recalcAll();
    });

    outputSlider.addEventListener('input', function () {
      outputTokens = parseInt(this.value, 10) || 0;
      outputTokenValueEl.textContent = formatNumber(outputTokens);
      recalcAll();
    });

    dailySlider.addEventListener('input', function () {
      dailyRequests = parseInt(this.value, 10) || 0;
      dailyRequestsValueEl.textContent = formatNumber(dailyRequests);
      recalcAll();
    });
  }

  function bindSearch() {
    var timeout;
    searchInput.addEventListener('input', function () {
      clearTimeout(timeout);
      var val = searchInput.value.trim();
      if (clearBtn) {
        clearBtn.classList.toggle('visible', val.length > 0);
      }
      timeout = setTimeout(function () {
        searchQuery = val.toLowerCase();
        currentPage = 1;
        applyFilters();
      }, 200);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        searchInput.value = '';
        searchQuery = '';
        clearBtn.classList.remove('visible');
        currentPage = 1;
        applyFilters();
        searchInput.focus();
      });
    }
  }

  function bindTaskTypeChips() {
    var chips = document.querySelectorAll('#taskTypeChips .calc-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        for (var j = 0; j < chips.length; j++) {
          chips[j].classList.remove('active');
        }
        this.classList.add('active');
        selectedTaskType = this.getAttribute('data-task');
        currentPage = 1;
        applyFilters();
      });
    }
  }

  function applyFilters() {
    filteredModels = modelsData.filter(function (model) {
      if (searchQuery && !matchSearch(model, searchQuery)) return false;
      var caps = model.capabilities || {};
      var hasText = caps.text_generation === true || caps.text_generation == null;
      var hasCode = caps.code_generation === true || caps.code_generation == null;
      var hasVision = caps.vision === true || caps.multimodal === true;
      if (selectedTaskType === 'text' && !hasText) return false;
      if (selectedTaskType === 'code' && !hasCode) return false;
      if (selectedTaskType === 'vision' && !hasVision) return false;
      return true;
    });

    sortFiltered();
    renderModels();
    renderPagination();
    recalcAll();
  }

  function sortFiltered() {
    displayModels = filteredModels.slice();

    if (currentSortBy === 'cost') {
      displayModels.sort(function(a, b) {
        return calculateCost(a).total - calculateCost(b).total;
      });
    } else if (currentSortBy === 'score') {
      displayModels.sort(function(a, b) {
        return ((b.scores && b.scores.overall_score) || 0) - ((a.scores && a.scores.overall_score) || 0);
      });
    } else if (currentSortBy === 'name') {
      displayModels.sort(function(a, b) {
        return (a.model_id || '').localeCompare(b.model_id || '');
      });
    }
  }

  function matchSearch(model, query) {
    var name = (model.model_id || '').toLowerCase();
    var provider = (model.provider || '').toLowerCase();
    var tags = (model.tags || []).join(' ').toLowerCase();
    return name.indexOf(query) !== -1 || provider.indexOf(query) !== -1 || tags.indexOf(query) !== -1;
  }

  function calculateCost(model) {
    var pricing = model.pricing || {};
    var inputPrice = pricing.input_per_1m_tokens || pricing.input_price_per_1m_tokens || 0;
    var outputPrice = pricing.output_per_1m_tokens || pricing.output_price_per_1m_tokens || 0;

    var monthlyInputCost = (inputTokens * dailyRequests / 1000000) * inputPrice * 30;
    var monthlyOutputCost = (outputTokens * dailyRequests / 1000000) * outputPrice * 30;

    return {
      input: monthlyInputCost,
      output: monthlyOutputCost,
      total: monthlyInputCost + monthlyOutputCost
    };
  }

  function recalcAll() {
    if (filteredModels.length === 0) {
      if (totalCostEl) totalCostEl.textContent = '0.00';
      if (inputCostEl) inputCostEl.textContent = '$0.00';
      if (outputCostEl) outputCostEl.textContent = '$0.00';
      if (modelCountEl) modelCountEl.textContent = '0';
      return;
    }

    var cheapestModel = null;
    var cheapestCost = Infinity;
    var selectedModel = null;

    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      var cost = calculateCost(m);
      if (cost.total < cheapestCost) {
        cheapestCost = cost.total;
        cheapestModel = m;
      }
      if (selectedModelId && m.model_id === selectedModelId) {
        selectedModel = m;
      }
    }

    var displayModel = selectedModel || cheapestModel;
    var displayCost = displayModel ? calculateCost(displayModel) : { input: 0, output: 0, total: 0 };

    if (totalCostEl) totalCostEl.textContent = displayCost.total.toFixed(2);
    if (inputCostEl) inputCostEl.textContent = formatCost(displayCost.input);
    if (outputCostEl) outputCostEl.textContent = formatCost(displayCost.output);
    if (modelCountEl) modelCountEl.textContent = filteredModels.length;

    updateOptimizationTip();
  }

  function updateOptimizationTip() {
    if (!tipTextEl) return;

    if (inputTokens > 10000) {
      tipTextEl.textContent = '使用支持缓存的模型可以降低最多45%的输入token成本。';
    } else if (outputTokens > 4000) {
      tipTextEl.textContent = '批量处理请求可以减少API调用次数，优化成本。';
    } else if (dailyRequests > 100000) {
      tipTextEl.textContent = '高流量场景建议选择性价比更高的开源模型。';
    } else {
      tipTextEl.textContent = '选择更小的模型可以显著降低成本。';
    }
  }

  function renderModels() {
    if (displayModels.length === 0) {
      if (emptyEl) emptyEl.style.display = '';
      if (emptyEl) emptyEl.querySelector('p').textContent = searchQuery ? '未找到匹配的模型' : '当前任务类型没有可用模型';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    var totalPages = Math.ceil(displayModels.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    var start = (currentPage - 1) * PAGE_SIZE;
    var end = Math.min(start + PAGE_SIZE, displayModels.length);
    var pageModels = displayModels.slice(start, end);

    var cheapestModel = null;
    var cheapestCost = Infinity;
    for (var c = 0; c < displayModels.length; c++) {
      var cc = calculateCost(displayModels[c]);
      if (cc.total < cheapestCost) {
        cheapestCost = cc.total;
        cheapestModel = displayModels[c];
      }
    }

    var html = '';
    for (var i = 0; i < pageModels.length; i++) {
      var m = pageModels[i];
      var cost = calculateCost(m);
      var isCheapest = (m === cheapestModel);
      var providerName = getProviderName(m.provider);
      var initialLetter = (m.model_id || 'M').charAt(0).toUpperCase();
      var caps = m.capabilities || {};
      var contextWindow = caps.context_length ? formatContextLength(caps.context_length) : '';
      var features = [];

      if (caps.vision) features.push('Vision');
      if (caps.multimodal) features.push('Multimodal');
      if (caps.audio) features.push('Audio');
      if (caps.tool_calling) features.push('Tool');
      if (caps.context_length) features.push(contextWindow + ' Context');
      if (caps.reasoning_level === 'high') features.push('Reasoning');

      var hasScore = m.scores && m.scores.overall_score != null;
      var score = hasScore ? Math.round(m.scores.overall_score) : null;

      html += '<div class="calc-model-card' + (isCheapest ? ' recommended' : '') + '">';
      html += '<div class="calc-model-info">';
      html += '<div class="calc-model-avatar">' + escapeHtml(initialLetter) + '</div>';
      html += '<div class="calc-model-meta">';
      html += '<div class="calc-model-name">' + escapeHtml(m.model_id);
      if (isCheapest) {
        html += '<span class="calc-badge">RECOMMENDED</span>';
      }
      html += '</div>';
      html += '<div class="calc-model-provider">' + escapeHtml(providerName) + '</div>';
      html += '</div>';
      html += '</div>';

      if (hasScore) {
        html += '<div class="calc-model-perf">';
        html += '<div class="calc-perf-header">';
        html += '<span>综合评分</span>';
        html += '<span class="calc-perf-value">' + score + '/100</span>';
        html += '</div>';
        html += '<div class="calc-perf-bar">';
        html += '<div class="calc-perf-fill' + (score < 85 ? ' low' : '') + '" style="width:' + Math.min(score, 100) + '%"></div>';
        html += '</div>';
        html += '<div class="calc-model-features">';
        for (var fi = 0; fi < features.length; fi++) {
          html += '<span class="calc-feature-tag">' + escapeHtml(features[fi]) + '</span>';
        }
        html += '</div>';
        html += '</div>';
      } else {
        html += '<div class="calc-model-perf">';
        html += '<div class="calc-perf-header">';
        html += '<span>暂无评分</span>';
        html += '</div>';
        html += '<div class="calc-model-features">';
        for (var fi2 = 0; fi2 < features.length; fi2++) {
          html += '<span class="calc-feature-tag">' + escapeHtml(features[fi2]) + '</span>';
        }
        html += '</div>';
        html += '</div>';
      }

      html += '<div class="calc-model-cost' + (isCheapest ? '' : ' default') + '">';
      html += '$' + formatNumber(Math.round(cost.total));
      html += '</div>';

      html += '<div class="calc-model-action">';
      html += '<button class="calc-btn calc-btn-secondary" data-model-id="' + escapeHtml(m.model_id) + '">选择</button>';
      html += '</div>';

      html += '</div>';
    }

    modelListEl.innerHTML = html;

    var buttons = modelListEl.querySelectorAll('.calc-btn');
    for (var j = 0; j < buttons.length; j++) {
      var btnModelId = buttons[j].getAttribute('data-model-id');
      var isSelected = selectedModelId === btnModelId;

      if (isSelected) {
        var card = buttons[j].closest('.calc-model-card');
        if (card) card.classList.add('selected');
        buttons[j].setAttribute('data-selected', 'true');
        buttons[j].textContent = '已选择';
        buttons[j].className = 'calc-btn calc-btn-primary';
      }

      buttons[j].addEventListener('click', function () {
        var clickedModelId = this.getAttribute('data-model-id');
        var isCurrentlySelected = this.getAttribute('data-selected') === 'true';

        var cards = modelListEl.querySelectorAll('.calc-model-card');
        for (var k = 0; k < cards.length; k++) {
          cards[k].classList.remove('selected');
          var b = cards[k].querySelector('.calc-btn');
          if (b) {
            b.setAttribute('data-selected', 'false');
            b.textContent = '选择';
            b.className = 'calc-btn calc-btn-secondary';
          }
        }

        if (!isCurrentlySelected) {
          selectedModelId = clickedModelId;
          var clickedCard = this.closest('.calc-model-card');
          if (clickedCard) clickedCard.classList.add('selected');
          this.setAttribute('data-selected', 'true');
          this.textContent = '已选择';
          this.className = 'calc-btn calc-btn-primary';
          recalcAll();
        } else {
          selectedModelId = null;
          recalcAll();
        }
      });
    }
  }

  function renderPagination() {
    if (!paginationEl) return;

    var totalPages = Math.ceil(displayModels.length / PAGE_SIZE);
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
        if (isNaN(page) || page < 1) return;
        var totalPages = Math.ceil(displayModels.length / PAGE_SIZE);
        if (page > totalPages) return;
        currentPage = page;
        renderModels();
        renderPagination();
        modelListEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function formatContextLength(tokens) {
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(0) + 'M';
    if (tokens >= 1000) return (tokens / 1000).toFixed(0) + 'K';
    return tokens.toString();
  }

  function initSwitcherThumb() {
    var thumb = document.getElementById('switcherThumb');
    if (!thumb) return;
    var activeBtn = document.querySelector('.calc-switcher-track .calc-switch-btn.active');
    if (activeBtn) {
      var track = activeBtn.parentElement;
      var btns = track.querySelectorAll('.calc-switch-btn');
      var idx = Array.prototype.indexOf.call(btns, activeBtn);
      if (idx === 1) {
        thumb.style.transform = 'translateX(calc(100%))';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      init();
      initSwitcherThumb();
    });
  } else {
    init();
    initSwitcherThumb();
  }
})();
