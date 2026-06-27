(function () {
  'use strict';

  var API_BASE = window.AIX_CONFIG.apiBase + '/api';

  var scenarios = [];
  var activeScenarioId = null;
  var modelsData = [];
  var exchangeRate = 7.25;
  var currentModalRowId = null;

  function log(tag, msg) {
    console.log('[AIX][CalcPro][' + tag + '] ' + msg);
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    return n.toLocaleString('en-US');
  }

  function formatCost(usd) {
    if (isNaN(usd) || usd == null) return '$0.00';
    return '$' + usd.toFixed(2);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getProviderName(provider) {
    var map = { 'openai': 'OpenAI', 'anthropic': 'Anthropic', 'aliyun': 'Aliyun', 'google': 'Google', 'meta': 'Meta', 'mistral': 'Mistral', 'deepseek': 'DeepSeek', 'zhipu': 'Zhipu', 'moonshot': 'Moonshot' };
    return map[provider] || provider;
  }

  function findModel(modelId) {
    for (var i = 0; i < modelsData.length; i++) {
      if (modelsData[i].model_id === modelId) return modelsData[i];
    }
    return null;
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  function getTaskTypeIcon(taskType) {
    var map = { '意图识别': 'filter_alt', '知识检索': 'database', '回复生成': 'edit_note', 'Intent Routing': 'filter_alt', 'RAG Retrieval': 'database', 'Response Gen': 'edit_note', '意图分类': 'filter_alt', '内容生成': 'create', '翻译': 'translate' };
    return map[taskType] || 'task';
  }

  function init() {
    log('INIT', 'Starting calculator pro');
    localStorage.removeItem('aix-calculator-pro-data');
    fetchModels();
    loadExchangeRate();

    var s = createScenario('Customer Support Bot');
    s.default = true;
    s.rows = [
      { id: generateId(), taskType: 'Intent Routing', modelId: 'gpt-4o-mini', inputTokens: 250, outputTokens: 15, dailyRequests: 10000, cacheRate: 40 },
      { id: generateId(), taskType: 'RAG Retrieval', modelId: 'gpt-4o-mini', inputTokens: 1200, outputTokens: 0, dailyRequests: 8500, cacheRate: 85 },
      { id: generateId(), taskType: 'Response Gen', modelId: 'claude-3-5-sonnet', inputTokens: 4500, outputTokens: 350, dailyRequests: 6000, cacheRate: 10 }
    ];

    var s2 = createScenario('Content Generation');
    s2.default = true;
    s2.rows = [
      { id: generateId(), taskType: 'Draft Generation', modelId: 'gpt-4o', inputTokens: 500, outputTokens: 2000, dailyRequests: 5000, cacheRate: 0 },
      { id: generateId(), taskType: 'Rewrite', modelId: 'claude-3-5-haiku', inputTokens: 1500, outputTokens: 1500, dailyRequests: 3000, cacheRate: 10 }
    ];

    var s3 = createScenario('Code Assistant');
    s3.default = true;
    s3.rows = [
      { id: generateId(), taskType: 'Code Completion', modelId: 'gpt-4o', inputTokens: 3000, outputTokens: 500, dailyRequests: 8000, cacheRate: 60 },
      { id: generateId(), taskType: 'Code Review', modelId: 'claude-sonnet-4-20250514', inputTokens: 5000, outputTokens: 800, dailyRequests: 2000, cacheRate: 20 },
      { id: generateId(), taskType: 'Bug Fix', modelId: 'o3-mini', inputTokens: 2000, outputTokens: 300, dailyRequests: 1500, cacheRate: 30 }
    ];

    activeScenarioId = s.id;
    initSwitcher();
    bindEvents();
    renderAll();
  }

  function initSwitcher() {
    var thumb = document.getElementById('switcherThumb');
    if (thumb) {
      var activeBtn = document.querySelector('.calc-switcher-track .calc-switch-btn.active');
      if (activeBtn && activeBtn.getAttribute('data-mode') === 'pro') {
        thumb.style.transform = 'translateX(calc(100%))';
      }
    }
  }

  function fetchModels() {
    log('FETCH', 'Fetching models from API');
    fetchAllModels()
      .then(function (allModels) {
        modelsData = allModels.filter(function (m) {
          var p = m.pricing || {};
          var inp = p.input_per_1m_tokens || p.input_price_per_1m_tokens || 0;
          var out = p.output_per_1m_tokens || p.output_price_per_1m_tokens || 0;
          return (inp > 0 || out > 0);
        });
        log('FETCH', 'Loaded ' + modelsData.length + ' models');
        if (activeScenarioId) renderActiveScenario();
        var modal = document.getElementById('modelSelectorModal');
        if (modal && modal.classList.contains('active')) {
          renderModelSelector(document.getElementById('modelSearchInput').value.trim().toLowerCase());
        }
      })
      .catch(function (err) {
        log('ERROR', 'Fetch models failed: ' + err.message);
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
          log('FETCH', 'Page ' + page + '/' + totalPages + ' loaded, items: ' + items.length);
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
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        var rates = (data.data && data.data.rates) || {};
        exchangeRate = rates.CNY || 7.25;
      })
      .catch(function () { exchangeRate = 7.25; });
  }

  function bindEvents() {
    var addScenarioBtn = document.getElementById('addScenarioBtn');
    if (addScenarioBtn) addScenarioBtn.addEventListener('click', function () {
      var newScenario = createScenario('New Scenario ' + (scenarios.length + 1));
      renderAll();
      log('SCENARIO', 'Created new scenario');
    });

    var editNameBtn = document.getElementById('editScenarioNameBtn');
    if (editNameBtn) editNameBtn.addEventListener('click', function () {
      var active = getActiveScenario();
      if (!active) return;
      var newName = prompt('Enter scenario name:', active.name);
      if (newName && newName.trim()) {
        active.name = newName.trim();
        renderScenarioList();
        renderScenarioName();
      }
    });

    var closeModalBtn = document.getElementById('closeModalBtn');
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);

    var modalOverlay = document.getElementById('modelSelectorModal');
    if (modalOverlay) modalOverlay.addEventListener('click', function (e) { if (e.target === modalOverlay) closeModal(); });

    var modelSearchInput = document.getElementById('modelSearchInput');
    if (modelSearchInput) {
      var searchTimeout;
      modelSearchInput.addEventListener('input', function () {
        clearTimeout(searchTimeout);
        var self = this;
        searchTimeout = setTimeout(function () { renderModelSelector(self.value.trim().toLowerCase()); }, 200);
      });
    }

    var exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportReport);
  }

  function createScenario(name) {
    var s = { id: generateId(), name: name || 'New Scenario', default: false, createdAt: new Date().toISOString(), rows: [] };
    scenarios.push(s);
    setActiveScenario(s.id);
    return s;
  }

  function renderAll() {
    renderScenarioList();
    renderActiveScenario();
  }

  function getActiveScenario() {
    for (var i = 0; i < scenarios.length; i++) { if (scenarios[i].id === activeScenarioId) return scenarios[i]; }
    return null;
  }

  function setActiveScenario(id) { activeScenarioId = id; }

  function deleteScenario(scenarioId) {
    var idx = scenarios.findIndex(function (s) { return s.id === scenarioId; });
    if (idx !== -1 && !scenarios[idx].default) {
      scenarios.splice(idx, 1);
      if (activeScenarioId === scenarioId) {
        activeScenarioId = scenarios.length > 0 ? scenarios[0].id : null;
      }
      renderScenarioList();
      renderActiveScenario();
      log('SCENARIO', 'Deleted scenario');
    }
  }

  function addRow() {
    var active = getActiveScenario();
    if (!active) return;
    active.rows.push({ id: generateId(), taskType: '', modelId: '', inputTokens: 0, outputTokens: 0, dailyRequests: 0, cacheRate: 0 });
    renderActiveScenario();
    log('ROW', 'Added row');
  }

  function deleteRow(rowId) {
    var active = getActiveScenario();
    if (!active) return;
    var idx = active.rows.findIndex(function (r) { return r.id === rowId; });
    if (idx !== -1) {
      active.rows.splice(idx, 1);
      renderActiveScenario();
      log('ROW', 'Deleted row');
    }
  }

  function updateRow(rowId, field, value) {
    var active = getActiveScenario();
    if (!active) return;
    for (var i = 0; i < active.rows.length; i++) {
      if (active.rows[i].id === rowId) {
        if (field === 'taskType' || field === 'modelId') {
          active.rows[i][field] = value;
        } else {
          active.rows[i][field] = parseFloat(value) || 0;
        }
        break;
      }
    }
    var needRender = (field === 'taskType' || field === 'modelId' || field === 'cacheRate');
    if (needRender) {
      renderTable();
    }
    recalcScenario();
  }

  function calculateRowCost(row) {
    var model = findModel(row.modelId);
    if (!model) return { unitCost: 0, dailyCost: 0, monthlyCost: 0 };
    var pricing = model.pricing || {};
    var inputPrice = pricing.input_per_1m_tokens || pricing.input_price_per_1m_tokens || 0;
    var outputPrice = pricing.output_per_1m_tokens || pricing.output_price_per_1m_tokens || 0;
    var unitCost = (row.inputTokens * inputPrice + row.outputTokens * outputPrice) / 1000000;
    var dailyCost = unitCost * row.dailyRequests * (1 - row.cacheRate / 100);
    return { unitCost: unitCost, dailyCost: dailyCost, monthlyCost: dailyCost * 30 };
  }

  function openModelSelector(rowId) {
    currentModalRowId = rowId;
    var modal = document.getElementById('modelSelectorModal');
    if (modal) {
      modal.classList.add('active');
      document.getElementById('modelSearchInput').value = '';
      renderModelSelector('');
      setTimeout(function () { document.getElementById('modelSearchInput').focus(); }, 100);
    }
  }

  function closeModal() {
    var modal = document.getElementById('modelSelectorModal');
    if (modal) modal.classList.remove('active');
    currentModalRowId = null;
  }

  function selectModel(modelId) {
    if (currentModalRowId) updateRow(currentModalRowId, 'modelId', modelId);
    closeModal();
  }

  function renderModelSelector(searchQuery) {
    var container = document.getElementById('modelSelectorList');
    if (!container) return;

    if (modelsData.length === 0) {
      container.innerHTML = '<div style="padding:2rem;text-align:center;color:#737878;font-size:0.875rem;"><span class="material-symbols-outlined" style="font-size:24px;display:block;margin-bottom:8px;">hourglass_top</span>模型数据加载中...</div>';
      return;
    }

    var filtered = searchQuery ? modelsData.filter(function (m) {
      var n = (m.model_name || m.model_id || '').toLowerCase();
      var p = (m.provider || '').toLowerCase();
      var t = (m.tags || []).join(' ').toLowerCase();
      return n.indexOf(searchQuery) !== -1 || p.indexOf(searchQuery) !== -1 || t.indexOf(searchQuery) !== -1;
    }) : modelsData;

    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding:2rem;text-align:center;color:#737878;font-size:0.875rem;">No models found</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < filtered.length && i < 50; i++) {
      var m = filtered[i];
      var pricing = m.pricing || {};
      var inputPrice = pricing.input_per_1m_tokens || pricing.input_price_per_1m_tokens || 0;
      var outputPrice = pricing.output_per_1m_tokens || pricing.output_price_per_1m_tokens || 0;
      html += '<button class="calc-pro-model-option" data-model-id="' + escapeHtml(m.model_id) + '">';
      html += '<div class="calc-pro-model-option-avatar">' + escapeHtml((m.model_id || 'M').charAt(0).toUpperCase()) + '</div>';
      html += '<div class="calc-pro-model-option-info"><div class="calc-pro-model-option-name">' + escapeHtml(m.model_name || m.model_id) + '</div>';
      html += '<div style="font-size:0.7rem;color:#737878;">' + escapeHtml(getProviderName(m.provider)) + '</div></div>';
      html += '<div style="font-family:Space Grotesk,monospace;font-size:0.7rem;color:#737878;text-align:right;">$' + inputPrice.toFixed(2) + ' / $' + outputPrice.toFixed(2) + '</div>';
      html += '</button>';
    }
    container.innerHTML = html;

    container.querySelectorAll('.calc-pro-model-option').forEach(function (el) {
      el.addEventListener('click', function () { selectModel(this.getAttribute('data-model-id')); });
    });
  }

  function renderScenarioList() {
    var container = document.getElementById('scenarioListItems');
    if (!container) return;
    if (scenarios.length === 0) { container.innerHTML = ''; return; }

    var html = '';
    for (var i = 0; i < scenarios.length; i++) {
      var s = scenarios[i];
      var isActive = s.id === activeScenarioId;
      var icon = s.rows.length > 0 ? getTaskTypeIcon(s.rows[0].taskType) : 'analytics';
      html += '<button class="calc-pro-scenario-btn' + (isActive ? ' active' : '') + '" data-scenario-id="' + escapeHtml(s.id) + '">';
      html += '<span class="material-symbols-outlined">' + icon + '</span>';
      html += '<span>' + escapeHtml(s.name) + '</span>';
      if (!s.default) {
        html += '<span class="calc-pro-scenario-delete" data-action="deleteScenario" data-scenario-id="' + escapeHtml(s.id) + '"><span class="material-symbols-outlined">close</span></span>';
      }
      html += '</button>';
    }
    container.innerHTML = html;

    container.querySelectorAll('.calc-pro-scenario-btn').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-action="deleteScenario"]')) return;
        setActiveScenario(this.getAttribute('data-scenario-id'));
        renderScenarioList();
        renderActiveScenario();
      });
    });

    container.querySelectorAll('[data-action="deleteScenario"]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteScenario(this.getAttribute('data-scenario-id'));
      });
    });
  }

  function calculateScenarioTotalCost(scenario) {
    var totalDaily = 0, rowCosts = [], maxCostIdx = 0, maxCost = 0;
    for (var i = 0; i < scenario.rows.length; i++) {
      var cost = calculateRowCost(scenario.rows[i]);
      rowCosts.push(cost);
      totalDaily += cost.dailyCost;
      if (cost.dailyCost > maxCost) { maxCost = cost.dailyCost; maxCostIdx = i; }
    }
    return { daily: totalDaily, monthly: totalDaily * 30, yearly: totalDaily * 365, rowCosts: rowCosts, maxCostIdx: maxCostIdx, maxCost: maxCost };
  }

  function renderScenarioName() {
    var el = document.getElementById('scenarioName');
    if (el) { var active = getActiveScenario(); el.textContent = active ? active.name : 'New Scenario'; }
  }

  function renderActiveScenario() {
    var active = getActiveScenario();
    if (!active) return;
    renderScenarioName();
    renderTable();
    recalcScenario();
  }

  function renderTable() {
    var tbody = document.getElementById('costTableBody');
    if (!tbody) return;
    var active = getActiveScenario();
    if (!active || active.rows.length === 0) {
      tbody.innerHTML = '<tr class="calc-pro-empty-row"><td colspan="9"><div class="calc-pro-empty-state"><span class="material-symbols-outlined">table_chart</span><p>暂无步骤，点击"Add Step"开始</p></div></td></tr>';
      return;
    }

    var html = '';
    for (var i = 0; i < active.rows.length; i++) {
      var row = active.rows[i];
      var model = findModel(row.modelId);
      var modelId = model ? (model.model_name || model.model_id) : 'Select Model';
      var hasModel = !!row.modelId;
      var taskIcon = getTaskTypeIcon(row.taskType);

      html += '<tr data-row-id="' + escapeHtml(row.id) + '">';
      html += '<td style="text-align:center;"><button class="calc-pro-delete-btn" data-action="deleteRow" data-row-id="' + escapeHtml(row.id) + '"><span class="material-symbols-outlined">delete</span></button></td>';
      html += '<td><div class="calc-pro-task-cell" data-action="editTask" data-row-id="' + escapeHtml(row.id) + '"><span>' + escapeHtml(row.taskType || 'Task Type') + '</span></div></td>';
      html += '<td><div class="calc-pro-model-cell' + (hasModel ? ' has-model' : '') + '" data-action="openModelSelector" data-row-id="' + escapeHtml(row.id) + '"><span class="calc-pro-model-cell-name">' + escapeHtml(modelId) + '</span><span class="material-symbols-outlined calc-pro-model-cell-arrow">arrow_drop_down</span></div></td>';
      html += '<td style="text-align:right;"><input type="number" class="calc-pro-input-cell" value="' + escapeHtml(String(row.inputTokens != null ? row.inputTokens : '')) + '" data-field="inputTokens" data-row-id="' + escapeHtml(row.id) + '" min="0"></td>';
      html += '<td style="text-align:right;"><input type="number" class="calc-pro-input-cell" value="' + escapeHtml(String(row.outputTokens != null ? row.outputTokens : '')) + '" data-field="outputTokens" data-row-id="' + escapeHtml(row.id) + '" min="0"></td>';
      html += '<td style="text-align:right;"><input type="number" class="calc-pro-input-cell" value="' + escapeHtml(String(row.dailyRequests != null ? row.dailyRequests : '')) + '" data-field="dailyRequests" data-row-id="' + escapeHtml(row.id) + '" min="0"></td>';
      html += '<td><div class="calc-pro-cache-cell" data-action="cycleCache" data-row-id="' + escapeHtml(row.id) + '">' + (row.cacheRate || 0) + '%</div></td>';
      html += '<td style="text-align:right;"><div class="calc-pro-cost-cell" data-field="unitCost" data-row-id="' + escapeHtml(row.id) + '">$0.00</div></td>';
      html += '<td style="text-align:right;"><div class="calc-pro-cost-cell highlight" data-field="dailyCost" data-row-id="' + escapeHtml(row.id) + '">$0.00</div></td>';
      html += '</tr>';
    }

    html += '<tr class="calc-pro-add-row"><td colspan="2"><button class="calc-pro-add-btn" id="addRowBtn"><span class="material-symbols-outlined">add_circle</span>Add Step</button></td>';
    for (var j = 2; j < 9; j++) { html += '<td></td>'; }
    html += '</tr>';

    tbody.innerHTML = html;
    bindTableEvents(tbody);

    var addRowBtnEl = document.getElementById('addRowBtn');
    if (addRowBtnEl) addRowBtnEl.addEventListener('click', function () { addRow(); });
  }

  function bindTableEvents(tbody) {
    tbody.querySelectorAll('.calc-pro-task-cell').forEach(function (el) {
      el.addEventListener('click', function () {
        var rowId = this.getAttribute('data-row-id');
        var active = getActiveScenario();
        if (!active) return;
        for (var i = 0; i < active.rows.length; i++) {
          if (active.rows[i].id === rowId) {
            var newType = prompt('Enter task type:', active.rows[i].taskType);
            if (newType !== null) updateRow(rowId, 'taskType', newType);
            break;
          }
        }
      });
    });

    tbody.querySelectorAll('.calc-pro-input-cell').forEach(function (el) {
      el.addEventListener('input', function () {
        var rowId = this.getAttribute('data-row-id');
        var field = this.getAttribute('data-field');
        updateRow(rowId, field, this.value);
      });
    });

    tbody.querySelectorAll('[data-action="openModelSelector"]').forEach(function (el) {
      el.addEventListener('click', function () { openModelSelector(this.getAttribute('data-row-id')); });
    });

    tbody.querySelectorAll('[data-action="cycleCache"]').forEach(function (el) {
      el.addEventListener('click', function () {
        var rowId = this.getAttribute('data-row-id');
        var active = getActiveScenario();
        if (!active) return;
        for (var i = 0; i < active.rows.length; i++) {
          if (active.rows[i].id === rowId) {
            var next = Math.round(((active.rows[i].cacheRate + 5) % 105) / 5) * 5;
            if (next > 100) next = 0;
            updateRow(rowId, 'cacheRate', next);
            break;
          }
        }
      });
    });

    tbody.querySelectorAll('[data-action="deleteRow"]').forEach(function (el) {
      el.addEventListener('click', function () { deleteRow(this.getAttribute('data-row-id')); });
    });
  }

  function recalcScenario() {
    var active = getActiveScenario();
    if (!active) return;
    var totalCost = calculateScenarioTotalCost(active);
    var tbody = document.getElementById('costTableBody');
    if (!tbody) return;

    for (var i = 0; i < active.rows.length; i++) {
      var row = active.rows[i];
      var cost = totalCost.rowCosts[i];
      var unitEl = tbody.querySelector('[data-field="unitCost"][data-row-id="' + row.id + '"]');
      if (unitEl) unitEl.textContent = '$' + cost.unitCost.toFixed(4);
      var dailyEl = tbody.querySelector('[data-field="dailyCost"][data-row-id="' + row.id + '"]');
      if (dailyEl) dailyEl.textContent = formatCost(cost.dailyCost);
    }

    var dailyEl = document.getElementById('totalDailyCost');
    if (dailyEl) dailyEl.textContent = formatCost(totalCost.daily);
    var monthlyEl = document.getElementById('totalMonthlyCost');
    if (monthlyEl) monthlyEl.textContent = formatCost(totalCost.monthly);
    var yearlyEl = document.getElementById('totalYearlyCost');
    if (yearlyEl) yearlyEl.textContent = formatCost(totalCost.yearly);

    renderBreakdown(active, totalCost);
    updateMaxCost(active, totalCost);
    updateInsight(active, totalCost);
  }

  function renderBreakdown(scenario, totalCost) {
    var container = document.getElementById('breakdownList');
    if (!container) return;
    if (scenario.rows.length === 0) { container.innerHTML = ''; return; }

    var html = '';
    for (var i = 0; i < scenario.rows.length; i++) {
      var row = scenario.rows[i];
      var cost = totalCost.rowCosts[i];
      var isMax = i === totalCost.maxCostIdx && totalCost.maxCost > 0;
      html += '<div class="calc-pro-breakdown-item' + (isMax ? ' max-cost' : '') + '">';
      html += '<span class="calc-pro-breakdown-item-name">' + (i + 1) + '. ' + escapeHtml(row.taskType || 'Unnamed') + '</span>';
      html += '<span class="calc-pro-breakdown-item-cost">' + formatCost(cost.dailyCost) + '</span>';
      html += '</div>';
    }
    container.innerHTML = html;
  }

  function updateMaxCost(scenario, totalCost) {
    var el = document.getElementById('maxCostStep');
    if (!el) return;
    if (scenario.rows.length === 0 || totalCost.maxCost <= 0) { el.textContent = '-'; return; }
    var maxRow = scenario.rows[totalCost.maxCostIdx];
    el.textContent = 'Step ' + (totalCost.maxCostIdx + 1) + ': ' + formatCost(totalCost.maxCost);
  }

  function updateInsight(scenario, totalCost) {
    var el = document.getElementById('insightText');
    if (!el) return;
    if (scenario.rows.length === 0) { el.textContent = 'Add steps to get optimization suggestions'; return; }

    var maxRow = scenario.rows[totalCost.maxCostIdx];
    var maxPct = totalCost.daily > 0 ? Math.round(totalCost.maxCost / totalCost.daily * 100) : 0;

    if (maxPct > 80) {
      el.textContent = 'Step ' + (totalCost.maxCostIdx + 1) + ' accounts for ' + maxPct + '% of daily cost. Consider using a more cost-effective model.';
    } else if (maxRow.cacheRate < 20 && maxRow.inputTokens > 500) {
      el.textContent = 'Step ' + (totalCost.maxCostIdx + 1) + ' has high input tokens. Enable caching to reduce costs. Target 30%+ cache hit rate.';
    } else {
      el.textContent = 'Configuration looks reasonable. Consider adjusting high-cost step models or reducing call volume for further optimization.';
    }
  }

  function exportReport() {
    var active = getActiveScenario();
    if (!active) return;
    var totalCost = calculateScenarioTotalCost(active);
    var report = 'AI Scenario Cost Report - ' + active.name + '\n';
    report += 'Generated: ' + new Date().toLocaleString('zh-CN') + '\n\n';
    report += '=== Summary ===\n';
    report += 'Daily: ' + formatCost(totalCost.daily) + '\nMonthly: ' + formatCost(totalCost.monthly) + '\nYearly: ' + formatCost(totalCost.yearly) + '\n';
    report += 'Max Cost Step: ' + (totalCost.maxCostIdx + 1) + ' (' + (active.rows[totalCost.maxCostIdx].taskType || 'Unnamed') + ') - ' + formatCost(totalCost.maxCost) + '/day\n\n';
    report += '=== Breakdown ===\n';
    for (var i = 0; i < active.rows.length; i++) {
      var row = active.rows[i];
      var cost = totalCost.rowCosts[i];
      var model = findModel(row.modelId);
      report += '\nStep ' + (i + 1) + ': ' + (row.taskType || 'Unnamed') + '\n';
      report += '  Model: ' + (model ? (model.model_name || model.model_id) : 'Not selected') + '\n';
      report += '  Input: ' + formatNumber(row.inputTokens) + ' | Output: ' + formatNumber(row.outputTokens) + '\n';
      report += '  Daily Requests: ' + formatNumber(row.dailyRequests) + ' | Cache: ' + row.cacheRate + '%\n';
      report += '  Unit Cost: ' + formatCost(cost.unitCost) + ' | Daily: ' + formatCost(cost.dailyCost) + '\n';
    }
    var blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cost-report-' + active.name + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log('EXPORT', 'Report exported');
  }



  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
