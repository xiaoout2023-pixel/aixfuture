(function () {
  'use strict';

  var API_BASE = 'https://www.aixfutrueapi.top/api';
  var modelsData = [];
  var filteredModels = [];
  var searchQuery = '';
  var selectedTaskType = 'text';
  var inputTokens = 4096;
  var outputTokens = 1024;
  var dailyRequests = 50000;

  var modelListEl, loadingEl, emptyEl, searchInput, clearBtn;
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

    var missingElements = [];
    if (!modelListEl) missingElements.push('modelList');
    if (!loadingEl) missingElements.push('calcLoading');
    if (!emptyEl) missingElements.push('calcEmpty');
    if (!searchInput) missingElements.push('modelSearch');
    if (!inputSlider) missingElements.push('inputTokens');
    if (!outputSlider) missingElements.push('outputTokens');
    if (!dailySlider) missingElements.push('dailyRequests');
    if (!totalCostEl) missingElements.push('totalCost');
    if (!modelCountEl) missingElements.push('modelCount');

    if (missingElements.length > 0) {
      log('ERROR', 'Missing DOM elements: ' + missingElements.join(', '));
      return;
    }

    log('INIT', 'All DOM elements found');
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
        log('SORT', 'Sort by: ' + currentSortBy);
        applyFilters();
      });
    }
  }

  function fetchData() {
    log('FETCH', 'Fetching models from API');
    loadingEl.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';

    fetch(API_BASE + '/models?page_size=100')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var allModels = data.data || [];
        log('FETCH', 'Received ' + allModels.length + ' models');

        modelsData = allModels.filter(function(m) {
          var pricing = m.pricing || {};
          return pricing.input_price_per_1m_tokens || pricing.output_price_per_1m_tokens;
        });

        log('FETCH', 'Models with pricing: ' + modelsData.length);

        if (modelsData.length > 0) {
          var sample = modelsData[0];
          log('FETCH', 'Sample - name: ' + sample.model_name + ', pricing: ' + JSON.stringify(sample.pricing) + ', caps: ' + JSON.stringify(sample.capabilities));
        }

        loadingEl.style.display = 'none';
        filteredModels = modelsData.slice();
        loadExchangeRate();
        applyFilters();
        log('FETCH', 'Done');
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
        applyFilters();
      }, 200);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        searchInput.value = '';
        searchQuery = '';
        clearBtn.classList.remove('visible');
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
        log('TASK', 'Selected: ' + selectedTaskType);
        applyFilters();
      });
    }
  }

  function applyFilters() {
    filteredModels = modelsData.filter(function (model) {
      if (searchQuery && !matchSearch(model, searchQuery)) return false;
      var caps = model.capabilities || {};
      if (selectedTaskType === 'text' && !caps.text_generation) return false;
      if (selectedTaskType === 'code' && !caps.code_generation) return false;
      if (selectedTaskType === 'vision' && !caps.vision && !caps.multimodal) return false;
      return true;
    });

    log('FILTER', filteredModels.length + '/' + modelsData.length);
    renderModels();
    recalcAll();
  }

  function matchSearch(model, query) {
    var name = (model.model_name || '').toLowerCase();
    var provider = (model.provider || '').toLowerCase();
    var tags = (model.tags || []).join(' ').toLowerCase();
    return name.indexOf(query) !== -1 || provider.indexOf(query) !== -1 || tags.indexOf(query) !== -1;
  }

  function calculateCost(model) {
    var pricing = model.pricing || {};
    var inputPrice = pricing.input_price_per_1m_tokens || 0;
    var outputPrice = pricing.output_price_per_1m_tokens || 0;

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
    var costCache = {};
    var selectedModel = null;

    for (var i = 0; i < filteredModels.length; i++) {
      var m = filteredModels[i];
      var cost = calculateCost(m);
      costCache[i] = cost;
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
    updateModelCosts(costCache);
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

  function updateModelCosts(costCache) {
    var cards = modelListEl.querySelectorAll('.calc-model-card');
    for (var i = 0; i < cards.length; i++) {
      var costEl = cards[i].querySelector('.calc-model-cost');
      if (costEl && costCache[i] != null) {
        var cost = costCache[i];
        costEl.textContent = '$' + formatNumber(Math.round(cost.total));
      }
    }
  }

  function renderModels() {
    if (filteredModels.length === 0) {
      if (emptyEl) emptyEl.style.display = '';
      if (emptyEl) emptyEl.querySelector('p').textContent = searchQuery ? '未找到匹配的模型' : '当前任务类型没有可用模型';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    var cheapestModel = null;
    var cheapestCost = Infinity;
    var costCache = {};
    var displayModels = filteredModels.slice();

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
        return (a.model_name || '').localeCompare(b.model_name || '');
      });
    }

    for (var i = 0; i < displayModels.length; i++) {
      var cost = calculateCost(displayModels[i]);
      costCache[i] = cost;
      if (cost.total < cheapestCost) {
        cheapestCost = cost.total;
        cheapestModel = displayModels[i];
      }
    }

    var html = '';
    for (var i = 0; i < displayModels.length; i++) {
      var m = displayModels[i];
      var cost = costCache[i];
      var isCheapest = (m === cheapestModel);
      var providerName = getProviderName(m.provider);
      var initialLetter = (m.model_name || 'M').charAt(0).toUpperCase();
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
      html += '<div class="calc-model-name">' + escapeHtml(m.model_name);
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
        html += '<span>Intelligence Score</span>';
        html += '<span class="calc-perf-value">' + score + '/100</span>';
        html += '</div>';
        html += '<div class="calc-perf-bar">';
        html += '<div class="calc-perf-fill' + (score < 85 ? ' low' : '') + '" style="width:' + Math.min(score, 100) + '%"></div>';
        html += '</div>';
        html += '<div class="calc-model-features">' + escapeHtml(features.join(' \u2022 ')) + '</div>';
        html += '</div>';
      } else {
        html += '<div class="calc-model-perf">';
        html += '<div class="calc-perf-header">';
        html += '<span>暂无评分</span>';
        html += '</div>';
        html += '<div class="calc-model-features">' + escapeHtml(features.join(' \u2022 ')) + '</div>';
        html += '</div>';
      }

      html += '<div class="calc-model-cost' + (isCheapest ? '' : ' default') + '">';
      html += '$' + formatNumber(Math.round(cost.total));
      html += '</div>';

      html += '<div class="calc-model-action">';
      html += '<button class="calc-btn calc-btn-secondary">选择</button>';
      html += '</div>';

      html += '</div>';
    }

    modelListEl.innerHTML = html;

    var buttons = modelListEl.querySelectorAll('.calc-btn');
    for (var j = 0; j < buttons.length; j++) {
      var btnModelId = displayModels[j] ? displayModels[j].model_id : null;
      var isSelected = selectedModelId === btnModelId;
      
      if (isSelected) {
        var card = modelListEl.querySelectorAll('.calc-model-card')[j];
        var btn = buttons[j];
        if (card) card.classList.add('selected');
        if (btn) {
          btn.setAttribute('data-selected', 'true');
          btn.textContent = '已选择';
          btn.className = 'calc-btn calc-btn-primary';
        }
      }
      
      buttons[j].addEventListener('click', (function(cardIndex) {
        return function () {
          var btn = this;
          var isSelected = btn.getAttribute('data-selected') === 'true';
          
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
          
          if (!isSelected && displayModels[cardIndex]) {
            selectedModelId = displayModels[cardIndex].model_id;
            cards[cardIndex].classList.add('selected');
            btn.setAttribute('data-selected', 'true');
            btn.textContent = '已选择';
            btn.className = 'calc-btn calc-btn-primary';
            recalcAll();
            log('SELECT', '选择: ' + displayModels[cardIndex].model_name);
          } else {
            selectedModelId = null;
            recalcAll();
            log('SELECT', '取消选择');
          }
        };
      })(j));
    }
  }

  function formatContextLength(tokens) {
    if (tokens >= 1000000) return (tokens / 1000000).toFixed(0) + 'M';
    if (tokens >= 1000) return (tokens / 1000).toFixed(0) + 'K';
    return tokens.toString();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
