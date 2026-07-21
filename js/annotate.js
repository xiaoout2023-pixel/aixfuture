/*!
 * AIX未来视野 - EGO 数据标注工具核心框架 (annotate.js)
 * 阶段 1：核心状态管理 / 步骤导航 / Tab 切换 / 快捷键 / localStorage 持久化
 * 阶段 2：视频文件加载 / 自定义播放器 / 元信息表单校验
 *
 * 暴露 API：window.AIX_ANNOTATE
 *  - state: 全局状态
 *  - log(tag, message): 统一日志
 *  - goToStep(step): 切换步骤
 *  - nextStep() / prevStep(): 步骤导航
 *  - switchTab(tab): 切换标注 Tab
 *  - saveToLocalStorage(): 持久化
 *  - loadFromLocalStorage(): 读取
 *  - clearAnnotations(): 清空标注（含二次确认）
 *  - handleFileSelect(file): 处理视频文件加载
 *  - handleDrop(e): 拖拽事件处理
 *  - detectVideoMetadata(callback): 检测视频分辨率/时长/FPS
 *  - togglePlay(): 播放/暂停
 *  - stepFrame(direction): 逐帧前进/后退
 *  - goToFramePrompt(): 弹窗跳转指定帧
 *  - cyclePlaybackRate(): 倍速循环
 *  - toggleFullscreen(): 全屏切换
 *  - updateFrameDisplay(): 更新帧号/时间戳/进度条显示
 *  - validateMetaForm(): 元信息表单校验
 *  - onFrameChange / onTabChange / redrawCanvas: 回调钩子（供 annotate-canvas.js 注册）
 */
(function () {
  'use strict';

  // ===== i18n 兜底（与 models.js 一致） =====
  function tt(key, fallback) {
    try {
      if (typeof t === 'function') return t(key, fallback);
    } catch (e) {}
    return fallback != null ? fallback : key;
  }

  // ===== 常量 =====
  var STORAGE_KEY = 'aix_annotate_state';
  var TOTAL_STEPS = 5;
  var TAB_KEYS = ['hand_detection', 'keypoints', 'action', 'hand_object'];
  var PLAYBACK_SPEEDS = [1, 2, 0.5, 0.25];
  var SUPPORTED_VIDEO_EXTS = ['mp4', 'mov', 'avi'];
  var MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

  // ===== 全局状态 =====
  var state = {
    currentStep: 1,            // 1=上传, 2=元信息, 3=标注, 4=预览, 5=导出
    currentFrame: 0,
    totalFrames: 0,
    fps: 30,
    videoFile: null,           // 仅保存文件名等元信息，不保存 File 对象（不可序列化）
    videoFileName: '',
    videoFileSize: 0,
    videoUrl: null,            // 运行时 URL（不持久化）
    videoDuration: 0,
    videoResolution: [0, 0],
    isPlaying: false,
    playbackSpeedIdx: 0,
    meta: {
      scene_type: '',
      device: '',
      collector: '',
      date: '',
      fps: 30,
      resolution: [0, 0],
      remark: ''
    },
    activeTab: 'hand_detection',  // hand_detection / keypoints / action / hand_object
    annotations: {
      hand_detection: [],
      hand_keypoints: [],
      action_segmentation: { labels: [], segments: [] },
      hand_object: [],
      objects: []                  // 物体框
    },
    selectedIds: { hand: null, keypoint: null, segment: null, relation: null, object: null },
    history: [],                    // 撤销栈
    historyIndex: -1                // 重做栈指针（-1 表示无历史）
  };

  // ===== DOM 缓存 =====
  var dom = {
    steps: null,
    stepContents: [],
    prevBtn: null,
    nextBtn: null,
    stepNavInfo: null,
    tabs: null,
    tabBtns: [],
    panelTitle: null,
    panelCount: null,
    panelList: null,
    panelEmpty: null,
    frameLabel: null,
    speedLabel: null,
    clearBtn: null,
    playBtn: null,
    prevFrameBtn: null,
    nextFrameBtn: null,
    goToBtn: null,
    speedBtn: null,
    fullscreenBtn: null,
    uploadZone: null,
    fileInput: null,
    fileSelectBtn: null,
    fileInfo: null,
    fileName: null,
    fileMeta: null,
    removeFileBtn: null,
    video: null,
    canvas: null,
    emptyHint: null,
    timeline: null,
    timelineCanvas: null,
    timelineCursor: null,
    addBtn: null,
    timeLabel: null,
    progress: null,
    // 元信息表单
    sceneTypeInput: null,
    deviceInput: null,
    collectorInput: null,
    dateInput: null,
    fpsInput: null,
    resolutionInput: null,
    remarkInput: null,
    // 预览
    previewVideo: null,
    previewCanvas: null,
    previewPlayBtn: null,
    previewSpeedBtn: null,        // 阶段 9：倍速按钮
    previewProgress: null,        // 阶段 9：进度条
    previewBackBtn: null,         // 阶段 9：返回标注按钮
    previewSpeedLabel: null,      // 阶段 9：倍速标签
    previewTime: null,            // 阶段 9：时间显示
    previewShowHand: null,
    previewShowKeypoint: null,
    previewShowAction: null,
    previewShowHandObject: null,
    // 导出
    statHand: null,
    statKeypoint: null,
    statSegment: null,
    statRelation: null,
    statObjects: null,
    statFrames: null,
    statDuration: null,
    // 阶段 10：HDF5 / JSON 导出按钮（ID 与 HTML 一致）
    exportHdf5Btn: null,
    exportJsonBtn: null,
    exportCocoBtn: null,
    exportCsvBtn: null,
    // 弹窗
    modal: null,
    modalOverlay: null,
    modalContent: null,
    modalTitle: null,
    modalBody: null,
    modalCloseBtn: null,
    modalCancelBtn: null,
    modalConfirmBtn: null,
    modalConfirmCallback: null,
    // 阶段 7：手物交互面板
    handObjectPanel: null,
    addRelationBtn: null,
    objectsList: null,
    relationsList: null,
    handObjectHint: null,
    // 阶段 8：导入标注按钮
    importAnnotationsBtn: null
  };

  // ===== 日志函数 =====
  function log(tag, message) {
    var timestamp = new Date().toISOString().substring(11, 23);
    try {
      console.log('[AIX][Annotate][' + tag + '][' + timestamp + '] ' + message);
    } catch (e) {
      // console 不可用时降级（不阻断主流程）
    }
  }

  // ===== DOM 就绪辅助 =====
  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  // ===== 工具：安全 querySelector =====
  function qs(id) {
    try {
      return document.getElementById(id);
    } catch (e) {
      log('ERROR', 'getElementById failed for ' + id + ': ' + (e.message || e));
      return null;
    }
  }

  // ===== 工具：安全 querySelectorAll =====
  function qsa(selector, root) {
    try {
      return (root || document).querySelectorAll(selector);
    } catch (e) {
      log('ERROR', 'querySelectorAll failed for "' + selector + '": ' + (e.message || e));
      return [];
    }
  }

  // ===== 初始化 DOM 缓存 =====
  function cacheDom() {
    dom.steps = qs('annotateSteps');
    dom.stepContents = [
      qs('annotateStep1'),
      qs('annotateStep2'),
      qs('annotateStep3'),
      qs('annotateStep4'),
      qs('annotateStep5')
    ];
    dom.prevBtn = qs('annotatePrevBtn');
    dom.nextBtn = qs('annotateNextBtn');
    dom.stepNavInfo = qs('annotateStepNavInfo');
    dom.tabs = qs('annotateTabs');
    dom.tabBtns = Array.prototype.slice.call(qsa('.annotate-tab', dom.tabs));
    dom.panelTitle = qs('annotatePanelTitle');
    dom.panelCount = qs('annotatePanelCount');
    dom.panelList = qs('annotatePanelList');
    dom.panelEmpty = qs('annotatePanelEmpty');
    dom.frameLabel = qs('annotateFrameLabel');
    dom.speedLabel = qs('annotateSpeedLabel');
    dom.clearBtn = qs('annotateClearBtn');
    dom.playBtn = qs('annotatePlayBtn');
    dom.prevFrameBtn = qs('annotatePrevFrameBtn');
    dom.nextFrameBtn = qs('annotateNextFrameBtn');
    dom.goToBtn = qs('annotateGoToBtn');
    dom.speedBtn = qs('annotateSpeedBtn');
    dom.fullscreenBtn = qs('annotateFullscreenBtn');
    dom.uploadZone = qs('annotateUploadZone');
    dom.fileInput = qs('annotateFileInput');
    dom.fileSelectBtn = qs('annotateSelectFileBtn');
    dom.fileInfo = qs('annotateFileInfo');
    dom.fileName = qs('annotateFileName');
    dom.fileMeta = qs('annotateFileMeta');
    dom.removeFileBtn = qs('annotateRemoveFileBtn');
    dom.video = qs('annotateVideo');
    dom.canvas = qs('annotateCanvas');
    dom.emptyHint = qs('annotateEmptyHint');
    dom.timeline = qs('annotateTimeline');
    dom.timelineCanvas = qs('annotateTimelineCanvas');
    dom.timelineCursor = qs('annotateTimelineCursor');
    dom.addBtn = qs('annotateAddBtn');
    dom.timeLabel = qs('annotateTimeLabel');
    dom.progress = qs('annotateProgress');
    dom.sceneTypeInput = qs('annotateSceneType');
    dom.deviceInput = qs('annotateDevice');
    dom.collectorInput = qs('annotateCollector');
    dom.dateInput = qs('annotateDate');
    dom.fpsInput = qs('annotateFps');
    dom.resolutionInput = qs('annotateResolution');
    dom.remarkInput = qs('annotateRemark');
    dom.previewVideo = qs('annotatePreviewVideo');
    dom.previewCanvas = qs('annotatePreviewCanvas');
    dom.previewPlayBtn = qs('annotatePreviewPlayBtn');
    dom.previewShowHand = qs('annotatePreviewShowHand');
    dom.previewShowKeypoint = qs('annotatePreviewShowKeypoint');
    dom.previewShowAction = qs('annotatePreviewShowAction');
    dom.previewShowHandObject = qs('annotatePreviewShowHandObject');
    // 阶段 9：新增预览控制条元素
    dom.previewSpeedBtn = qs('annotatePreviewSpeedBtn');
    dom.previewProgress = qs('annotatePreviewProgress');
    dom.previewBackBtn = qs('annotatePreviewBackBtn');
    dom.previewSpeedLabel = qs('annotatePreviewSpeedLabel');
    dom.previewTime = qs('annotatePreviewTime');
    dom.statHand = qs('annotateStatHand');
    dom.statKeypoint = qs('annotateStatKeypoint');
    dom.statSegment = qs('annotateStatSegment');
    dom.statRelation = qs('annotateStatRelation');
    dom.statObjects = qs('annotateStatObjects');
    dom.statFrames = qs('annotateStatFrames');
    dom.statDuration = qs('annotateStatDuration');
    dom.exportHdf5Btn = qs('exportHdf5Btn');
    dom.exportJsonBtn = qs('exportJsonBtn');
    dom.exportCocoBtn = qs('annotateExportCocoBtn');
    dom.exportCsvBtn = qs('annotateExportCsvBtn');
    dom.modal = qs('annotateModal');
    dom.modalOverlay = qs('annotateModalOverlay');
    dom.modalTitle = qs('annotateModalTitle');
    dom.modalBody = qs('annotateModalBody');
    dom.modalCloseBtn = qs('annotateModalCloseBtn');
    dom.modalCancelBtn = qs('annotateModalCancelBtn');
    dom.modalConfirmBtn = qs('annotateModalConfirmBtn');
    // 阶段 6：动作分割面板
    dom.actionPanel = qs('actionPanel');
    dom.addActionLabelBtn = qs('addActionLabelBtn');
    dom.actionLabelsList = qs('actionLabelsList');
    dom.actionSegmentsList = qs('actionSegmentsList');
    // 阶段 7：手物交互面板
    dom.handObjectPanel = qs('handObjectPanel');
    dom.addRelationBtn = qs('addRelationBtn');
    dom.objectsList = qs('objectsList');
    dom.relationsList = qs('relationsList');
    dom.handObjectHint = qs('handObjectHint');
    // 阶段 8：导入标注按钮
    dom.importAnnotationsBtn = qs('importAnnotationsBtn');
  }

  // ===== 步骤导航 =====
  function goToStep(step) {
    try {
      if (typeof step !== 'number' || step < 1 || step > TOTAL_STEPS) {
        log('WARN', 'goToStep invalid step: ' + step);
        return;
      }
      var prevStep = state.currentStep;
      state.currentStep = step;
      log('STEP', 'goToStep: ' + prevStep + ' -> ' + step);

      // 阶段 9：进入/退出预览模式
      // 进入步骤 4：开启预览模式
      // 离开步骤 4：关闭预览模式（自动暂停视频）
      if (step === 4) {
        enterPreviewMode();
      } else if (prevStep === 4 && step !== 4) {
        exitPreviewMode();
      }

      // 更新步骤指示器
      updateStepsIndicator();

      // 切换步骤内容
      for (var i = 0; i < dom.stepContents.length; i++) {
        if (dom.stepContents[i]) {
          if (i + 1 === step) {
            dom.stepContents[i].classList.add('active');
          } else {
            dom.stepContents[i].classList.remove('active');
          }
        }
      }

      // 更新导航信息
      if (dom.stepNavInfo) {
        dom.stepNavInfo.textContent = step + ' / ' + TOTAL_STEPS;
      }

      // 上一步按钮禁用状态
      if (dom.prevBtn) {
        dom.prevBtn.disabled = (step === 1);
        dom.prevBtn.style.opacity = (step === 1) ? '0.5' : '1';
        dom.prevBtn.style.cursor = (step === 1) ? 'not-allowed' : 'pointer';
      }

      // 下一步按钮文案（最后一步改为「完成」语义，本阶段保留"下一步"文案）
      // 持久化
      saveToLocalStorage();

      // 触发步骤进入回调（供 canvas 模块使用）
      if (typeof window.AIX_ANNOTATE.onStepEnter === 'function') {
        try {
          window.AIX_ANNOTATE.onStepEnter(step);
        } catch (e) {
          log('ERROR', 'onStepEnter callback failed: ' + (e.message || e));
        }
      }

      // 阶段 10：进入步骤 5（导出）时，更新导出统计并执行导出前检查
      if (step === 5) {
        try {
          updateExportStats();
          if (window.AIX_ANNOTATE_EXPORT && typeof window.AIX_ANNOTATE_EXPORT.validateExport === 'function') {
            var validation = window.AIX_ANNOTATE_EXPORT.validateExport();
            if (validation && !validation.ok) {
              log('EXPORT', 'step 5 validation: ' + validation.reason);
              showToast(validation.reason);
            }
          }
        } catch (e) {
          log('ERROR', 'step 5 export stats/validate failed: ' + (e.message || e));
        }
      }
    } catch (e) {
      log('ERROR', 'goToStep failed: ' + (e.message || e));
    }
  }

  function nextStep() {
    try {
      // 步骤 1 → 2：检查是否已加载视频
      if (state.currentStep === 1) {
        if (!state.videoUrl || !state.videoFile) {
          log('WARN', 'nextStep: no video loaded');
          showToast(tt('annotate.err_no_video_loaded', '请先上传视频'));
          return;
        }
      }
      // 步骤 2 → 3：校验元信息表单
      if (state.currentStep === 2) {
        if (!validateMetaForm()) {
          return;
        }
      }
      if (state.currentStep < TOTAL_STEPS) {
        goToStep(state.currentStep + 1);
      } else {
        log('INFO', 'Already at last step');
      }
    } catch (e) {
      log('ERROR', 'nextStep failed: ' + (e.message || e));
    }
  }

  // ===== 元信息表单校验（Task 2.3）=====
  function validateMetaForm() {
    try {
      var errors = [];

      // 采集人必填
      if (!state.meta.collector || !String(state.meta.collector).trim()) {
        errors.push(tt('annotate.err_collector_required', '采集人必填'));
      }
      // 采集日期必填
      if (!state.meta.date) {
        errors.push(tt('annotate.err_date_required', '采集日期必填'));
      }

      if (errors.length > 0) {
        log('META', 'Validation failed: ' + errors.join('; '));
        showToast(errors[0]); // 只显示第一个错误
        return false;
      }

      log('META', 'Validation passed');
      return true;
    } catch (e) {
      log('ERROR', 'validateMetaForm failed: ' + (e.message || e));
      return false;
    }
  }

  function prevStep() {
    if (state.currentStep > 1) {
      goToStep(state.currentStep - 1);
    } else {
      log('INFO', 'Already at first step');
    }
  }

  function updateStepsIndicator() {
    try {
      if (!dom.steps) return;
      var circles = qsa('.annotate-step-circle', dom.steps);
      for (var i = 0; i < circles.length; i++) {
        var circle = circles[i];
        var stepNum = parseInt(circle.getAttribute('data-step'), 10);
        circle.classList.remove('active', 'completed');
        if (stepNum < state.currentStep) {
          circle.classList.add('completed');
        } else if (stepNum === state.currentStep) {
          circle.classList.add('active');
        }
      }
    } catch (e) {
      log('ERROR', 'updateStepsIndicator failed: ' + (e.message || e));
    }
  }

  // ===== Tab 切换 =====
  function switchTab(tab) {
    try {
      if (TAB_KEYS.indexOf(tab) === -1) {
        log('WARN', 'switchTab invalid tab: ' + tab);
        return;
      }
      var prevTab = state.activeTab;
      state.activeTab = tab;
      log('TAB', 'switchTab: ' + prevTab + ' -> ' + tab);

      // 更新 Tab UI
      for (var i = 0; i < dom.tabBtns.length; i++) {
        var btn = dom.tabBtns[i];
        var btnTab = btn.getAttribute('data-tab');
        if (btnTab === tab) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      }

      // 更新面板标题
      updatePanelTitle(tab);

      // 触发 Tab 变更回调（供 canvas 模块重绘）
      if (typeof window.AIX_ANNOTATE.onTabChange === 'function') {
        try {
          window.AIX_ANNOTATE.onTabChange(tab, prevTab);
        } catch (e) {
          log('ERROR', 'onTabChange callback failed: ' + (e.message || e));
        }
      }

      // 触发 Canvas 重绘
      triggerRedraw();

      // 持久化
      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'switchTab failed: ' + (e.message || e));
    }
  }

  function updatePanelTitle(tab) {
    if (!dom.panelTitle) return;
    var titleMap = {
      hand_detection: 'annotate.panel_title_hand',
      keypoints: 'annotate.panel_title_keypoint',
      action: 'annotate.panel_title_action',
      hand_object: 'annotate.panel_title_hand_object'
    };
    var fallbackMap = {
      hand_detection: '手部检测',
      keypoints: '关键点',
      action: '动作分割',
      hand_object: '手物交互'
    };
    var key = titleMap[tab] || 'annotate.panel_title_hand';
    var fallback = fallbackMap[tab] || '手部检测';
    dom.panelTitle.textContent = tt(key, fallback);
  }

  // ===== 触发 Canvas 重绘 =====
  function triggerRedraw() {
    if (typeof window.AIX_ANNOTATE.redrawCanvas === 'function') {
      try {
        window.AIX_ANNOTATE.redrawCanvas();
      } catch (e) {
        log('ERROR', 'redrawCanvas callback failed: ' + (e.message || e));
      }
    }
  }

  // ===== 帧变化触发 =====
  function setFrame(frame) {
    try {
      if (typeof frame !== 'number' || frame < 0) frame = 0;
      if (state.totalFrames > 0 && frame > state.totalFrames - 1) {
        frame = state.totalFrames - 1;
      }
      state.currentFrame = frame;
      log('FRAME', 'setFrame: ' + frame + ' / ' + state.totalFrames);

      // 更新显示
      updateFrameDisplay();

      // 触发回调
      if (typeof window.AIX_ANNOTATE.onFrameChange === 'function') {
        try {
          window.AIX_ANNOTATE.onFrameChange(frame);
        } catch (e) {
          log('ERROR', 'onFrameChange callback failed: ' + (e.message || e));
        }
      }
    } catch (e) {
      log('ERROR', 'setFrame failed: ' + (e.message || e));
    }
  }

  // ===== 时间格式化 HH:MM:SS.cc (cc=百分之秒) =====
  function pad(num, len) {
    try {
      num = String(num);
      while (num.length < len) num = '0' + num;
      return num;
    } catch (e) {
      return num;
    }
  }

  function formatTime(seconds) {
    try {
      if (!seconds || isNaN(seconds) || seconds < 0 || !isFinite(seconds)) seconds = 0;
      var cc = Math.floor((seconds * 100) % 100);
      var ss = Math.floor(seconds % 60);
      var mm = Math.floor((seconds / 60) % 60);
      var hh = Math.floor(seconds / 3600);
      return pad(hh, 2) + ':' + pad(mm, 2) + ':' + pad(ss, 2) + '.' + pad(cc, 2);
    } catch (e) {
      log('ERROR', 'formatTime failed: ' + (e.message || e));
      return '00:00:00.00';
    }
  }

  // ===== 更新帧号 / 时间戳 / 进度条 显示 =====
  function updateFrameDisplay() {
    try {
      // 帧号显示（用户友好，1-based）
      var displayFrame = state.currentFrame + 1;
      if (dom.frameLabel) {
        dom.frameLabel.textContent = 'Frame: ' + displayFrame + ' / ' + state.totalFrames;
      }

      // 时间戳显示
      if (dom.timeLabel) {
        var currentTime = 0;
        var duration = 0;
        if (dom.video && dom.video.readyState >= 2) {
          currentTime = dom.video.currentTime || 0;
          duration = state.videoDuration || dom.video.duration || 0;
        }
        dom.timeLabel.textContent = formatTime(currentTime) + ' / ' + formatTime(duration);
      }

      // 进度条同步
      if (dom.progress) {
        if (dom.video && dom.video.readyState >= 2 && state.videoDuration > 0) {
          var ratio = dom.video.currentTime / state.videoDuration;
          if (ratio < 0) ratio = 0;
          if (ratio > 1) ratio = 1;
          // 避免拖拽时被反推
          if (!dom.progress._isDragging) {
            dom.progress.value = String(Math.round(ratio * 1000));
          }
        } else {
          dom.progress.value = '0';
        }
      }

      // 阶段 9：同步预览控制条的进度条和时间显示
      updatePreviewProgress();
      updatePreviewTimeLabel();

      // 阶段 6：同步时间轴（当前帧指示器）
      try {
        if (typeof renderTimeline === 'function') {
          renderTimeline();
        }
      } catch (eTL) {
        log('ERROR', 'renderTimeline in updateFrameDisplay failed: ' + (eTL.message || eTL));
      }
    } catch (e) {
      log('ERROR', 'updateFrameDisplay failed: ' + (e.message || e));
    }
  }

  // ===== 快捷键绑定 =====
  function bindShortcuts() {
    document.addEventListener('keydown', function (e) {
      try {
        // 在 input/textarea/select 聚焦时不响应快捷键
        var target = e.target || e.srcElement;
        var tagName = target.tagName ? target.tagName.toLowerCase() : '';
        var isEditable = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable === true;

        // Ctrl+Z / Ctrl+Y 撤销重做允许在编辑框中使用（保留默认行为）
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
          if (isEditable) return; // 让浏览器原生处理
          if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            undo();
          } else {
            e.preventDefault();
            redo();
          }
          return;
        }

        // 其余快捷键仅在标注步骤（步骤 3）生效，且不在编辑框中
        if (state.currentStep !== 3) return;
        if (isEditable) return;

        var key = e.key;
        switch (key) {
          case ' ':
            e.preventDefault();
            togglePlay();
            break;
          case 'ArrowLeft':
            e.preventDefault();
            stepFrame(-1);
            break;
          case 'ArrowRight':
            e.preventDefault();
            stepFrame(1);
            break;
          case 'g':
          case 'G':
            e.preventDefault();
            goToFramePrompt();
            break;
          case 's':
          case 'S':
            e.preventDefault();
            cyclePlaybackRate();
            break;
          case 'f':
          case 'F':
            e.preventDefault();
            toggleFullscreen();
            break;
          case 'Delete':
          case 'Backspace':
            e.preventDefault();
            deleteSelected();
            break;
          case '1':
            e.preventDefault();
            switchTab('hand_detection');
            break;
          case '2':
            e.preventDefault();
            switchTab('keypoints');
            break;
          case '3':
            e.preventDefault();
            switchTab('action');
            break;
          case '4':
            e.preventDefault();
            switchTab('hand_object');
            break;
          default:
            // 忽略其他键
            break;
        }
      } catch (err) {
        log('ERROR', 'shortcut handler failed: ' + (err.message || err));
      }
    });
    log('INIT', 'Shortcuts bound');
  }

  // ===== 播放控制 =====
  function togglePlay() {
    try {
      if (!dom.video) {
        log('WARN', 'togglePlay: video element not found');
        return;
      }
      if (!dom.video.src) {
        log('WARN', 'togglePlay: no video src');
        showToast(tt('annotate.err_no_video_loaded', '请先加载视频'));
        return;
      }
      if (dom.video.readyState < 2) {
        log('WARN', 'togglePlay: video not ready, readyState=' + dom.video.readyState);
        showToast(tt('annotate.err_video_not_ready', '视频尚未就绪，请稍候'));
        return;
      }
      if (dom.video.paused) {
        // 应用当前倍速
        var speed = PLAYBACK_SPEEDS[state.playbackSpeedIdx] || 1;
        try { dom.video.playbackRate = speed; } catch (e) {
          log('WARN', 'set playbackRate failed: ' + (e.message || e));
        }
        var playPromise = dom.video.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.then(function () {
            state.isPlaying = true;
            updatePlayBtnIcon();
            log('PLAY', 'Playback started, rate=' + speed);
          }).catch(function (err) {
            log('ERROR', 'play() rejected: ' + (err.message || err));
            showToast(tt('annotate.err_play_failed', '播放失败: ' + (err.message || err)));
          });
        } else {
          state.isPlaying = true;
          updatePlayBtnIcon();
          log('PLAY', 'Playback started (no promise), rate=' + speed);
        }
      } else {
        dom.video.pause();
        state.isPlaying = false;
        updatePlayBtnIcon();
        log('PLAY', 'Playback paused');
      }
    } catch (e) {
      log('ERROR', 'togglePlay failed: ' + (e.message || e));
      showToast(tt('annotate.err_play_failed', '播放失败: ' + (e.message || e)));
    }
  }

  function updatePlayBtnIcon() {
    if (!dom.playBtn) return;
    var icon = dom.playBtn.querySelector('.material-symbols-outlined');
    if (!icon) return;
    icon.textContent = state.isPlaying ? 'pause' : 'play_arrow';
  }

  function stepFrame(direction) {
    try {
      if (state.fps <= 0) {
        log('WARN', 'stepFrame: invalid fps=' + state.fps);
        showToast(tt('annotate.err_no_video_loaded', '请先加载视频'));
        return;
      }
      if (!dom.video || dom.video.readyState < 2) {
        log('WARN', 'stepFrame: video not ready');
        return;
      }

      // 暂停视频后跳转
      if (!dom.video.paused) {
        dom.video.pause();
        state.isPlaying = false;
        updatePlayBtnIcon();
      }

      // 计算步长（1/fps 秒）
      var step = 1 / state.fps;
      var newTime;
      if (direction < 0) {
        newTime = Math.max(0, dom.video.currentTime - step);
      } else {
        var maxTime = state.videoDuration || dom.video.duration || 0;
        newTime = Math.min(maxTime, dom.video.currentTime + step);
      }

      // 设置 currentTime（seek 可能抛错，需捕获）
      try {
        dom.video.currentTime = newTime;
      } catch (e) {
        log('ERROR', 'stepFrame seek failed: ' + (e.message || e));
        return;
      }

      // 计算新的当前帧（0-based）
      var newFrame = Math.round(newTime * state.fps);
      if (state.totalFrames > 0 && newFrame > state.totalFrames - 1) {
        newFrame = state.totalFrames - 1;
      }
      if (newFrame < 0) newFrame = 0;

      state.currentFrame = newFrame;
      log('FRAME', 'stepFrame direction=' + direction + ' -> frame=' + newFrame + ' time=' + newTime);

      updateFrameDisplay();

      // 触发回调
      if (typeof window.AIX_ANNOTATE.onFrameChange === 'function') {
        try {
          window.AIX_ANNOTATE.onFrameChange(newFrame);
        } catch (e) {
          log('ERROR', 'onFrameChange callback failed: ' + (e.message || e));
        }
      }
    } catch (e) {
      log('ERROR', 'stepFrame failed: ' + (e.message || e));
    }
  }

  function goToFramePrompt() {
    try {
      if (state.totalFrames <= 0) {
        log('WARN', 'goToFramePrompt: totalFrames=' + state.totalFrames);
        showToast(tt('annotate.err_no_video_loaded', '请先加载视频'));
        return;
      }
      var promptMsg = tt('annotate.goto_prompt', '请输入要跳转的帧号 (1 - ' + state.totalFrames + '):');
      var input = window.prompt(promptMsg, String(state.currentFrame + 1));
      if (input === null) return;

      var frame = parseInt(input, 10);
      if (isNaN(frame)) {
        log('WARN', 'goToFramePrompt: invalid input ' + input);
        showToast(tt('annotate.err_invalid_frame', '请输入有效的数字'));
        return;
      }
      // 校验：1 到 totalFrames 之间
      if (frame < 1 || frame > state.totalFrames) {
        log('WARN', 'goToFramePrompt: out of range ' + frame);
        showToast(tt('annotate.err_frame_range', '帧号应在 1 到 ' + state.totalFrames + ' 之间'));
        return;
      }

      // 转换为 0-based 内部表示
      var internalFrame = frame - 1;

      if (!dom.video || dom.video.readyState < 2 || state.fps <= 0) {
        log('WARN', 'goToFramePrompt: video not ready');
        setFrame(internalFrame);
        return;
      }

      // 暂停视频
      if (!dom.video.paused) {
        dom.video.pause();
        state.isPlaying = false;
        updatePlayBtnIcon();
      }

      // 跳转：video.currentTime = (frame - 1) / fps
      try {
        dom.video.currentTime = internalFrame / state.fps;
      } catch (e) {
        log('ERROR', 'goToFramePrompt seek failed: ' + (e.message || e));
        return;
      }

      state.currentFrame = internalFrame;
      log('FRAME', 'goToFramePrompt: frame=' + frame + ' (internal=' + internalFrame + ') -> time=' + dom.video.currentTime);

      updateFrameDisplay();

      if (typeof window.AIX_ANNOTATE.onFrameChange === 'function') {
        try {
          window.AIX_ANNOTATE.onFrameChange(internalFrame);
        } catch (e) {
          log('ERROR', 'onFrameChange callback failed: ' + (e.message || e));
        }
      }
    } catch (e) {
      log('ERROR', 'goToFramePrompt failed: ' + (e.message || e));
    }
  }

  function cyclePlaybackRate() {
    try {
      state.playbackSpeedIdx = (state.playbackSpeedIdx + 1) % PLAYBACK_SPEEDS.length;
      var speed = PLAYBACK_SPEEDS[state.playbackSpeedIdx];
      if (dom.speedLabel) {
        dom.speedLabel.textContent = speed + 'x';
      }
      // 阶段 9：同步预览控制条倍速标签
      updatePreviewSpeedLabel();
      // 无条件更新 video.playbackRate（即使暂停也生效，便于下次播放时使用）
      if (dom.video) {
        try { dom.video.playbackRate = speed; } catch (e) {
          log('WARN', 'set playbackRate failed: ' + (e.message || e));
        }
      }
      log('PLAY', 'Playback rate cycled: ' + speed + 'x (idx=' + state.playbackSpeedIdx + ')');
      showToast(tt('annotate.speed_changed', '倍速: ' + speed + 'x'));
      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'cyclePlaybackRate failed: ' + (e.message || e));
    }
  }

  function toggleFullscreen() {
    try {
      var el = dom.video ? dom.video.parentElement : null;
      if (!el) {
        log('WARN', 'toggleFullscreen: no canvas area');
        return;
      }
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        var req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) {
          req.call(el).then(function () {
            log('FULLSCREEN', 'Entered fullscreen');
          }).catch(function (err) {
            log('ERROR', 'requestFullscreen rejected: ' + (err.message || err));
          });
        } else {
          log('WARN', 'Fullscreen API not supported');
        }
      } else {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
          exit.call(document);
          log('FULLSCREEN', 'Exited fullscreen');
        }
      }
    } catch (e) {
      log('ERROR', 'toggleFullscreen failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // 阶段 9：预览回放模式
  // ============================================================

  // ===== 进入预览模式 =====
  function enterPreviewMode() {
    try {
      log('PREVIEW', 'enterPreviewMode start');
      // 给 body 加 .preview-mode 类（CSS 控制全屏化、隐藏工具栏等）
      document.body.classList.add('preview-mode');

      // 设置 canvas previewMode
      if (window.AIX_ANNOTATE_CANVAS) {
        // 先同步 4 个开关状态到 canvas
        syncPreviewVisibleFlags();
        if (typeof window.AIX_ANNOTATE_CANVAS.setPreviewMode === 'function') {
          window.AIX_ANNOTATE_CANVAS.setPreviewMode(true);
        }
        // 触发 canvas 尺寸重算（CSS 让 canvas-area 全屏化，client 尺寸变了）
        // 用 setTimeout 等 CSS 生效后再 resizeCanvas + render
        setTimeout(function () {
          try {
            if (typeof window.AIX_ANNOTATE_CANVAS.resizeCanvas === 'function') {
              window.AIX_ANNOTATE_CANVAS.resizeCanvas();
            }
            if (typeof window.AIX_ANNOTATE_CANVAS.render === 'function') {
              window.AIX_ANNOTATE_CANVAS.render();
            }
          } catch (e) {
            log('ERROR', 'enterPreviewMode delayed resize/render failed: ' + (e.message || e));
          }
        }, 50);
      }

      // 同步预览控制条 UI 状态
      updatePreviewPlayBtnIcon();
      updatePreviewSpeedLabel();
      updatePreviewProgress();
      updatePreviewTimeLabel();

      log('PREVIEW', 'Entered preview mode');
    } catch (e) {
      log('ERROR', 'enterPreviewMode failed: ' + (e.message || e));
    }
  }

  // ===== 退出预览模式 =====
  function exitPreviewMode() {
    try {
      log('PREVIEW', 'exitPreviewMode start');
      // 移除 body 的 .preview-mode 类
      document.body.classList.remove('preview-mode');

      // 关闭 canvas previewMode
      if (window.AIX_ANNOTATE_CANVAS) {
        if (typeof window.AIX_ANNOTATE_CANVAS.setPreviewMode === 'function') {
          window.AIX_ANNOTATE_CANVAS.setPreviewMode(false);
        }
        // 延迟 resize/render，等 CSS 收回后画布尺寸正确
        setTimeout(function () {
          try {
            if (typeof window.AIX_ANNOTATE_CANVAS.resizeCanvas === 'function') {
              window.AIX_ANNOTATE_CANVAS.resizeCanvas();
            }
            if (typeof window.AIX_ANNOTATE_CANVAS.render === 'function') {
              window.AIX_ANNOTATE_CANVAS.render();
            }
          } catch (e) {
            log('ERROR', 'exitPreviewMode delayed resize/render failed: ' + (e.message || e));
          }
        }, 50);
      }

      // 暂停视频（避免回到步骤 3 后仍在播放干扰标注）
      if (dom.video && !dom.video.paused) {
        try {
          dom.video.pause();
          state.isPlaying = false;
          updatePlayBtnIcon();
          updatePreviewPlayBtnIcon();
        } catch (e) {
          log('WARN', 'exitPreviewMode: pause video failed: ' + (e.message || e));
        }
      }
      log('PREVIEW', 'Exited preview mode');
    } catch (e) {
      log('ERROR', 'exitPreviewMode failed: ' + (e.message || e));
    }
  }

  // ===== 同步 4 个显示开关到 canvas =====
  function syncPreviewVisibleFlags() {
    try {
      if (!window.AIX_ANNOTATE_CANVAS || typeof window.AIX_ANNOTATE_CANVAS.setPreviewVisibleFlags !== 'function') {
        return;
      }
      var flags = {
        hand: dom.previewShowHand ? dom.previewShowHand.checked : true,
        keypoints: dom.previewShowKeypoint ? dom.previewShowKeypoint.checked : true,
        action: dom.previewShowAction ? dom.previewShowAction.checked : true,
        handObject: dom.previewShowHandObject ? dom.previewShowHandObject.checked : true
      };
      window.AIX_ANNOTATE_CANVAS.setPreviewVisibleFlags(flags);
      log('PREVIEW', 'syncPreviewVisibleFlags: hand=' + flags.hand +
        ' keypoints=' + flags.keypoints +
        ' action=' + flags.action +
        ' handObject=' + flags.handObject);
    } catch (e) {
      log('ERROR', 'syncPreviewVisibleFlags failed: ' + (e.message || e));
    }
  }

  // ===== 同步预览播放按钮图标 =====
  function updatePreviewPlayBtnIcon() {
    try {
      if (!dom.previewPlayBtn) return;
      var icon = dom.previewPlayBtn.querySelector('.material-symbols-outlined');
      if (!icon) return;
      icon.textContent = state.isPlaying ? 'pause' : 'play_arrow';
    } catch (e) {
      log('WARN', 'updatePreviewPlayBtnIcon failed: ' + (e.message || e));
    }
  }

  // ===== 同步预览倍速标签 =====
  function updatePreviewSpeedLabel() {
    try {
      if (!dom.previewSpeedLabel) return;
      var speed = PLAYBACK_SPEEDS[state.playbackSpeedIdx] || 1;
      dom.previewSpeedLabel.textContent = speed + 'x';
    } catch (e) {
      log('WARN', 'updatePreviewSpeedLabel failed: ' + (e.message || e));
    }
  }

  // ===== 同步预览进度条 =====
  function updatePreviewProgress() {
    try {
      if (!dom.previewProgress) return;
      if (dom.previewProgress._isDragging) return; // 拖拽中不反推
      if (!dom.video || dom.video.readyState < 2 || state.videoDuration <= 0) {
        dom.previewProgress.value = '0';
        return;
      }
      var ratio = dom.video.currentTime / state.videoDuration;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;
      dom.previewProgress.value = String(Math.round(ratio * 1000));
    } catch (e) {
      log('WARN', 'updatePreviewProgress failed: ' + (e.message || e));
    }
  }

  // ===== 同步预览时间显示 =====
  function updatePreviewTimeLabel() {
    try {
      if (!dom.previewTime) return;
      var currentTime = 0;
      var duration = 0;
      if (dom.video && dom.video.readyState >= 2) {
        currentTime = dom.video.currentTime || 0;
        duration = state.videoDuration || dom.video.duration || 0;
      }
      dom.previewTime.textContent = formatTime(currentTime) + ' / ' + formatTime(duration);
    } catch (e) {
      log('WARN', 'updatePreviewTimeLabel failed: ' + (e.message || e));
    }
  }

  function deleteSelected() {
    try {
      var tab = state.activeTab;
      var selectedId = null;
      var list = null;
      if (tab === 'hand_detection') {
        selectedId = state.selectedIds.hand;
        list = state.annotations.hand_detection;
      } else if (tab === 'keypoints') {
        selectedId = state.selectedIds.keypoint;
        list = state.annotations.hand_keypoints;
      } else if (tab === 'action') {
        // 阶段 6：动作分割使用独立删除流程
        selectedId = state.selectedIds.segment;
        if (selectedId === null) {
          log('INFO', 'deleteSelected: no action segment selected');
          return;
        }
        // 二次确认
        showModal({
          title: tt('annotate.modal_delete_title', '删除确认'),
          body: '<p>' + tt('annotate.modal_delete_body', '确认删除当前选中的标注？') + '</p>',
          confirmText: tt('annotate.modal_confirm', '确认'),
          cancelText: tt('annotate.modal_cancel', '取消'),
          onConfirm: function () {
            try {
              deleteActionSegment(selectedId);
              hideModal();
            } catch (e) {
              log('ERROR', 'deleteActionSegment in deleteSelected failed: ' + (e.message || e));
              hideModal();
            }
          }
        });
        return;
      } else if (tab === 'hand_object') {
        // 阶段 7：优先删除选中的关系，其次删除选中的物体框
        selectedId = state.selectedIds.relation;
        if (selectedId === null) {
          // 没有选中关系，尝试删除选中的物体
          var selObjId = state.selectedIds.object;
          if (selObjId === null) {
            log('INFO', 'deleteSelected: no hand_object relation/object selected');
            return;
          }
          showModal({
            title: tt('annotate.modal_delete_title', '删除确认'),
            body: '<p>' + tt('annotate.hand_object_delete_object_body',
              '确认删除当前选中的物体框？关联的关系也将一并删除。') + '</p>',
            confirmText: tt('annotate.modal_confirm', '确认'),
            cancelText: tt('annotate.modal_cancel', '取消'),
            onConfirm: function () {
              try {
                deleteObject(selObjId);
                hideModal();
              } catch (e) {
                log('ERROR', 'deleteObject in deleteSelected failed: ' + (e.message || e));
                hideModal();
              }
            }
          });
          return;
        }
        list = state.annotations.hand_object;
      }

      if (selectedId === null || !list) {
        log('INFO', 'deleteSelected: nothing selected for tab ' + tab);
        return;
      }

      // 二次确认
      showModal({
        title: tt('annotate.modal_delete_title', '删除确认'),
        body: '<p>' + tt('annotate.modal_delete_body', '确认删除当前选中的标注？') + '</p>',
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === selectedId) {
              list.splice(i, 1);
              log('DELETE', 'Annotation removed, id=' + selectedId + ' tab=' + tab);
              break;
            }
          }
          // 清空选中
          if (tab === 'hand_detection') state.selectedIds.hand = null;
          else if (tab === 'keypoints') state.selectedIds.keypoint = null;
          else if (tab === 'hand_object') state.selectedIds.relation = null;
          // hand_detection 删除后需要重新计算插值
          if (tab === 'hand_detection') {
            try {
              recomputeInterpolation();
            } catch (e) {
              log('ERROR', 'recomputeInterpolation after delete failed: ' + (e.message || e));
            }
          }
          triggerRedraw();
          saveToLocalStorage();
          renderPanel();
          hideModal();
        }
      });
    } catch (e) {
      log('ERROR', 'deleteSelected failed: ' + (e.message || e));
    }
  }

  // ===== 撤销 / 重做（基础占位实现，具体业务在后续阶段） =====
  function pushHistory(snapshot) {
    try {
      // 截断重做栈
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push({
        ts: Date.now(),
        snapshot: JSON.stringify(snapshot)
      });
      // 限制历史栈大小（100 条）
      if (state.history.length > 100) {
        state.history.shift();
      } else {
        state.historyIndex++;
      }
      log('HISTORY', 'push, index=' + state.historyIndex + ' size=' + state.history.length);
    } catch (e) {
      log('ERROR', 'pushHistory failed: ' + (e.message || e));
    }
  }

  function undo() {
    try {
      if (state.historyIndex < 0) {
        log('INFO', 'undo: nothing to undo');
        return;
      }
      var entry = state.history[state.historyIndex];
      if (!entry) {
        log('WARN', 'undo: no history entry at index ' + state.historyIndex);
        return;
      }
      state.historyIndex--;
      var snapshot = JSON.parse(entry.snapshot);
      // 合并快照（保留 history 自身）
      var histBackup = state.history;
      var histIdxBackup = state.historyIndex;
      state = mergeState(state, snapshot);
      state.history = histBackup;
      state.historyIndex = histIdxBackup;
      log('HISTORY', 'undo to index=' + state.historyIndex);
      triggerRedraw();
      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'undo failed: ' + (e.message || e));
    }
  }

  function redo() {
    try {
      if (state.historyIndex >= state.history.length - 1) {
        log('INFO', 'redo: nothing to redo');
        return;
      }
      state.historyIndex++;
      var entry = state.history[state.historyIndex];
      if (!entry) {
        log('WARN', 'redo: no history entry at index ' + state.historyIndex);
        state.historyIndex--;
        return;
      }
      var snapshot = JSON.parse(entry.snapshot);
      var histBackup = state.history;
      var histIdxBackup = state.historyIndex;
      state = mergeState(state, snapshot);
      state.history = histBackup;
      state.historyIndex = histIdxBackup;
      log('HISTORY', 'redo to index=' + state.historyIndex);
      triggerRedraw();
      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'redo failed: ' + (e.message || e));
    }
  }

  // ===== 弹窗（通用） =====
  function showModal(opts) {
    try {
      opts = opts || {};
      if (!dom.modal) {
        log('WARN', 'showModal: modal element not found');
        return;
      }
      if (dom.modalTitle) dom.modalTitle.textContent = opts.title || tt('annotate.modal_title_default', '提示');
      if (dom.modalBody) dom.modalBody.innerHTML = opts.body || '';
      if (dom.modalConfirmBtn) {
        dom.modalConfirmBtn.textContent = opts.confirmText || tt('annotate.modal_confirm', '确认');
        // 每次显示重置（避免 showHandSelectionModal 隐藏后影响下次弹窗）
        dom.modalConfirmBtn.style.display = '';
      }
      if (dom.modalCancelBtn) {
        dom.modalCancelBtn.textContent = opts.cancelText || tt('annotate.modal_cancel', '取消');
        dom.modalCancelBtn.style.display = opts.hideCancel ? 'none' : '';
      }
      dom.modalConfirmCallback = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
      dom.modal.removeAttribute('hidden');
      log('MODAL', 'show: ' + (opts.title || ''));
    } catch (e) {
      log('ERROR', 'showModal failed: ' + (e.message || e));
    }
  }

  function hideModal() {
    try {
      if (!dom.modal) return;
      dom.modal.setAttribute('hidden', '');
      dom.modalConfirmCallback = null;
      log('MODAL', 'hide');
    } catch (e) {
      log('ERROR', 'hideModal failed: ' + (e.message || e));
    }
  }

  // ===== localStorage 持久化 =====
  function saveToLocalStorage() {
    try {
      // 序列化时排除运行时字段（不可序列化的 File / Blob / URL）
      var serializable = {
        currentStep: state.currentStep,
        currentFrame: state.currentFrame,
        totalFrames: state.totalFrames,
        fps: state.fps,
        videoFileName: state.videoFileName,
        videoFileSize: state.videoFileSize,
        videoDuration: state.videoDuration,
        videoResolution: state.videoResolution,
        playbackSpeedIdx: state.playbackSpeedIdx,
        meta: state.meta,
        activeTab: state.activeTab,
        annotations: state.annotations,
        selectedIds: state.selectedIds
      };
      var json = JSON.stringify(serializable);
      localStorage.setItem(STORAGE_KEY, json);
      log('SAVE', 'state saved, size=' + json.length + ' bytes');
      return true;
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
        log('ERROR', 'saveToLocalStorage: quota exceeded');
        showModal({
          title: tt('annotate.save_quota_title', '存储空间不足'),
          body: '<p>' + tt('annotate.save_quota_body', '浏览器 localStorage 配额已满，请清理部分标注或导出后清空再继续。') + '</p>',
          hideCancel: true,
          confirmText: tt('annotate.modal_confirm', '确认')
        });
      } else {
        log('ERROR', 'saveToLocalStorage failed: ' + msg);
      }
      return false;
    }
  }

  function loadFromLocalStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        log('LOAD', 'No saved state in localStorage');
        return null;
      }
      var parsed = JSON.parse(raw);
      log('LOAD', 'state loaded, size=' + raw.length + ' bytes');
      return parsed;
    } catch (e) {
      log('ERROR', 'loadFromLocalStorage failed: ' + (e.message || e) + ', treating as no saved state');
      return null;
    }
  }

  function applySavedState(saved) {
    try {
      if (!saved || typeof saved !== 'object') return;
      state = mergeState(state, saved);
      // 注意：保留 history 和 historyIndex 不被覆盖
      // 注意：videoUrl / videoFile 为运行时字段，需重新加载（阶段 2 实现）
      log('LOAD', 'Saved state applied, currentStep=' + state.currentStep + ' activeTab=' + state.activeTab);
    } catch (e) {
      log('ERROR', 'applySavedState failed: ' + (e.message || e));
    }
  }

  // ===== 工具：合并状态（浅合并 + annotations 深合并） =====
  function mergeState(base, overlay) {
    var result = base;
    for (var k in overlay) {
      if (!Object.prototype.hasOwnProperty.call(overlay, k)) continue;
      if (k === 'annotations' && typeof overlay[k] === 'object' && overlay[k] !== null) {
        result[k] = result[k] || {};
        for (var ak in overlay[k]) {
          if (Object.prototype.hasOwnProperty.call(overlay[k], ak)) {
            result[k][ak] = overlay[k][ak];
          }
        }
      } else if (k === 'meta' && typeof overlay[k] === 'object' && overlay[k] !== null) {
        result[k] = result[k] || {};
        for (var mk in overlay[k]) {
          if (Object.prototype.hasOwnProperty.call(overlay[k], mk)) {
            result[k][mk] = overlay[k][mk];
          }
        }
      } else if (k === 'selectedIds' && typeof overlay[k] === 'object' && overlay[k] !== null) {
        result[k] = result[k] || {};
        for (var sk in overlay[k]) {
          if (Object.prototype.hasOwnProperty.call(overlay[k], sk)) {
            result[k][sk] = overlay[k][sk];
          }
        }
      } else {
        result[k] = overlay[k];
      }
    }
    return result;
  }

  // ===== 清空标注 =====
  function clearAnnotations() {
    try {
      showModal({
        title: tt('annotate.clear_confirm_title', '清空所有标注'),
        body: '<p>' + tt('annotate.clear_confirm_body', '此操作将清空所有标注数据并清除本地缓存，且不可撤销。确定继续吗？') + '</p>',
        confirmText: tt('annotate.clear_confirm_btn', '清空'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            state.annotations = {
              hand_detection: [],
              hand_keypoints: [],
              action_segmentation: { labels: [], segments: [] },
              hand_object: [],
              objects: []
            };
            state.selectedIds = { hand: null, keypoint: null, segment: null, relation: null, object: null };
            state.history = [];
            state.historyIndex = -1;
            state.currentFrame = 0;

            // 清空 localStorage
            try {
              localStorage.removeItem(STORAGE_KEY);
            } catch (e) {
              log('ERROR', 'clearAnnotations: removeItem failed: ' + (e.message || e));
            }

            log('CLEAR', 'All annotations cleared');
            hideModal();
            triggerRedraw();
            renderPanel();
            showToast(tt('annotate.clear_done', '已清空所有标注'));
          } catch (e) {
            log('ERROR', 'clearAnnotations onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'clearAnnotations failed: ' + (e.message || e));
    }
  }

  // ===== Task 8.3：导入标注（从 JSON 文件恢复） =====
  function importAnnotations() {
    try {
      log('IMPORT', 'importAnnotations triggered, opening file picker');
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      // 避免重复绑定导致无法选择同一个文件
      input.style.display = 'none';
      input.onchange = function (e) {
        try {
          var target = e.target || e.srcElement;
          var file = target && target.files && target.files[0];
          if (!file) {
            log('IMPORT', 'No file selected, aborted');
            return;
          }
          log('IMPORT', 'File selected: ' + file.name + ', size=' + file.size + ' bytes');
          if (file.size === 0) {
            showToast(tt('annotate.import_empty', '文件为空'));
            log('ERROR', 'importAnnotations: file is empty');
            return;
          }
          // 安全上限：50MB，避免一次性读入过大文件导致页面卡死
          var MAX_IMPORT_SIZE = 50 * 1024 * 1024;
          if (file.size > MAX_IMPORT_SIZE) {
            showToast(tt('annotate.import_too_large', '文件过大，请检查是否选错了文件'));
            log('ERROR', 'importAnnotations: file too large, size=' + file.size);
            return;
          }
          var reader = new FileReader();
          reader.onerror = function (err) {
            log('ERROR', 'importAnnotations: FileReader error: ' + (err && err.message ? err.message : err));
            showToast(tt('annotate.import_read_failed', '读取文件失败'));
          };
          reader.onload = function (ev) {
            try {
              var raw = ev.target && ev.target.result;
              if (!raw) {
                showToast(tt('annotate.import_read_failed', '读取文件失败'));
                log('ERROR', 'importAnnotations: empty result');
                return;
              }
              var data;
              try {
                data = JSON.parse(raw);
              } catch (parseErr) {
                showToast(tt('annotate.import_invalid_json', 'JSON 解析失败: ') + (parseErr.message || parseErr));
                log('ERROR', 'importAnnotations: JSON parse failed: ' + (parseErr.message || parseErr));
                return;
              }
              // 结构校验：必须包含 annotations 字段
              if (!data || typeof data !== 'object' || !data.annotations || typeof data.annotations !== 'object') {
                showToast(tt('annotate.import_invalid_format', 'JSON 格式错误：缺少 annotations 字段'));
                log('ERROR', 'importAnnotations: missing annotations field');
                return;
              }
              var ann = data.annotations;
              // 覆盖合并：保留 4 个标注数组 + objects 字段，缺失则补 []
              state.annotations = {
                hand_detection: Array.isArray(ann.hand_detection) ? ann.hand_detection : [],
                hand_keypoints: Array.isArray(ann.hand_keypoints) ? ann.hand_keypoints : [],
                action_segmentation: (ann.action_segmentation && typeof ann.action_segmentation === 'object') ? {
                  labels: Array.isArray(ann.action_segmentation.labels) ? ann.action_segmentation.labels : [],
                  segments: Array.isArray(ann.action_segmentation.segments) ? ann.action_segmentation.segments : []
                } : { labels: [], segments: [] },
                hand_object: Array.isArray(ann.hand_object) ? ann.hand_object : [],
                objects: Array.isArray(ann.objects) ? ann.objects : []
              };
              // 清空所有选中状态，避免引用旧 id
              state.selectedIds = { hand: null, keypoint: null, segment: null, relation: null, object: null };
              // 清空历史栈，避免撤销栈引用旧数据
              state.history = [];
              state.historyIndex = -1;
              // 如果有 meta，合并恢复
              if (data.meta && typeof data.meta === 'object') {
                try {
                  state.meta = Object.assign({}, state.meta, data.meta);
                } catch (metaErr) {
                  log('WARN', 'importAnnotations: merge meta failed: ' + (metaErr.message || metaErr));
                }
              }
              // 持久化 + 刷新 UI
              saveToLocalStorage();
              triggerRedraw();
              renderPanel();
              showToast(tt('annotate.import_success', '导入成功'));
              log('IMPORT', 'Imported annotations: ' + JSON.stringify({
                hand_detection: state.annotations.hand_detection.length,
                hand_keypoints: state.annotations.hand_keypoints.length,
                segments: state.annotations.action_segmentation.segments.length,
                hand_object: state.annotations.hand_object.length,
                objects: state.annotations.objects.length
              }));
            } catch (err) {
              showToast(tt('annotate.import_failed', '导入失败: ') + (err.message || err));
              log('ERROR', 'importAnnotations reader.onload failed: ' + (err.message || err));
            }
          };
          reader.readAsText(file);
        } catch (err) {
          log('ERROR', 'importAnnotations onchange failed: ' + (err.message || err));
          showToast(tt('annotate.import_failed', '导入失败: ') + (err.message || err));
        }
      };
      // 触发文件选择器
      document.body.appendChild(input);
      input.click();
      // 异步移除（避免某些浏览器在 click 后立即移除导致 change 不触发）
      setTimeout(function () {
        try {
          if (input.parentNode) {
            input.parentNode.removeChild(input);
          }
        } catch (e) {
          log('WARN', 'importAnnotations: remove input failed: ' + (e.message || e));
        }
      }, 1000);
    } catch (e) {
      log('ERROR', 'importAnnotations failed: ' + (e.message || e));
      showToast(tt('annotate.import_failed', '导入失败: ') + (e.message || e));
    }
  }

  // ===== Toast 提示（简易实现） =====
  var toastTimer = null;
  function showToast(message) {
    try {
      var toast = qs('annotateToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'annotateToast';
        toast.className = 'annotate-toast';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
          'background:var(--color-surface-container-high);color:var(--color-on-surface);' +
          'padding:10px 18px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);' +
          'font-size:13px;font-family:var(--font-body);z-index:2000;box-shadow:0 8px 24px rgba(0,0,0,0.3);' +
          'opacity:0;transition:opacity 0.25s ease;pointer-events:none;';
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.style.opacity = '1';
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
      toastTimer = setTimeout(function () {
        toast.style.opacity = '0';
      }, 2200);
      log('TOAST', message);
    } catch (e) {
      log('ERROR', 'showToast failed: ' + (e.message || e));
    }
  }

  // ===== 面板计数更新 =====
  function updatePanelCount() {
    try {
      if (!dom.panelCount) return;
      var tab = state.activeTab;
      var count = 0;
      if (tab === 'hand_detection') count = state.annotations.hand_detection.length;
      else if (tab === 'keypoints') count = state.annotations.hand_keypoints.length;
      else if (tab === 'action') count = state.annotations.action_segmentation.segments.length;
      else if (tab === 'hand_object') count = state.annotations.hand_object.length;
      dom.panelCount.textContent = String(count);
    } catch (e) {
      log('ERROR', 'updatePanelCount failed: ' + (e.message || e));
    }
  }

  // ===== 阶段 10：更新导出统计 DOM =====
  // 调用 window.AIX_ANNOTATE_EXPORT.getStats() 获取统计，更新到 .annotate-stats 区域
  function updateExportStats() {
    try {
      log('EXPORT', 'updateExportStats start');
      var stats = null;
      if (window.AIX_ANNOTATE_EXPORT && typeof window.AIX_ANNOTATE_EXPORT.getStats === 'function') {
        try {
          stats = window.AIX_ANNOTATE_EXPORT.getStats();
        } catch (e) {
          log('ERROR', 'updateExportStats: getStats failed: ' + (e.message || e));
        }
      }
      if (!stats) {
        log('WARN', 'updateExportStats: AIX_ANNOTATE_EXPORT.getStats unavailable, fallback to local count');
        // 兜底：本地统计
        var ann = state.annotations || {};
        stats = {
          hand_detection: (Array.isArray(ann.hand_detection) ? ann.hand_detection.length : 0),
          hand_keypoints: (Array.isArray(ann.hand_keypoints) ? ann.hand_keypoints.length : 0),
          action_segments: (ann.action_segmentation && Array.isArray(ann.action_segmentation.segments)) ? ann.action_segmentation.segments.length : 0,
          hand_object: (Array.isArray(ann.hand_object) ? ann.hand_object.length : 0),
          objects: (Array.isArray(ann.objects) ? ann.objects.length : 0),
          annotated_frames: 0,
          duration_sec: 0,
          total_frames: state.totalFrames || 0
        };
      }
      // 更新各统计 DOM 元素
      if (dom.statHand) dom.statHand.textContent = String(stats.hand_detection || 0);
      if (dom.statKeypoint) dom.statKeypoint.textContent = String(stats.hand_keypoints || 0);
      if (dom.statSegment) dom.statSegment.textContent = String(stats.action_segments || 0);
      if (dom.statRelation) dom.statRelation.textContent = String(stats.hand_object || 0);
      if (dom.statObjects) dom.statObjects.textContent = String(stats.objects || 0);
      if (dom.statFrames) dom.statFrames.textContent = String(stats.annotated_frames || 0);
      if (dom.statDuration) {
        var dur = stats.duration_sec || 0;
        dom.statDuration.textContent = (dur > 0 ? dur + 's' : '0s');
      }
      log('EXPORT', 'updateExportStats done: ' + JSON.stringify(stats));
    } catch (e) {
      log('ERROR', 'updateExportStats failed: ' + (e.message || e));
    }
  }

  // ===== 绑定事件 =====
  function bindEvents() {
    try {
      // 步骤导航
      if (dom.prevBtn) {
        dom.prevBtn.addEventListener('click', function () {
          prevStep();
        });
      }
      if (dom.nextBtn) {
        dom.nextBtn.addEventListener('click', function () {
          nextStep();
        });
      }

      // 步骤圆圈点击
      if (dom.steps) {
        var circles = qsa('.annotate-step-circle', dom.steps);
        for (var i = 0; i < circles.length; i++) {
          (function (circle) {
            circle.addEventListener('click', function () {
              var step = parseInt(circle.getAttribute('data-step'), 10);
              if (!isNaN(step)) goToStep(step);
            });
          })(circles[i]);
        }
      }

      // Tab 切换
      for (var t = 0; t < dom.tabBtns.length; t++) {
        (function (btn) {
          btn.addEventListener('click', function () {
            var tab = btn.getAttribute('data-tab');
            if (tab) switchTab(tab);
          });
        })(dom.tabBtns[t]);
      }

      // 工具栏按钮
      if (dom.playBtn) dom.playBtn.addEventListener('click', togglePlay);
      if (dom.prevFrameBtn) dom.prevFrameBtn.addEventListener('click', function () { stepFrame(-1); });
      if (dom.nextFrameBtn) dom.nextFrameBtn.addEventListener('click', function () { stepFrame(1); });
      if (dom.goToBtn) dom.goToBtn.addEventListener('click', goToFramePrompt);
      if (dom.speedBtn) dom.speedBtn.addEventListener('click', cyclePlaybackRate);
      if (dom.fullscreenBtn) dom.fullscreenBtn.addEventListener('click', toggleFullscreen);
      if (dom.clearBtn) dom.clearBtn.addEventListener('click', clearAnnotations);
      // 阶段 8：导入标注按钮
      if (dom.importAnnotationsBtn) {
        dom.importAnnotationsBtn.addEventListener('click', function () {
          log('IMPORT', 'Import button clicked');
          importAnnotations();
        });
      }

      // 阶段 10：HDF5 / JSON 导出按钮
      if (dom.exportHdf5Btn) {
        dom.exportHdf5Btn.addEventListener('click', function () {
          log('EXPORT', 'exportHdf5Btn clicked');
          try {
            if (window.AIX_ANNOTATE_EXPORT && typeof window.AIX_ANNOTATE_EXPORT.exportHdf5 === 'function') {
              window.AIX_ANNOTATE_EXPORT.exportHdf5();
            } else {
              log('ERROR', 'AIX_ANNOTATE_EXPORT.exportHdf5 unavailable');
              showToast(tt('annotate.export_unavailable', '导出功能未加载'));
            }
          } catch (e) {
            log('ERROR', 'exportHdf5 click handler failed: ' + (e.message || e));
            showToast(tt('annotate.export_error', '导出失败: ') + (e.message || e));
          }
        });
      }
      if (dom.exportJsonBtn) {
        dom.exportJsonBtn.addEventListener('click', function () {
          log('EXPORT', 'exportJsonBtn clicked');
          try {
            if (window.AIX_ANNOTATE_EXPORT && typeof window.AIX_ANNOTATE_EXPORT.exportJson === 'function') {
              window.AIX_ANNOTATE_EXPORT.exportJson();
            } else {
              log('ERROR', 'AIX_ANNOTATE_EXPORT.exportJson unavailable');
              showToast(tt('annotate.export_unavailable', '导出功能未加载'));
            }
          } catch (e) {
            log('ERROR', 'exportJson click handler failed: ' + (e.message || e));
            showToast(tt('annotate.export_error', '导出失败: ') + (e.message || e));
          }
        });
      }

      // 上传区域
      if (dom.fileSelectBtn) {
        dom.fileSelectBtn.addEventListener('click', function () {
          if (dom.fileInput) dom.fileInput.click();
        });
      }
      if (dom.uploadZone) {
        dom.uploadZone.addEventListener('click', function (e) {
          // 避免点击内部按钮触发两次
          if (e.target === dom.fileSelectBtn || dom.fileSelectBtn && dom.fileSelectBtn.contains(e.target)) return;
          if (dom.fileInput) dom.fileInput.click();
        });
        // 拖拽事件（Task 2.1：实际加载逻辑）
        dom.uploadZone.addEventListener('dragover', function (e) {
          try {
            e.preventDefault();
            e.stopPropagation();
            // 必须 dropEffect 才能让 drop 事件触发
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            dom.uploadZone.classList.add('dragover');
          } catch (err) {
            log('ERROR', 'dragover handler failed: ' + (err.message || err));
          }
        });
        dom.uploadZone.addEventListener('dragleave', function (e) {
          try {
            // 只有离开外框才移除高亮，避免子元素切换抖动
            if (e.target === dom.uploadZone) {
              dom.uploadZone.classList.remove('dragover');
            }
          } catch (err) {
            log('ERROR', 'dragleave handler failed: ' + (err.message || err));
          }
        });
        dom.uploadZone.addEventListener('drop', handleDrop);
      }

      // 视频播放事件（timeupdate 同步帧号 / 时间戳 / 进度条）
      if (dom.video) {
        dom.video.addEventListener('timeupdate', function () {
          try {
            if (!dom.video || dom.video.readyState < 2 || state.fps <= 0) return;
            var newFrame = Math.round(dom.video.currentTime * state.fps);
            if (state.totalFrames > 0 && newFrame > state.totalFrames - 1) {
              newFrame = state.totalFrames - 1;
            }
            if (newFrame < 0) newFrame = 0;
            var changed = (newFrame !== state.currentFrame);
            state.currentFrame = newFrame;
            updateFrameDisplay();
            if (changed && typeof window.AIX_ANNOTATE.onFrameChange === 'function') {
              try {
                window.AIX_ANNOTATE.onFrameChange(newFrame);
              } catch (e) {
                log('ERROR', 'onFrameChange callback failed: ' + (e.message || e));
              }
            }
          } catch (e) {
            log('ERROR', 'timeupdate handler failed: ' + (e.message || e));
          }
        });
        dom.video.addEventListener('play', function () {
          try {
            state.isPlaying = true;
            updatePlayBtnIcon();
            updatePreviewPlayBtnIcon();  // 阶段 9：同步预览播放按钮图标
            log('PLAY', 'Video play event');
          } catch (e) {
            log('ERROR', 'play event handler failed: ' + (e.message || e));
          }
        });
        dom.video.addEventListener('pause', function () {
          try {
            state.isPlaying = false;
            updatePlayBtnIcon();
            updatePreviewPlayBtnIcon();  // 阶段 9：同步预览播放按钮图标
            log('PLAY', 'Video pause event');
          } catch (e) {
            log('ERROR', 'pause event handler failed: ' + (e.message || e));
          }
        });
        dom.video.addEventListener('ended', function () {
          try {
            state.isPlaying = false;
            updatePlayBtnIcon();
            updatePreviewPlayBtnIcon();  // 阶段 9：同步预览播放按钮图标
            log('PLAY', 'Video ended');
          } catch (e) {
            log('ERROR', 'ended event handler failed: ' + (e.message || e));
          }
        });
        dom.video.addEventListener('loadeddata', function () {
          try {
            log('FILE', 'Video loadeddata event, readyState=' + dom.video.readyState);
            updateFrameDisplay();
          } catch (e) {
            log('ERROR', 'loadeddata handler failed: ' + (e.message || e));
          }
        });
        dom.video.addEventListener('error', function (e) {
          try {
            var errInfo = '';
            if (dom.video.error) {
              errInfo = 'code=' + dom.video.error.code;
            }
            log('ERROR', 'Video error event: ' + errInfo);
            showToast(tt('annotate.err_video_load', '视频加载失败'));
          } catch (err) {
            log('ERROR', 'video error handler failed: ' + (err.message || err));
          }
        });
      }

      // 进度条拖拽事件（Task 2.2）
      if (dom.progress) {
        // 标记拖拽状态，避免 timeupdate 反推 value
        dom.progress._isDragging = false;
        dom.progress.addEventListener('mousedown', function () {
          try {
            dom.progress._isDragging = true;
            // 拖拽时暂停视频
            if (dom.video && !dom.video.paused) {
              dom.video.pause();
              state.isPlaying = false;
              updatePlayBtnIcon();
            }
          } catch (e) {
            log('ERROR', 'progress mousedown handler failed: ' + (e.message || e));
          }
        });
        dom.progress.addEventListener('input', function () {
          try {
            if (!dom.video || dom.video.readyState < 2 || state.videoDuration <= 0) return;
            var value = parseFloat(dom.progress.value);
            var ratio = value / 1000;
            if (ratio < 0) ratio = 0;
            if (ratio > 1) ratio = 1;
            var newTime = ratio * state.videoDuration;
            try {
              dom.video.currentTime = newTime;
            } catch (e) {
              log('ERROR', 'progress seek failed: ' + (e.message || e));
              return;
            }
            var newFrame = Math.round(newTime * state.fps);
            if (state.totalFrames > 0 && newFrame > state.totalFrames - 1) {
              newFrame = state.totalFrames - 1;
            }
            state.currentFrame = newFrame;
            updateFrameDisplay();
          } catch (e) {
            log('ERROR', 'progress input handler failed: ' + (e.message || e));
          }
        });
        // 拖拽结束（mouseup 或 change）
        function endDrag() {
          try {
            dom.progress._isDragging = false;
            if (typeof window.AIX_ANNOTATE.onFrameChange === 'function' && state.currentFrame >= 0) {
              try {
                window.AIX_ANNOTATE.onFrameChange(state.currentFrame);
              } catch (e) {
                log('ERROR', 'onFrameChange after progress drag failed: ' + (e.message || e));
              }
            }
          } catch (e) {
            log('ERROR', 'progress endDrag failed: ' + (e.message || e));
          }
        }
        dom.progress.addEventListener('mouseup', endDrag);
        dom.progress.addEventListener('change', endDrag);
        dom.progress.addEventListener('touchend', endDrag);
      }
      if (dom.fileInput) {
        dom.fileInput.addEventListener('change', function (e) {
          if (e.target.files && e.target.files.length > 0) {
            handleFileSelect(e.target.files[0]);
          }
        });
      }
      if (dom.removeFileBtn) {
        dom.removeFileBtn.addEventListener('click', function () {
          removeFile();
        });
      }

      // 弹窗
      if (dom.modalCloseBtn) dom.modalCloseBtn.addEventListener('click', hideModal);
      if (dom.modalCancelBtn) dom.modalCancelBtn.addEventListener('click', hideModal);
      if (dom.modalOverlay) dom.modalOverlay.addEventListener('click', hideModal);
      if (dom.modalConfirmBtn) {
        dom.modalConfirmBtn.addEventListener('click', function () {
          try {
            if (typeof dom.modalConfirmCallback === 'function') {
              dom.modalConfirmCallback();
            } else {
              hideModal();
            }
          } catch (e) {
            log('ERROR', 'modal confirm callback failed: ' + (e.message || e));
            hideModal();
          }
        });
      }

      // ESC 关闭弹窗
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && dom.modal && !dom.modal.hasAttribute('hidden')) {
          hideModal();
        }
      });

      // 元信息表单双向绑定
      bindMetaForm();

      // 快捷键
      bindShortcuts();

      // 阶段 4：属性面板（遮挡属性）单选按钮事件
      bindHandDetectionAttrPanel();

      // 阶段 5：关键点面板事件（手选择器、复制上一帧、清除当前帧）
      bindKeypointsPanelEvents();

      // 阶段 6：动作分割 — 时间轴事件（滚轮缩放、拖选、点击跳帧、双击编辑、边缘拖拽）
      try {
        if (typeof bindTimelineEvents === 'function') {
          bindTimelineEvents();
        }
      } catch (eTL) {
        log('ERROR', 'bindTimelineEvents in bindEvents failed: ' + (eTL.message || eTL));
      }

      // 阶段 6：动作分割 — 添加标签按钮
      if (dom.addActionLabelBtn) {
        dom.addActionLabelBtn.addEventListener('click', function () {
          try {
            // 弹窗输入新标签名
            showActionLabelModal(function onSelect(name) {
              try {
                addActionLabel(name);
              } catch (eAL) {
                log('ERROR', 'addActionLabel from button failed: ' + (eAL.message || eAL));
              }
            });
          } catch (eBtn) {
            log('ERROR', 'addActionLabelBtn click handler failed: ' + (eBtn.message || eBtn));
          }
        });
        log('INIT', 'addActionLabelBtn click event bound');
      }

      // 阶段 7：手物交互 — 添加关系按钮
      if (dom.addRelationBtn) {
        dom.addRelationBtn.addEventListener('click', function () {
          try {
            showAddRelationModal();
          } catch (eRel) {
            log('ERROR', 'addRelationBtn click handler failed: ' + (eRel.message || eRel));
          }
        });
        log('INIT', 'addRelationBtn click event bound');
      }

      // 阶段 9：预览回放 — 控制条事件
      // 播放/暂停按钮（复用 togglePlay）
      if (dom.previewPlayBtn) {
        dom.previewPlayBtn.addEventListener('click', function () {
          try {
            togglePlay();
            // togglePlay 内部异步设置 state.isPlaying，立即刷新图标
            setTimeout(updatePreviewPlayBtnIcon, 50);
          } catch (e) {
            log('ERROR', 'previewPlayBtn click handler failed: ' + (e.message || e));
          }
        });
        log('INIT', 'previewPlayBtn click event bound');
      }

      // 倍速按钮（复用 cyclePlaybackRate）
      if (dom.previewSpeedBtn) {
        dom.previewSpeedBtn.addEventListener('click', function () {
          try {
            cyclePlaybackRate(); // 内部已调用 updatePreviewSpeedLabel
          } catch (e) {
            log('ERROR', 'previewSpeedBtn click handler failed: ' + (e.message || e));
          }
        });
        log('INIT', 'previewSpeedBtn click event bound');
      }

      // 进度条拖拽（与步骤 3 进度条逻辑一致，独立维护 _isDragging 标志）
      if (dom.previewProgress) {
        dom.previewProgress._isDragging = false;
        dom.previewProgress.addEventListener('mousedown', function () {
          try {
            dom.previewProgress._isDragging = true;
            // 拖拽时暂停视频
            if (dom.video && !dom.video.paused) {
              dom.video.pause();
              state.isPlaying = false;
              updatePlayBtnIcon();
              updatePreviewPlayBtnIcon();
            }
          } catch (e) {
            log('ERROR', 'previewProgress mousedown handler failed: ' + (e.message || e));
          }
        });
        dom.previewProgress.addEventListener('input', function () {
          try {
            if (!dom.video || dom.video.readyState < 2 || state.videoDuration <= 0) return;
            var value = parseFloat(dom.previewProgress.value);
            var ratio = value / 1000;
            if (ratio < 0) ratio = 0;
            if (ratio > 1) ratio = 1;
            var newTime = ratio * state.videoDuration;
            try {
              dom.video.currentTime = newTime;
            } catch (e) {
              log('ERROR', 'previewProgress seek failed: ' + (e.message || e));
              return;
            }
            var newFrame = Math.round(newTime * state.fps);
            if (state.totalFrames > 0 && newFrame > state.totalFrames - 1) {
              newFrame = state.totalFrames - 1;
            }
            if (newFrame < 0) newFrame = 0;
            state.currentFrame = newFrame;
            // 更新时间显示（不触发完整的 updateFrameDisplay 以避免循环反推）
            updatePreviewTimeLabel();
            if (dom.frameLabel) {
              dom.frameLabel.textContent = 'Frame: ' + (newFrame + 1) + ' / ' + state.totalFrames;
            }
          } catch (e) {
            log('ERROR', 'previewProgress input handler failed: ' + (e.message || e));
          }
        });
        function endPreviewDrag() {
          try {
            dom.previewProgress._isDragging = false;
            // 触发 onFrameChange 回调（让 canvas 重绘标注）
            if (typeof window.AIX_ANNOTATE.onFrameChange === 'function' && state.currentFrame >= 0) {
              try {
                window.AIX_ANNOTATE.onFrameChange(state.currentFrame);
              } catch (e) {
                log('ERROR', 'onFrameChange after preview drag failed: ' + (e.message || e));
              }
            }
          } catch (e) {
            log('ERROR', 'previewProgress endDrag failed: ' + (e.message || e));
          }
        }
        dom.previewProgress.addEventListener('mouseup', endPreviewDrag);
        dom.previewProgress.addEventListener('change', endPreviewDrag);
        dom.previewProgress.addEventListener('touchend', endPreviewDrag);
        log('INIT', 'previewProgress events bound');
      }

      // 返回标注按钮
      if (dom.previewBackBtn) {
        dom.previewBackBtn.addEventListener('click', function () {
          try {
            log('PREVIEW', 'Back to annotate button clicked');
            goToStep(3);
          } catch (e) {
            log('ERROR', 'previewBackBtn click handler failed: ' + (e.message || e));
          }
        });
        log('INIT', 'previewBackBtn click event bound');
      }

      // 4 个显示开关 checkbox
      function bindPreviewToggle(el, name) {
        if (!el) return;
        el.addEventListener('change', function () {
          try {
            syncPreviewVisibleFlags();
            if (window.AIX_ANNOTATE_CANVAS && typeof window.AIX_ANNOTATE_CANVAS.render === 'function') {
              window.AIX_ANNOTATE_CANVAS.render();
            }
            log('PREVIEW', name + ' toggle changed: ' + el.checked);
          } catch (e) {
            log('ERROR', name + ' toggle handler failed: ' + (e.message || e));
          }
        });
        log('INIT', name + ' toggle event bound');
      }
      bindPreviewToggle(dom.previewShowHand, 'previewShowHand');
      bindPreviewToggle(dom.previewShowKeypoint, 'previewShowKeypoint');
      bindPreviewToggle(dom.previewShowAction, 'previewShowAction');
      bindPreviewToggle(dom.previewShowHandObject, 'previewShowHandObject');

      log('INIT', 'All events bound');
    } catch (e) {
      log('ERROR', 'bindEvents failed: ' + (e.message || e));
    }
  }

  function bindMetaForm() {
    try {
      var fields = [
        { el: dom.sceneTypeInput, key: 'scene_type' },
        { el: dom.deviceInput, key: 'device' },
        { el: dom.collectorInput, key: 'collector' },
        { el: dom.dateInput, key: 'date' },
        { el: dom.fpsInput, key: 'fps', isNumber: true },
        { el: dom.remarkInput, key: 'remark' }
      ];
      for (var i = 0; i < fields.length; i++) {
        (function (f) {
          if (!f.el) return;
          // 通用处理：保存到 state.meta，并处理 fps 联动
          function handleValue() {
            try {
              var val = f.el.value;
              if (f.isNumber) {
                var n = parseFloat(val);
                // FPS 必须在 1-240 之间，无效则回退到 30
                if (isNaN(n) || n <= 0 || n > 240) {
                  n = 30;
                  if (f.key === 'fps' && f.el) f.el.value = '30';
                }
                val = n;
              }
              state.meta[f.key] = val;
              // FPS 联动：重新计算 totalFrames
              if (f.key === 'fps') {
                state.fps = val;
                if (state.videoDuration > 0) {
                  var oldTotal = state.totalFrames;
                  state.totalFrames = Math.round(state.videoDuration * state.fps);
                  if (oldTotal !== state.totalFrames) {
                    log('META', 'totalFrames recalculated: ' + oldTotal + ' -> ' + state.totalFrames);
                    updateFrameDisplay();
                    updateFileInfoUI();
                  }
                }
              }
              log('META', f.key + ' = ' + val);
              saveToLocalStorage();
            } catch (e) {
              log('ERROR', 'meta field handler failed for ' + f.key + ': ' + (e.message || e));
            }
          }
          // input 事件实时保存
          f.el.addEventListener('input', handleValue);
          // change 事件（select / date 等控件兼容）
          f.el.addEventListener('change', handleValue);
        })(fields[i]);
      }

      // 采集日期默认为今天（如果未设置）
      if (dom.dateInput && !dom.dateInput.value) {
        try {
          var today = new Date();
          var yyyy = today.getFullYear();
          var mm = String(today.getMonth() + 1).padStart(2, '0');
          var dd = String(today.getDate()).padStart(2, '0');
          var todayStr = yyyy + '-' + mm + '-' + dd;
          dom.dateInput.value = todayStr;
          state.meta.date = todayStr;
          log('META', 'Default date set: ' + todayStr);
          saveToLocalStorage();
        } catch (e) {
          log('WARN', 'Set default date failed: ' + (e.message || e));
        }
      }
    } catch (e) {
      log('ERROR', 'bindMetaForm failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.2：绑定遮挡属性面板单选按钮事件 =====
  function bindHandDetectionAttrPanel() {
    try {
      var panel = qs('handDetectionAttrPanel');
      if (!panel) {
        log('WARN', 'bindHandDetectionAttrPanel: panel not found');
        return;
      }
      var radios = panel.querySelectorAll('input[name="occlusion"]');
      for (var i = 0; i < radios.length; i++) {
        (function (radio) {
          radio.addEventListener('change', function () {
            try {
              if (!radio.checked) return;
              var occlusion = radio.value;
              var selectedId = state.selectedIds.hand;
              if (!selectedId) {
                log('WARN', 'occlusion radio change: no selected hand annotation');
                return;
              }
              setHandOcclusion(selectedId, occlusion);
            } catch (e) {
              log('ERROR', 'occlusion radio change handler failed: ' + (e.message || e));
            }
          });
        })(radios[i]);
      }
      log('INIT', 'Hand detection attr panel radios bound, count=' + radios.length);
    } catch (e) {
      log('ERROR', 'bindHandDetectionAttrPanel failed: ' + (e.message || e));
    }
  }

  // ===== 文件选择处理（Task 2.1：完整实现视频加载） =====
  function handleFileSelect(file) {
    try {
      if (!file) {
        log('WARN', 'handleFileSelect: no file');
        return;
      }

      // 文件名 / 扩展名
      var fileName = file.name || 'unknown';
      var dotIdx = fileName.lastIndexOf('.');
      var ext = dotIdx >= 0 ? fileName.substring(dotIdx + 1).toLowerCase() : '';
      var isValidExt = SUPPORTED_VIDEO_EXTS.indexOf(ext) >= 0;
      // 兼容部分浏览器对 mov/avi 的 type 解析
      var isValidType = !!file.type && (
        file.type === 'video/mp4' ||
        file.type === 'video/quicktime' ||
        file.type === 'video/x-msvideo' ||
        file.type === 'video/avi'
      );

      // 格式校验：扩展名或 type 任一通过即可
      if (!isValidExt && !isValidType) {
        log('WARN', 'handleFileSelect: unsupported format, name=' + fileName + ' type=' + file.type);
        showToast(tt('annotate.err_unsupported_format', '不支持的格式，仅支持 MP4/MOV/AVI'));
        return;
      }

      // 大小校验
      if (file.size > MAX_FILE_SIZE) {
        log('WARN', 'handleFileSelect: file too large ' + file.size + ' bytes');
        showToast(tt('annotate.err_too_large', '文件超过 500MB 限制'));
        return;
      }

      // 清理旧的 ObjectURL
      if (state.videoUrl) {
        try { URL.revokeObjectURL(state.videoUrl); } catch (e) {
          log('WARN', 'revokeObjectURL old url failed: ' + (e.message || e));
        }
        state.videoUrl = null;
      }

      // 创建新的 ObjectURL
      var url;
      try {
        url = URL.createObjectURL(file);
      } catch (e) {
        log('ERROR', 'handleFileSelect: createObjectURL failed: ' + (e.message || e));
        showToast(tt('annotate.err_create_url', '创建视频地址失败: ' + (e.message || e)));
        return;
      }

      // 更新 state
      state.videoFile = file;
      state.videoFileName = fileName;
      state.videoFileSize = file.size;
      state.videoUrl = url;
      // 重置视频元信息（待检测）
      state.videoDuration = 0;
      state.videoResolution = [0, 0];
      state.fps = 30;
      state.meta.fps = 30;
      state.totalFrames = 0;
      state.currentFrame = 0;

      log('FILE', 'Selected: ' + fileName + ' (' + formatFileSize(file.size) + ', type=' + (file.type || 'unknown') + ')');

      // 更新 UI（文件信息区先显示基础信息，元数据稍后异步补充）
      if (dom.fileName) dom.fileName.textContent = fileName;
      updateFileInfoUI();
      if (dom.fileInfo) dom.fileInfo.removeAttribute('hidden');

      // 隐藏空提示
      if (dom.emptyHint) dom.emptyHint.setAttribute('hidden', '');

      // 加载到 video 元素
      if (!dom.video) {
        log('ERROR', 'handleFileSelect: video element not found');
        showToast(tt('annotate.err_no_video_element', '视频元素未找到'));
        return;
      }

      try {
        dom.video.src = url;
        // 主动触发 load（部分浏览器需要）
        dom.video.load();
      } catch (e) {
        log('ERROR', 'handleFileSelect: set video.src failed: ' + (e.message || e));
        showToast(tt('annotate.err_load_failed', '加载视频失败: ' + (e.message || e)));
        return;
      }

      // 检测元数据
      detectVideoMetadata(function () {
        try {
          log('FILE', 'Video ready, duration=' + state.videoDuration + 's fps=' + state.fps + ' totalFrames=' + state.totalFrames);
          showToast(tt('annotate.file_loaded', '视频加载完成: ' + fileName));

          // 启用「下一步」按钮（如果之前 disabled）
          if (dom.nextBtn && dom.nextBtn.disabled) {
            dom.nextBtn.disabled = false;
            dom.nextBtn.style.opacity = '1';
            dom.nextBtn.style.cursor = 'pointer';
          }

          // 更新显示
          updateFrameDisplay();
          updateFileInfoUI();
          saveToLocalStorage();
        } catch (e) {
          log('ERROR', 'handleFileSelect onMetadata callback failed: ' + (e.message || e));
        }
      });

      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'handleFileSelect failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '加载视频失败: ' + (e.message || e)));
    }
  }

  // ===== 拖拽事件处理 =====
  function handleDrop(e) {
    try {
      if (!e) return;
      e.preventDefault();
      e.stopPropagation();

      if (dom.uploadZone) {
        dom.uploadZone.classList.remove('dragover');
      }

      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) {
        log('WARN', 'handleDrop: no files in dataTransfer');
        return;
      }

      var file = files[0];
      log('FILE', 'Drop event: ' + (file.name || 'unknown'));
      handleFileSelect(file);
    } catch (err) {
      log('ERROR', 'handleDrop failed: ' + (err.message || err));
      showToast(tt('annotate.err_load_failed', '拖拽加载失败: ' + (err.message || err)));
    }
  }

  // ===== 视频元数据检测（Task 2.1）=====
  function detectVideoMetadata(callback) {
    try {
      if (!dom.video) {
        log('ERROR', 'detectVideoMetadata: video element not found');
        if (typeof callback === 'function') callback();
        return;
      }
      var video = dom.video;

      function onMetadataLoaded() {
        try {
          var width = video.videoWidth || 0;
          var height = video.videoHeight || 0;
          var duration = video.duration || 0;

          // 部分浏览器对 webm/avi 的 duration 可能是 Infinity
          if (!isFinite(duration) || duration <= 0) {
            log('WARN', 'detectVideoMetadata: invalid duration=' + duration + ', will retry');
            // 短延时重试一次
            setTimeout(function () {
              var d = video.duration;
              if (isFinite(d) && d > 0) {
                applyMetadata(width, height, d);
              } else {
                log('ERROR', 'detectVideoMetadata: duration still invalid, use 0');
                applyMetadata(width, height, 0);
              }
            }, 200);
            return;
          }
          applyMetadata(width, height, duration);
        } catch (e) {
          log('ERROR', 'detectVideoMetadata onMetadataLoaded failed: ' + (e.message || e));
          if (typeof callback === 'function') callback();
        }
      }

      function applyMetadata(width, height, duration) {
        try {
          state.videoResolution = [width, height];
          state.videoDuration = duration;
          state.meta.resolution = [width, height];

          log('FILE', 'Metadata loaded: ' + width + 'x' + height + ', duration=' + duration + 's');

          // 更新分辨率显示
          if (dom.resolutionInput && width > 0 && height > 0) {
            dom.resolutionInput.value = width + ' × ' + height;
          }
          updateFileInfoUI();

          // 检测 FPS
          detectFps(function (fps) {
            try {
              state.fps = fps;
              state.meta.fps = fps;
              state.totalFrames = duration > 0 ? Math.round(duration * fps) : 0;

              if (dom.fpsInput) dom.fpsInput.value = fps;

              log('FILE', 'FPS detected: ' + fps + ', totalFrames=' + state.totalFrames);

              saveToLocalStorage();
              updateFrameDisplay();
              updateFileInfoUI();

              if (typeof callback === 'function') callback();
            } catch (e) {
              log('ERROR', 'detectFps callback failed: ' + (e.message || e));
              if (typeof callback === 'function') callback();
            }
          });
        } catch (e) {
          log('ERROR', 'applyMetadata failed: ' + (e.message || e));
          if (typeof callback === 'function') callback();
        }
      }

      if (video.readyState >= 1) {
        onMetadataLoaded();
      } else {
        video.addEventListener('loadedmetadata', onMetadataLoaded, { once: true });
        // 超时保护
        setTimeout(function () {
          if (video.readyState < 1) {
            log('WARN', 'detectVideoMetadata: timeout waiting for loadedmetadata');
            if (typeof callback === 'function') callback();
          }
        }, 10000);
      }
    } catch (e) {
      log('ERROR', 'detectVideoMetadata failed: ' + (e.message || e));
      if (typeof callback === 'function') callback();
    }
  }

  // ===== FPS 检测（通过 requestVideoFrameCallback）=====
  function detectFps(callback) {
    try {
      var video = dom.video;
      if (!video) {
        log('WARN', 'detectFps: no video element');
        if (typeof callback === 'function') callback(30);
        return;
      }

      // 不支持 rVFC API，回退到 30
      if (typeof video.requestVideoFrameCallback !== 'function') {
        log('FILE', 'requestVideoFrameCallback not supported, fallback to 30 fps');
        if (typeof callback === 'function') callback(30);
        return;
      }

      var firstMediaTime = null;
      var done = false;
      var timeoutId = null;
      var wasMuted = video.muted;
      var wasPaused = video.paused;

      // 静音播放以触发 rVFC
      try {
        video.muted = true;
        video.currentTime = 0;
      } catch (e) {
        log('WARN', 'detectFps: reset currentTime failed: ' + (e.message || e));
      }

      function cleanup() {
        try {
          if (timeoutId) clearTimeout(timeoutId);
          if (!wasPaused) {
            // 保持原状态（之前未暂停则继续播放）
          } else {
            video.pause();
          }
          video.muted = wasMuted;
        } catch (e) {
          log('WARN', 'detectFps cleanup failed: ' + (e.message || e));
        }
      }

      function onFrame(now, metadata) {
        if (done) return;
        if (firstMediaTime === null) {
          firstMediaTime = metadata.mediaTime;
          try { video.requestVideoFrameCallback(onFrame); } catch (e) {
            log('WARN', 'rVFC re-register failed: ' + (e.message || e));
            done = true;
            cleanup();
            if (typeof callback === 'function') callback(30);
          }
        } else {
          var secondMediaTime = metadata.mediaTime;
          var diff = secondMediaTime - firstMediaTime;
          if (diff > 0) {
            done = true;
            var fps = Math.round(1 / diff);
            // 限制到合理范围
            if (fps < 1 || fps > 240) {
              log('WARN', 'detectFps: unreasonable fps=' + fps + ', fallback to 30');
              fps = 30;
            }
            log('FILE', 'FPS detected via rVFC: ' + fps + ' (diff=' + diff + ')');
            cleanup();
            if (typeof callback === 'function') callback(fps);
          } else {
            // diff <= 0，继续等待下一帧
            try { video.requestVideoFrameCallback(onFrame); } catch (e) {
              log('WARN', 'rVFC re-register failed (diff<=0): ' + (e.message || e));
              done = true;
              cleanup();
              if (typeof callback === 'function') callback(30);
            }
          }
        }
      }

      // 1 秒内检测不到 2 帧，回退到 30
      timeoutId = setTimeout(function () {
        if (done) return;
        done = true;
        log('WARN', 'FPS detection timeout (1s), fallback to 30');
        cleanup();
        if (typeof callback === 'function') callback(30);
      }, 1000);

      try {
        video.requestVideoFrameCallback(onFrame);
        var playPromise = video.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch(function (e) {
            log('WARN', 'detectFps: play() for rVFC failed: ' + (e.message || e));
            // 失败则回退到 30，但不立即返回（等待 timeout 或后续 rVFC 触发）
          });
        }
      } catch (e) {
        log('ERROR', 'detectFps: rVFC init failed: ' + (e.message || e));
        if (!done) {
          done = true;
          cleanup();
          if (typeof callback === 'function') callback(30);
        }
      }
    } catch (e) {
      log('ERROR', 'detectFps failed: ' + (e.message || e));
      if (typeof callback === 'function') callback(30);
    }
  }

  // ===== 文件信息 UI 更新（文件名、大小、分辨率、时长、FPS、总帧数）=====
  function updateFileInfoUI() {
    try {
      if (!dom.fileMeta) return;
      var parts = [];
      if (state.videoFileSize) parts.push(formatFileSize(state.videoFileSize));
      if (state.videoResolution && state.videoResolution[0] > 0 && state.videoResolution[1] > 0) {
        parts.push(state.videoResolution[0] + ' × ' + state.videoResolution[1]);
      }
      if (state.videoDuration > 0) parts.push(formatTime(state.videoDuration));
      if (state.fps > 0) parts.push(state.fps + ' FPS');
      if (state.totalFrames > 0) parts.push(state.totalFrames + ' frames');
      dom.fileMeta.textContent = parts.length > 0 ? parts.join(' · ') : '—';
    } catch (e) {
      log('ERROR', 'updateFileInfoUI failed: ' + (e.message || e));
    }
  }

  function removeFile() {
    try {
      showModal({
        title: tt('annotate.remove_file_title', '移除视频'),
        body: '<p>' + tt('annotate.remove_file_body', '移除当前视频将清空已加载的视频和标注元信息（标注数据保留）。确定继续吗？') + '</p>',
        confirmText: tt('annotate.remove_file_btn', '移除'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            if (state.videoUrl) {
              try { URL.revokeObjectURL(state.videoUrl); } catch (e) {}
              state.videoUrl = null;
            }
            state.videoFile = null;
            state.videoFileName = '';
            state.videoFileSize = 0;
            state.videoDuration = 0;
            state.videoResolution = [0, 0];
            state.totalFrames = 0;
            state.currentFrame = 0;

            if (dom.video) {
              try { dom.video.removeAttribute('src'); dom.video.load(); } catch (e) {}
            }
            if (dom.fileInfo) dom.fileInfo.setAttribute('hidden', '');
            if (dom.fileInput) dom.fileInput.value = '';
            // 显示空提示
            if (dom.emptyHint) dom.emptyHint.removeAttribute('hidden');
            // 重置进度条 / 时间戳 / 帧号
            updateFrameDisplay();
            // 重置文件信息显示
            updateFileInfoUI();

            log('FILE', 'Removed');
            hideModal();
            saveToLocalStorage();
            triggerRedraw();
          } catch (e) {
            log('ERROR', 'removeFile onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'removeFile failed: ' + (e.message || e));
    }
  }

  function formatFileSize(bytes) {
    try {
      if (!bytes || bytes <= 0) return '0.00 MB';
      var mb = bytes / (1024 * 1024);
      // 超过 1024 MB 用 GB 显示，避免数字过长
      if (mb >= 1024) {
        return (mb / 1024).toFixed(2) + ' GB';
      }
      return mb.toFixed(2) + ' MB';
    } catch (e) {
      log('ERROR', 'formatFileSize failed: ' + (e.message || e));
      return '0.00 MB';
    }
  }

  // ============================================================
  // 阶段 4：手部检测（Task 4.1 - 4.5）
  // ============================================================

  // ===== 工具：线性插值 =====
  function lerp(a, b, t) {
    try {
      return a + (b - a) * t;
    } catch (e) {
      log('ERROR', 'lerp failed: ' + (e.message || e));
      return a;
    }
  }

  // ===== 工具：生成标注 ID =====
  function genHandDetectionId(prefix) {
    try {
      prefix = prefix || 'hd';
      return prefix + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    } catch (e) {
      // 回退到纯时间戳
      return prefix + '_' + Date.now() + '_fallback';
    }
  }

  // ===== Task 4.3：跨帧插值重新计算 =====
  function recomputeInterpolation() {
    try {
      var list = state.annotations.hand_detection;
      if (!Array.isArray(list)) {
        log('WARN', 'recomputeInterpolation: hand_detection is not an array');
        return;
      }

      // 1. 保留所有手动标注（interpolated !== true）
      var manualList = [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a && a.interpolated !== true) {
          manualList.push(a);
        }
      }

      // 2. 按 hand 分组（left / right）
      var groups = { left: [], right: [] };
      for (var k = 0; k < manualList.length; k++) {
        var m = manualList[k];
        if (m.hand === 'left' || m.hand === 'right') {
          groups[m.hand].push(m);
        } else {
          log('WARN', 'recomputeInterpolation: unknown hand value=' + m.hand + ' id=' + m.id);
        }
      }

      // 3. 每组按 frame_idx 排序
      groups.left.sort(function (x, y) { return x.frame_idx - y.frame_idx; });
      groups.right.sort(function (x, y) { return x.frame_idx - y.frame_idx; });

      // 4. 对相邻两个手动标注之间的所有帧创建插值标注
      var interpolated = [];
      var handKeys = ['left', 'right'];
      for (var g = 0; g < handKeys.length; g++) {
        var group = groups[handKeys[g]];
        for (var idx = 0; idx < group.length - 1; idx++) {
          var start = group[idx];
          var end = group[idx + 1];
          var fStart = start.frame_idx;
          var fEnd = end.frame_idx;
          if (fEnd - fStart <= 1) continue;  // 相邻帧无需插值
          for (var f = fStart + 1; f < fEnd; f++) {
            var t = (f - fStart) / (fEnd - fStart);
            var bbox = [
              lerp(start.bbox[0], end.bbox[0], t),
              lerp(start.bbox[1], end.bbox[1], t),
              lerp(start.bbox[2], end.bbox[2], t),
              lerp(start.bbox[3], end.bbox[3], t)
            ];
            interpolated.push({
              id: genHandDetectionId('hd') + '_i' + f,
              frame_idx: f,
              hand: handKeys[g],
              bbox: bbox,
              occlusion: start.occlusion || 'visible',
              interpolated: true
            });
          }
        }
      }

      // 5. 合并：手动标注 + 插值标注（按 frame_idx 排序便于查看）
      var newList = manualList.concat(interpolated);
      newList.sort(function (x, y) { return x.frame_idx - y.frame_idx; });

      state.annotations.hand_detection = newList;
      log('HAND', 'recomputeInterpolation: manual=' + manualList.length +
        ' interpolated=' + interpolated.length + ' total=' + newList.length);
    } catch (e) {
      log('ERROR', 'recomputeInterpolation failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.1：手部选择弹窗（左手/右手/取消） =====
  function showHandSelectionModal(onSelect) {
    try {
      var body =
        '<p style="text-align:center;margin:0 0 16px 0;font-size:14px;color:var(--color-on-surface-variant);">' +
          tt('annotate.hd_select_prompt', '请选择手部类型') +
        '</p>' +
        '<div style="display:flex;gap:16px;justify-content:center;align-items:center;">' +
          '<button type="button" id="hdSelectLeft" class="annotate-btn" style="background:#22c55e;color:#fff;min-width:130px;justify-content:center;">' +
            '<span class="material-symbols-outlined">back_hand</span>' +
            '<span>' + tt('annotate.hd_left', '左手 (L)') + '</span>' +
          '</button>' +
          '<button type="button" id="hdSelectRight" class="annotate-btn" style="background:#3b82f6;color:#fff;min-width:130px;justify-content:center;">' +
            '<span class="material-symbols-outlined" style="transform:scaleX(-1);display:inline-block;">back_hand</span>' +
            '<span>' + tt('annotate.hd_right', '右手 (R)') + '</span>' +
          '</button>' +
        '</div>';

      showModal({
        title: tt('annotate.hd_select_title', '选择手部'),
        body: body,
        cancelText: tt('annotate.hd_discard', '放弃这次标注'),
        onConfirm: function () {
          // 不会触发，因为 confirm 按钮被隐藏
          log('WARN', 'hd modal: confirm button should be hidden');
        }
      });

      // 隐藏 confirm 按钮（本弹窗只需左手/右手/取消三选项）
      if (dom.modalConfirmBtn) dom.modalConfirmBtn.style.display = 'none';

      // 绑定按钮事件
      var leftBtn = qs('hdSelectLeft');
      var rightBtn = qs('hdSelectRight');

      function handleSelect(hand) {
        try {
          hideModal();
          if (typeof onSelect === 'function') {
            onSelect(hand);
          }
          log('HAND', 'selected hand=' + hand);
        } catch (e) {
          log('ERROR', 'hand select handler failed: ' + (e.message || e));
        }
      }

      if (leftBtn) {
        leftBtn.onclick = function () {
          handleSelect('left');
        };
      } else {
        log('WARN', 'showHandSelectionModal: hdSelectLeft button not found');
      }
      if (rightBtn) {
        rightBtn.onclick = function () {
          handleSelect('right');
        };
      } else {
        log('WARN', 'showHandSelectionModal: hdSelectRight button not found');
      }
    } catch (e) {
      log('ERROR', 'showHandSelectionModal failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.1：手部检测 - 绘制完成处理 =====
  function handleHandDetectionDrawComplete(rect) {
    try {
      if (!rect || rect.length < 4) {
        log('WARN', 'handleHandDetectionDrawComplete: invalid rect');
        return;
      }
      // 复制一份数据，避免后续被修改
      var bbox = [rect[0], rect[1], rect[2], rect[3]];
      log('HAND', 'draw complete, showing hand selection modal, bbox=' +
        JSON.stringify(bbox) + ' frame=' + state.currentFrame);

      showHandSelectionModal(function (hand) {
        try {
          var ann = {
            id: genHandDetectionId('hd'),
            frame_idx: state.currentFrame,
            hand: hand,
            bbox: bbox,
            occlusion: 'visible',
            interpolated: false
          };
          state.annotations.hand_detection.push(ann);
          state.selectedIds.hand = ann.id;
          log('HAND', 'annotation created, id=' + ann.id +
            ' hand=' + hand + ' frame=' + ann.frame_idx +
            ' bbox=[' + bbox[0].toFixed(1) + ',' + bbox[1].toFixed(1) +
            ',' + bbox[2].toFixed(1) + ',' + bbox[3].toFixed(1) + ']');

          // 重新计算插值（同手在其他帧可能有标注）
          recomputeInterpolation();

          saveToLocalStorage();
          triggerRedraw();
          renderPanel();
          // 入撤销栈（注：finishMouseAction 中也会 pushHistory，但那时标注还未创建）
          pushHistory(state);
        } catch (e) {
          log('ERROR', 'handleHandDetectionDrawComplete create failed: ' + (e.message || e));
        }
      });
    } catch (e) {
      log('ERROR', 'handleHandDetectionDrawComplete failed: ' + (e.message || e));
    }
  }

  // ===== 绘制完成统一入口（注册到 AIX_ANNOTATE_CANVAS.onDrawComplete） =====
  function handleDrawComplete(rect, tab) {
    try {
      log('DRAW', 'handleDrawComplete tab=' + tab + ' rect=' + JSON.stringify(rect));
      if (tab === 'hand_detection') {
        handleHandDetectionDrawComplete(rect);
      } else if (tab === 'keypoints') {
        // 阶段 5：关键点通过 onKeypointClick 回调处理（canvas click），不通过 onDrawComplete（画矩形）
        log('INFO', 'handleDrawComplete: keypoints tab uses onKeypointClick, not onDrawComplete');
      } else if (tab === 'action') {
        // 阶段 6 实现
        log('INFO', 'handleDrawComplete: action not implemented yet');
      } else if (tab === 'hand_object') {
        // 阶段 7：手物交互 — 物体框标注
        handleHandObjectDrawComplete(rect);
      } else {
        log('WARN', 'handleDrawComplete: unknown tab=' + tab);
      }
    } catch (e) {
      log('ERROR', 'handleDrawComplete failed: ' + (e.message || e));
    }
  }

  // ===== 标注编辑回调（moving/resizing 后由 annotate-canvas.js 调用） =====
  function onAnnotationEdited(tab) {
    try {
      log('HAND', 'onAnnotationEdited tab=' + tab);
      if (tab === 'hand_detection') {
        // 编辑后重新计算插值（因为可能将 interpolated 标注变为手动）
        recomputeInterpolation();
        saveToLocalStorage();
      } else if (tab === 'keypoints') {
        // 阶段 5：拖拽 keypoint 微调后入撤销栈
        try {
          pushHistory(state);
        } catch (e) {
          log('ERROR', 'pushHistory after keypoint move failed: ' + (e.message || e));
        }
        log('KEYPOINT', 'onAnnotationEdited: keypoint moved, pushHistory called');
      }
    } catch (e) {
      log('ERROR', 'onAnnotationEdited failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.2：设置遮挡属性 =====
  function setHandOcclusion(id, occlusion) {
    try {
      if (!id) {
        log('WARN', 'setHandOcclusion: id is null');
        return;
      }
      var validValues = ['visible', 'occluded', 'truncated'];
      if (validValues.indexOf(occlusion) === -1) {
        log('WARN', 'setHandOcclusion: invalid occlusion value=' + occlusion);
        return;
      }
      var list = state.annotations.hand_detection;
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          list[i].occlusion = occlusion;
          log('HAND', 'setHandOcclusion id=' + id + ' occlusion=' + occlusion);
          saveToLocalStorage();
          triggerRedraw();
          renderPanel();
          return;
        }
      }
      log('WARN', 'setHandOcclusion: id not found ' + id);
    } catch (e) {
      log('ERROR', 'setHandOcclusion failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.4：删除手部检测标注 =====
  function deleteHandDetection(id) {
    try {
      if (!id) {
        log('WARN', 'deleteHandDetection: id is null');
        return;
      }
      var list = state.annotations.hand_detection;
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          var removed = list[i];
          list.splice(i, 1);
          log('HAND', 'deleteHandDetection id=' + id +
            ' (hand=' + removed.hand + ', frame=' + removed.frame_idx + ')');
          if (state.selectedIds.hand === id) {
            state.selectedIds.hand = null;
          }
          // 删除后重新计算插值
          recomputeInterpolation();
          saveToLocalStorage();
          triggerRedraw();
          renderPanel();
          return;
        }
      }
      log('WARN', 'deleteHandDetection: id not found ' + id);
    } catch (e) {
      log('ERROR', 'deleteHandDetection failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.2：渲染遮挡属性面板 =====
  function renderHandDetectionAttrPanel() {
    try {
      var panel = qs('handDetectionAttrPanel');
      var hint = qs('handDetectionAttrHint');
      if (!panel) return;

      var selectedId = state.selectedIds.hand;
      if (!selectedId) {
        panel.style.display = 'none';
        return;
      }
      // 查找选中的标注
      var ann = null;
      var list = state.annotations.hand_detection;
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === selectedId) {
            ann = list[i];
            break;
          }
        }
      }
      if (!ann) {
        panel.style.display = 'none';
        // 选中态无效，清空 selectedIds.hand
        if (state.selectedIds.hand !== null) {
          state.selectedIds.hand = null;
        }
        return;
      }
      panel.style.display = '';
      // 设置单选按钮状态
      var radios = panel.querySelectorAll('input[name="occlusion"]');
      for (var j = 0; j < radios.length; j++) {
        radios[j].checked = (radios[j].value === (ann.occlusion || 'visible'));
      }
      // 提示信息
      if (hint) {
        var handLabel = ann.hand === 'left' ? '左手' : '右手';
        var interpTag = ann.interpolated ? ' · 自动' : ' · 手动';
        hint.textContent = handLabel + interpTag + ' · 帧 ' + ann.frame_idx;
      }
    } catch (e) {
      log('ERROR', 'renderHandDetectionAttrPanel failed: ' + (e.message || e));
    }
  }

  // ===== Task 4.4：渲染手部检测面板（右侧列表） =====
  function renderHandDetectionPanel() {
    try {
      if (!dom.panelList) return;
      var frame = state.currentFrame;
      var allList = state.annotations.hand_detection || [];
      var list = allList.filter(function (a) {
        return a && a.frame_idx === frame;
      });

      // 更新计数（总数，不只是当前帧）
      if (dom.panelCount) {
        dom.panelCount.textContent = String(allList.length);
      }

      // 渲染列表
      if (list.length === 0) {
        dom.panelList.innerHTML =
          '<div class="annotate-panel-empty" id="annotatePanelEmpty">' +
            '<span class="material-symbols-outlined">inbox</span>' +
            '<p>' + tt('annotate.panel_empty_hand', '当前帧暂无手部标注，在画布上拖拽创建') + '</p>' +
          '</div>';
      } else {
        // 按 hand 排序：left 在前，right 在后；同 hand 内按 id 稳定
        list.sort(function (x, y) {
          if (x.hand !== y.hand) return x.hand === 'left' ? -1 : 1;
          return 0;
        });

        var html = '<ul class="annotate-panel-items" style="list-style:none;padding:0;margin:0;">';
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          var isSelected = state.selectedIds.hand === a.id;
          var handLabel = a.hand === 'left' ? tt('annotate.hd_left_short', '左手') : tt('annotate.hd_right_short', '右手');
          var handColor = a.hand === 'left' ? '#22c55e' : '#3b82f6';
          var occLabel = a.occlusion || 'visible';
          var interpTag = a.interpolated ?
            '<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#fbbf24;color:#000;font-size:10px;margin-left:4px;">' + tt('annotate.hd_auto_tag', '自动') + '</span>' : '';
          var selectedStyle = isSelected ? 'border-left:3px solid ' + handColor + ';background:rgba(255,255,255,0.06);' : 'border-left:3px solid transparent;';

          html += '<li class="annotate-panel-item' + (isSelected ? ' selected' : '') +
            '" data-id="' + a.id + '" data-frame="' + a.frame_idx +
            '" style="display:flex;align-items:center;gap:8px;padding:8px 10px;' + selectedStyle +
            'cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);">' +
            '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + handColor + ';flex-shrink:0;"></span>' +
            '<span style="flex:1;font-size:13px;color:var(--color-on-surface);">' + handLabel + ' · ' + occLabel + '</span>' +
            interpTag +
            '<button type="button" class="annotate-item-delete" data-id="' + a.id +
            '" title="' + tt('annotate.hd_delete_tip', '删除') +
            '" style="background:transparent;border:none;color:var(--color-on-surface-variant);cursor:pointer;padding:4px 6px;font-size:16px;line-height:1;border-radius:4px;">×</button>' +
          '</li>';
        }
        html += '</ul>';
        dom.panelList.innerHTML = html;

        // 绑定 item 点击事件（选中）
        var items = dom.panelList.querySelectorAll('.annotate-panel-item');
        for (var j = 0; j < items.length; j++) {
          (function (item) {
            item.addEventListener('click', function (e) {
              try {
                // 点击删除按钮不处理选中
                if (e.target && e.target.classList && e.target.classList.contains('annotate-item-delete')) {
                  return;
                }
                var id = item.getAttribute('data-id');
                var frameIdx = parseInt(item.getAttribute('data-frame'), 10);
                if (isNaN(frameIdx)) {
                  log('WARN', 'panel item click: invalid frame_idx');
                  return;
                }
                if (frameIdx !== state.currentFrame) {
                  log('HAND', 'panel item click: jump to frame ' + frameIdx);
                  setFrame(frameIdx);
                  // setFrame 会触发 onFrameChange -> renderPanel，但仍需设置选中
                  state.selectedIds.hand = id;
                } else {
                  state.selectedIds.hand = id;
                  triggerRedraw();
                  renderPanel();
                }
                log('HAND', 'panel item selected, id=' + id);
              } catch (err) {
                log('ERROR', 'panel item click failed: ' + (err.message || err));
              }
            });
          })(items[j]);
        }

        // 绑定删除按钮
        var deleteBtns = dom.panelList.querySelectorAll('.annotate-item-delete');
        for (var k = 0; k < deleteBtns.length; k++) {
          (function (btn) {
            btn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                var id = btn.getAttribute('data-id');
                deleteHandDetection(id);
              } catch (err) {
                log('ERROR', 'panel delete click failed: ' + (err.message || err));
              }
            });
          })(deleteBtns[k]);
        }
      }

      // 渲染属性面板（根据选中状态）
      renderHandDetectionAttrPanel();
    } catch (e) {
      log('ERROR', 'renderHandDetectionPanel failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // 阶段 5：手部关键点标注（Task 5.1 - 5.5）
  // ============================================================

  // MediaPipe Hand 21 关键点名称（标准顺序）
  var HAND_KEYPOINT_NAMES = [
    'WRIST',                       // 0
    'THUMB_CMC', 'THUMB_MCP', 'THUMB_IP', 'THUMB_TIP',  // 1-4
    'INDEX_FINGER_MCP', 'INDEX_FINGER_PIP', 'INDEX_FINGER_DIP', 'INDEX_FINGER_TIP',  // 5-8
    'MIDDLE_FINGER_MCP', 'MIDDLE_FINGER_PIP', 'MIDDLE_FINGER_DIP', 'MIDDLE_FINGER_TIP',  // 9-12
    'RING_FINGER_MCP', 'RING_FINGER_PIP', 'RING_FINGER_DIP', 'RING_FINGER_TIP',  // 13-16
    'PINKY_MCP', 'PINKY_PIP', 'PINKY_DIP', 'PINKY_TIP'  // 17-20
  ];

  // MediaPipe Hand 21 关键点骨骼连线拓扑
  var HAND_KEYPOINT_BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
    [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
    [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
    [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
    [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
    [0, 17]                                   // 手掌底部
  ];

  var KEYPOINT_TOTAL = 21;

  // ===== 关键点标注草稿（临时状态，不持久化） =====
  // 当用户选择一只手后，开始 21 点逐点标注，draft 保存中间状态
  // 结构：{ hand_detection_id, hand, current_index, keypoints: [[x,y,v],...] }
  var keypointDraft = null;

  // ===== 工具：生成关键点标注 ID =====
  function genKeypointId() {
    try {
      return 'hk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    } catch (e) {
      return 'hk_' + Date.now() + '_fallback';
    }
  }

  // ===== Task 5.1：获取当前帧的手部检测框列表 =====
  function getCurrentFrameHandDetections() {
    try {
      var frame = state.currentFrame;
      var allList = state.annotations.hand_detection || [];
      return allList.filter(function (a) {
        return a && a.frame_idx === frame && a.bbox && a.bbox.length >= 4;
      });
    } catch (e) {
      log('ERROR', 'getCurrentFrameHandDetections failed: ' + (e.message || e));
      return [];
    }
  }

  // ===== Task 5.1：根据 hand_detection_id 查找手部检测框 =====
  function findHandDetectionById(id) {
    try {
      if (!id) return null;
      var list = state.annotations.hand_detection || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findHandDetectionById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== Task 5.1：查找当前帧某手的关键点标注 =====
  function findKeypointAnnotationByHand(handDetectionId, frame) {
    try {
      if (frame == null) frame = state.currentFrame;
      var list = state.annotations.hand_keypoints || [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a && a.frame_idx === frame && a.hand_detection_id === handDetectionId) {
          return a;
        }
      }
      return null;
    } catch (e) {
      log('ERROR', 'findKeypointAnnotationByHand failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== Task 5.1：开始标注某只手的关键点 =====
  // 用户在面板选择一只手后调用，初始化 keypointDraft
  function startKeypointAnnotation(handDetectionId) {
    try {
      if (!handDetectionId) {
        log('WARN', 'startKeypointAnnotation: handDetectionId is null');
        return;
      }
      var hd = findHandDetectionById(handDetectionId);
      if (!hd) {
        log('WARN', 'startKeypointAnnotation: hand detection not found, id=' + handDetectionId);
        showToast(tt('annotate.kp_hand_not_found', '未找到对应的手部检测框'));
        return;
      }
      // 检查当前帧是否已有该手的关键点标注
      var existing = findKeypointAnnotationByHand(handDetectionId, state.currentFrame);
      if (existing) {
        // 已有标注，直接选中查看（不再重新开始）
        state.selectedIds.keypoint = existing.id;
        keypointDraft = null;
        log('KEYPOINT', 'startKeypointAnnotation: existing annotation found, id=' + existing.id);
        triggerRedraw();
        renderKeypointsPanel();
        return;
      }
      // 初始化 draft
      keypointDraft = {
        hand_detection_id: handDetectionId,
        hand: hd.hand,
        current_index: 0,
        keypoints: []
      };
      state.selectedIds.keypoint = null;
      log('KEYPOINT', 'startKeypointAnnotation: draft created, hand=' + hd.hand +
        ' hd_id=' + handDetectionId + ' frame=' + state.currentFrame);
      triggerRedraw();
      renderKeypointsPanel();
    } catch (e) {
      log('ERROR', 'startKeypointAnnotation failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.2：处理关键点模式的 canvas click =====
  // 由 annotate-canvas.js 的 onKeypointClick 钩子调用
  function handleKeypointClick(videoX, videoY) {
    try {
      // 校验当前 tab
      if (state.activeTab !== 'keypoints') {
        log('WARN', 'handleKeypointClick: not in keypoints tab');
        return;
      }
      // 校验是否有 draft
      if (!keypointDraft) {
        log('WARN', 'handleKeypointClick: no draft, please select a hand first');
        showToast(tt('annotate.kp_select_hand_first', '请先选择一只手'));
        return;
      }
      // 校验 draft 未完成
      if (keypointDraft.current_index >= KEYPOINT_TOTAL) {
        log('WARN', 'handleKeypointClick: draft already complete');
        return;
      }
      // 边界校验视频坐标
      if (typeof videoX !== 'number' || typeof videoY !== 'number' ||
          isNaN(videoX) || isNaN(videoY)) {
        log('WARN', 'handleKeypointClick: invalid coords x=' + videoX + ' y=' + videoY);
        return;
      }
      var idx = keypointDraft.current_index;
      var name = HAND_KEYPOINT_NAMES[idx] || ('KP_' + idx);
      // 默认 visible (v=1)
      keypointDraft.keypoints.push([videoX, videoY, 1]);
      keypointDraft.current_index = idx + 1;
      log('KEYPOINT', 'click kp[' + idx + '] ' + name +
        ' at (' + videoX.toFixed(1) + ', ' + videoY.toFixed(1) + ') v=1' +
        ' progress=' + keypointDraft.current_index + '/' + KEYPOINT_TOTAL);

      // 21 点全部完成，保存标注
      if (keypointDraft.current_index >= KEYPOINT_TOTAL) {
        finalizeKeypointDraft();
      } else {
        triggerRedraw();
        renderKeypointsPanel();
      }
    } catch (e) {
      log('ERROR', 'handleKeypointClick failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.2 / 5.5：完成草稿，保存为正式标注 =====
  function finalizeKeypointDraft() {
    try {
      if (!keypointDraft) {
        log('WARN', 'finalizeKeypointDraft: no draft');
        return;
      }
      if (keypointDraft.keypoints.length !== KEYPOINT_TOTAL) {
        log('WARN', 'finalizeKeypointDraft: keypoints count=' +
          keypointDraft.keypoints.length + ' expected=' + KEYPOINT_TOTAL);
        return;
      }
      var ann = {
        id: genKeypointId(),
        frame_idx: state.currentFrame,
        hand: keypointDraft.hand,
        hand_detection_id: keypointDraft.hand_detection_id,
        keypoints: keypointDraft.keypoints,
        source: 'manual'
      };
      state.annotations.hand_keypoints.push(ann);
      state.selectedIds.keypoint = ann.id;
      log('KEYPOINT', 'finalizeKeypointDraft: saved id=' + ann.id +
        ' hand=' + ann.hand + ' frame=' + ann.frame_idx +
        ' kp_count=' + ann.keypoints.length);

      // 清空 draft
      keypointDraft = null;

      // 入撤销栈
      try {
        pushHistory(state);
      } catch (e) {
        log('ERROR', 'pushHistory after finalizeKeypointDraft failed: ' + (e.message || e));
      }
      saveToLocalStorage();
      triggerRedraw();
      renderKeypointsPanel();
      showToast(tt('annotate.kp_complete', '关键点标注完成 (21/21)'));
    } catch (e) {
      log('ERROR', 'finalizeKeypointDraft failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.3：设置关键点可见性 =====
  function setKeypointVisibility(keypointId, index, visible) {
    try {
      if (!keypointId) {
        log('WARN', 'setKeypointVisibility: keypointId is null');
        return;
      }
      if (typeof index !== 'number' || index < 0 || index >= KEYPOINT_TOTAL) {
        log('WARN', 'setKeypointVisibility: invalid index=' + index);
        return;
      }
      var list = state.annotations.hand_keypoints || [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a && a.id === keypointId) {
          if (!a.keypoints || !a.keypoints[index]) {
            log('WARN', 'setKeypointVisibility: keypoints[' + index + '] not found');
            return;
          }
          var oldV = a.keypoints[index][2];
          var newV = visible ? 1 : 0;
          a.keypoints[index][2] = newV;
          log('KEYPOINT', 'setKeypointVisibility id=' + keypointId +
            ' idx=' + index + ' v: ' + oldV + ' -> ' + newV);
          saveToLocalStorage();
          triggerRedraw();
          renderKeypointsPanel();
          return;
        }
      }
      log('WARN', 'setKeypointVisibility: id not found ' + keypointId);
    } catch (e) {
      log('ERROR', 'setKeypointVisibility failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.4：复制上一帧的关键点 =====
  function copyKeypointsFromPrevFrame() {
    try {
      // 需要先选择一只手（通过 draft 或 selectedId）
      var handDetectionId = null;
      if (keypointDraft) {
        handDetectionId = keypointDraft.hand_detection_id;
      } else if (state.selectedIds.keypoint) {
        // 通过当前选中的关键点标注找到 hand_detection_id
        var list = state.annotations.hand_keypoints || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === state.selectedIds.keypoint) {
            handDetectionId = list[i].hand_detection_id;
            break;
          }
        }
      }
      if (!handDetectionId) {
        log('WARN', 'copyKeypointsFromPrevFrame: no hand selected');
        showToast(tt('annotate.kp_select_hand_first', '请先选择一只手'));
        return;
      }

      // 查找上一帧（frame_idx < currentFrame）中同一 hand_detection_id 的关键点
      var currentFrame = state.currentFrame;
      var list2 = state.annotations.hand_keypoints || [];
      var prevAnn = null;
      var prevFrame = -1;
      for (var j = 0; j < list2.length; j++) {
        var a = list2[j];
        if (a && a.hand_detection_id === handDetectionId && a.frame_idx < currentFrame) {
          if (a.frame_idx > prevFrame) {
            prevFrame = a.frame_idx;
            prevAnn = a;
          }
        }
      }
      if (!prevAnn) {
        log('KEYPOINT', 'copyKeypointsFromPrevFrame: no prev frame annotation found, hd_id=' + handDetectionId);
        showToast(tt('annotate.kp_no_prev', '上一帧没有该手的关键点标注'));
        return;
      }

      // 检查当前帧是否已有该手的关键点标注
      var existing = findKeypointAnnotationByHand(handDetectionId, currentFrame);
      if (existing) {
        // 已有标注，提示用户先清除
        log('WARN', 'copyKeypointsFromPrevFrame: current frame already has annotation id=' + existing.id);
        showToast(tt('annotate.kp_already_exists', '当前帧已有标注，请先清除'));
        return;
      }

      // 深拷贝关键点数据
      var copiedKps = [];
      for (var k = 0; k < prevAnn.keypoints.length; k++) {
        var p = prevAnn.keypoints[k];
        copiedKps.push([p[0], p[1], p[2]]);
      }
      var newAnn = {
        id: genKeypointId(),
        frame_idx: currentFrame,
        hand: prevAnn.hand,
        hand_detection_id: handDetectionId,
        keypoints: copiedKps,
        source: 'copy'
      };
      state.annotations.hand_keypoints.push(newAnn);
      state.selectedIds.keypoint = newAnn.id;
      // 清空 draft（因为已经完成）
      keypointDraft = null;
      log('KEYPOINT', 'copyKeypointsFromPrevFrame: copied from frame=' + prevFrame +
        ' to frame=' + currentFrame + ' id=' + newAnn.id);

      try {
        pushHistory(state);
      } catch (e) {
        log('ERROR', 'pushHistory after copyKeypointsFromPrevFrame failed: ' + (e.message || e));
      }
      saveToLocalStorage();
      triggerRedraw();
      renderKeypointsPanel();
      showToast(tt('annotate.kp_copied', '已从第 ' + (prevFrame + 1) + ' 帧复制关键点'));
    } catch (e) {
      log('ERROR', 'copyKeypointsFromPrevFrame failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.4：清除当前帧当前手的关键点标注 =====
  function clearKeypointsCurrentFrame() {
    try {
      // 确定要清除的 hand_detection_id
      var handDetectionId = null;
      if (keypointDraft) {
        handDetectionId = keypointDraft.hand_detection_id;
      } else if (state.selectedIds.keypoint) {
        var list = state.annotations.hand_keypoints || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === state.selectedIds.keypoint) {
            handDetectionId = list[i].hand_detection_id;
            break;
          }
        }
      }
      if (!handDetectionId) {
        log('WARN', 'clearKeypointsCurrentFrame: no hand selected');
        showToast(tt('annotate.kp_select_hand_first', '请先选择一只手'));
        return;
      }

      // 二次确认
      showModal({
        title: tt('annotate.kp_clear_confirm_title', '清除关键点'),
        body: '<p>' + tt('annotate.kp_clear_confirm_body',
          '确认清除当前帧该手的关键点标注？此操作不可撤销（可通过 Ctrl+Z 撤销）。') + '</p>',
        confirmText: tt('annotate.kp_clear_btn', '清除'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var list2 = state.annotations.hand_keypoints || [];
            var removedCount = 0;
            for (var j = list2.length - 1; j >= 0; j--) {
              var a = list2[j];
              if (a && a.frame_idx === state.currentFrame &&
                  a.hand_detection_id === handDetectionId) {
                list2.splice(j, 1);
                removedCount++;
              }
            }
            // 清空 draft 和选中
            keypointDraft = null;
            state.selectedIds.keypoint = null;
            log('KEYPOINT', 'clearKeypointsCurrentFrame: removed=' + removedCount +
              ' hd_id=' + handDetectionId + ' frame=' + state.currentFrame);

            try {
              pushHistory(state);
            } catch (e) {
              log('ERROR', 'pushHistory after clearKeypointsCurrentFrame failed: ' + (e.message || e));
            }
            saveToLocalStorage();
            triggerRedraw();
            renderKeypointsPanel();
            hideModal();
            showToast(tt('annotate.kp_cleared', '已清除 ' + removedCount + ' 条关键点标注'));
          } catch (e) {
            log('ERROR', 'clearKeypointsCurrentFrame onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'clearKeypointsCurrentFrame failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.3：渲染关键点面板 =====
  function renderKeypointsPanel() {
    try {
      var panel = qs('keypointsPanel');
      if (!panel) {
        log('WARN', 'renderKeypointsPanel: keypointsPanel not found');
        return;
      }

      // 仅在 keypoints tab 显示
      if (state.activeTab !== 'keypoints') {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = '';

      // === 1. 填充手选择器 ===
      var select = qs('keypointHandSelect');
      if (!select) {
        log('WARN', 'renderKeypointsPanel: keypointHandSelect not found');
        return;
      }
      var handDetections = getCurrentFrameHandDetections();
      // 保存当前选中值（避免重渲染丢失）
      var prevValue = select.value;
      select.innerHTML = '';

      if (handDetections.length === 0) {
        // 当前帧没有手部检测框
        var optEmpty = document.createElement('option');
        optEmpty.value = '';
        optEmpty.textContent = tt('annotate.kp_no_hand_detection', '请先完成手部检测');
        select.appendChild(optEmpty);
        select.disabled = true;
        // 显示提示并禁用关键点功能
        keypointDraft = null;
        renderKeypointsList(null);
        updateKeypointProgress(0, 0, null);
        return;
      }
      select.disabled = false;

      // 默认选项
      var optDefault = document.createElement('option');
      optDefault.value = '';
      optDefault.textContent = tt('annotate.kp_select_hand_placeholder', '-- 选择手 --');
      select.appendChild(optDefault);

      // 每个手部检测框一个选项
      var selectedHdId = keypointDraft ? keypointDraft.hand_detection_id :
        (state.selectedIds.keypoint ? findHandDetectionIdByKeypointId(state.selectedIds.keypoint) : null);
      for (var i = 0; i < handDetections.length; i++) {
        var hd = handDetections[i];
        var opt = document.createElement('option');
        opt.value = hd.id;
        var handLabel = hd.hand === 'left' ?
          tt('annotate.hd_left_short', '左手') : tt('annotate.hd_right_short', '右手');
        // 框 ID 简写：取后 6 位
        var idShort = hd.id.length > 10 ? hd.id.substring(hd.id.length - 6) : hd.id;
        opt.textContent = handLabel + ' · #' + idShort;
        select.appendChild(opt);
      }

      // 恢复选中值
      if (selectedHdId) {
        select.value = selectedHdId;
      } else if (prevValue) {
        select.value = prevValue;
      }

      // === 2. 更新进度和提示 ===
      var progress = 0;
      var nextName = null;
      var currentKps = null;
      if (keypointDraft) {
        progress = keypointDraft.current_index;
        if (keypointDraft.current_index < KEYPOINT_TOTAL) {
          nextName = HAND_KEYPOINT_NAMES[keypointDraft.current_index];
        }
        currentKps = keypointDraft.keypoints;
      } else if (state.selectedIds.keypoint) {
        // 已完成标注，显示 21/21
        var ann = findKeypointAnnotationById(state.selectedIds.keypoint);
        if (ann) {
          progress = ann.keypoints.length;
          currentKps = ann.keypoints;
        }
      }
      updateKeypointProgress(progress, KEYPOINT_TOTAL, nextName);

      // === 3. 渲染关键点列表 ===
      renderKeypointsList(currentKps);

      // === 4. 更新面板计数 ===
      updatePanelCount();
    } catch (e) {
      log('ERROR', 'renderKeypointsPanel failed: ' + (e.message || e));
    }
  }

  // ===== 辅助：通过 keypoint id 查找对应 hand_detection_id =====
  function findHandDetectionIdByKeypointId(kpId) {
    try {
      if (!kpId) return null;
      var list = state.annotations.hand_keypoints || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === kpId) {
          return list[i].hand_detection_id;
        }
      }
      return null;
    } catch (e) {
      log('ERROR', 'findHandDetectionIdByKeypointId failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 辅助：通过 ID 查找关键点标注 =====
  function findKeypointAnnotationById(id) {
    try {
      if (!id) return null;
      var list = state.annotations.hand_keypoints || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findKeypointAnnotationById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 辅助：更新关键点进度显示 =====
  function updateKeypointProgress(current, total, nextName) {
    try {
      var progressEl = qs('keypointProgress');
      if (progressEl) {
        progressEl.textContent = current + '/' + total;
      }
      var hintEl = qs('keypointNextHint');
      if (hintEl) {
        if (current >= total) {
          hintEl.textContent = tt('annotate.kp_done', '已完成');
          hintEl.style.color = '#22c55e';
        } else if (nextName) {
          hintEl.textContent = nextName;
          hintEl.style.color = '#00E5FF';
        } else {
          hintEl.textContent = '-';
          hintEl.style.color = 'var(--color-on-surface-variant)';
        }
      }
    } catch (e) {
      log('ERROR', 'updateKeypointProgress failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.3：渲染关键点列表（带可见性切换） =====
  function renderKeypointsList(keypoints) {
    try {
      var listEl = qs('keypointsList');
      if (!listEl) {
        log('WARN', 'renderKeypointsList: keypointsList not found');
        return;
      }
      if (!keypoints || keypoints.length === 0) {
        listEl.innerHTML = '<p style="margin:0;padding:8px;font-size:12px;color:var(--color-on-surface-variant);text-align:center;">' +
          tt('annotate.kp_no_points', '暂无关键点，请在画布上点击标注') + '</p>';
        return;
      }
      // 确定当前操作的 keypointId（draft 时为 null，已完成时为 selectedIds.keypoint）
      var keypointId = state.selectedIds.keypoint;
      var html = '<ul style="list-style:none;padding:0;margin:0;">';
      for (var i = 0; i < keypoints.length; i++) {
        var p = keypoints[i];
        if (!p || p.length < 2) continue;
        var visible = p[2] !== 0;
        var name = HAND_KEYPOINT_NAMES[i] || ('KP_' + i);
        var bgColor = visible ? 'rgba(34,197,94,0.15)' : 'rgba(156,163,175,0.10)';
        var dotColor = visible ? '#22c55e' : '#9ca3af';
        var visLabel = visible ?
          tt('annotate.kp_visible', '可见') : tt('annotate.kp_occluded', '遮挡');
        // 仅已完成标注的项可点击切换（draft 中也可切换，因为已有 v 字段）
        var clickable = keypointId || (keypointDraft && i < keypointDraft.current_index);
        var cursor = clickable ? 'pointer' : 'default';
        var onclickAttr = clickable ?
          ' data-kp-id="' + (keypointId || '') + '" data-kp-idx="' + i + '"' : '';
        html += '<li' + onclickAttr +
          ' style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:' + cursor +
          ';background:' + bgColor + ';border-radius:4px;margin-bottom:2px;font-size:12px;">' +
          '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + dotColor + ';flex-shrink:0;"></span>' +
          '<span style="color:var(--color-on-surface-variant);min-width:24px;">' + i + '</span>' +
          '<span style="flex:1;color:var(--color-on-surface);">' + name + '</span>' +
          '<span style="color:' + dotColor + ';font-size:11px;">' + visLabel + '</span>' +
          '</li>';
      }
      html += '</ul>';
      listEl.innerHTML = html;

      // 绑定点击事件（切换可见性）
      if (keypointId || keypointDraft) {
        var items = listEl.querySelectorAll('li[data-kp-idx]');
        for (var j = 0; j < items.length; j++) {
          (function (item) {
            item.addEventListener('click', function () {
              try {
                var idx = parseInt(item.getAttribute('data-kp-idx'), 10);
                var kpId = item.getAttribute('data-kp-id');
                if (isNaN(idx)) return;
                if (kpId) {
                  // 已完成标注：切换可见性
                  var ann = findKeypointAnnotationById(kpId);
                  if (ann && ann.keypoints && ann.keypoints[idx]) {
                    var curV = ann.keypoints[idx][2];
                    setKeypointVisibility(kpId, idx, curV === 0);
                  }
                } else if (keypointDraft && idx < keypointDraft.current_index) {
                  // draft 中已标注的点：切换可见性
                  var curV2 = keypointDraft.keypoints[idx][2];
                  keypointDraft.keypoints[idx][2] = curV2 === 0 ? 1 : 0;
                  log('KEYPOINT', 'toggle draft kp[' + idx + '] v: ' + curV2 + ' -> ' + (curV2 === 0 ? 1 : 0));
                  triggerRedraw();
                  renderKeypointsPanel();
                }
              } catch (err) {
                log('ERROR', 'keypoint list item click failed: ' + (err.message || err));
              }
            });
          })(items[j]);
        }
      }
    } catch (e) {
      log('ERROR', 'renderKeypointsList failed: ' + (e.message || e));
    }
  }

  // ===== Task 5.4：删除关键点标注（辅助） =====
  function deleteKeypointAnnotation(id) {
    try {
      if (!id) {
        log('WARN', 'deleteKeypointAnnotation: id is null');
        return;
      }
      var list = state.annotations.hand_keypoints;
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          var removed = list[i];
          list.splice(i, 1);
          log('KEYPOINT', 'deleteKeypointAnnotation id=' + id +
            ' (hand=' + removed.hand + ', frame=' + removed.frame_idx + ')');
          if (state.selectedIds.keypoint === id) {
            state.selectedIds.keypoint = null;
          }
          // 清空 draft（如果删除的是当前 draft 关联的标注）
          if (keypointDraft && keypointDraft.hand_detection_id === removed.hand_detection_id) {
            keypointDraft = null;
          }
          saveToLocalStorage();
          triggerRedraw();
          renderKeypointsPanel();
          return;
        }
      }
      log('WARN', 'deleteKeypointAnnotation: id not found ' + id);
    } catch (e) {
      log('ERROR', 'deleteKeypointAnnotation failed: ' + (e.message || e));
    }
  }

  // ===== 绑定关键点面板事件 =====
  function bindKeypointsPanelEvents() {
    try {
      var select = qs('keypointHandSelect');
      var copyBtn = qs('copyPrevFrameBtn');
      var clearBtn = qs('clearCurrentFrameBtn');

      if (select) {
        select.addEventListener('change', function () {
          try {
            var hdId = select.value;
            log('KEYPOINT', 'hand select change: ' + (hdId || '(empty)'));
            if (hdId) {
              startKeypointAnnotation(hdId);
            } else {
              // 清空选择
              keypointDraft = null;
              state.selectedIds.keypoint = null;
              triggerRedraw();
              renderKeypointsPanel();
            }
          } catch (e) {
            log('ERROR', 'keypoint hand select change handler failed: ' + (e.message || e));
          }
        });
      } else {
        log('WARN', 'bindKeypointsPanelEvents: keypointHandSelect not found');
      }

      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          try {
            copyKeypointsFromPrevFrame();
          } catch (e) {
            log('ERROR', 'copyPrevFrameBtn click handler failed: ' + (e.message || e));
          }
        });
      } else {
        log('WARN', 'bindKeypointsPanelEvents: copyPrevFrameBtn not found');
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', function () {
          try {
            clearKeypointsCurrentFrame();
          } catch (e) {
            log('ERROR', 'clearCurrentFrameBtn click handler failed: ' + (e.message || e));
          }
        });
      } else {
        log('WARN', 'bindKeypointsPanelEvents: clearCurrentFrameBtn not found');
      }

      log('INIT', 'Keypoints panel events bound');
    } catch (e) {
      log('ERROR', 'bindKeypointsPanelEvents failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // 阶段 6：动作分割标注（Task 6.1 - 6.5）
  // ============================================================

  // 动作标签颜色池
  var LABEL_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

  // 时间轴状态
  var timelineZoom = 1;        // 缩放系数，1 = 默认（整个时间轴填充画布宽度）
  var pixelsPerFrame = 1;      // 每帧占用的像素数（由 timelineZoom 和画布宽度计算）
  var timelineOffset = 0;      // 水平滚动偏移（像素）

  // 时间轴鼠标交互状态
  var timelineInteraction = {
    mode: 'idle',        // idle / pending_draw / drawing / resizing / selected
    startFrame: 0,       // 鼠标按下时的帧
    currentFrame: 0,     // 当前鼠标所在帧
    drawStartFrame: 0,   // 绘制起点帧
    drawEndFrame: 0,     // 绘制终点帧
    resizeEdge: null,    // 'left' / 'right'
    resizeSegmentId: null,
    startX: 0,           // 鼠标按下时的屏幕 x
    moved: false         // 是否移动过（区分点击 vs 拖拽）
  };

  // ===== 工具：生成动作标签 ID =====
  function genActionLabelId() {
    try {
      return 'lbl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    } catch (e) {
      return 'lbl_' + Date.now() + '_fallback';
    }
  }

  // ===== 工具：生成动作段 ID =====
  function genActionSegmentId() {
    try {
      return 'seg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    } catch (e) {
      return 'seg_' + Date.now() + '_fallback';
    }
  }

  // ===== 工具：HTML 转义 =====
  function escapeHtml(text) {
    try {
      if (text == null) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    } catch (e) {
      return String(text || '');
    }
  }

  // ===== 工具：hex 颜色转 rgba 字符串 =====
  function hexToRgba(hex, alpha) {
    try {
      if (!hex || typeof hex !== 'string') return 'rgba(136,136,136,' + (alpha || 0.5) + ')';
      var h = hex.replace('#', '');
      if (h.length === 3) {
        h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      }
      var r = parseInt(h.substring(0, 2), 16);
      var g = parseInt(h.substring(2, 4), 16);
      var b = parseInt(h.substring(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgba(136,136,136,' + (alpha || 0.5) + ')';
      return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha || 0.5) + ')';
    } catch (e) {
      return 'rgba(136,136,136,' + (alpha || 0.5) + ')';
    }
  }

  // ===== 工具：格式化时间轴时间标签（HH:MM:SS） =====
  function formatTimelineTime(seconds) {
    try {
      if (!seconds || isNaN(seconds) || seconds < 0) seconds = 0;
      var ss = Math.floor(seconds % 60);
      var mm = Math.floor((seconds / 60) % 60);
      var hh = Math.floor(seconds / 3600);
      return pad(hh, 2) + ':' + pad(mm, 2) + ':' + pad(ss, 2);
    } catch (e) {
      return '00:00:00';
    }
  }

  // ===== 从颜色池中选取颜色（优先未使用过的） =====
  function pickLabelColor() {
    try {
      var labels = state.annotations.action_segmentation.labels || [];
      var usedColors = {};
      for (var i = 0; i < labels.length; i++) {
        if (labels[i] && labels[i].color) {
          usedColors[labels[i].color] = true;
        }
      }
      for (var j = 0; j < LABEL_COLORS.length; j++) {
        if (!usedColors[LABEL_COLORS[j]]) {
          return LABEL_COLORS[j];
        }
      }
      // 颜色池用尽，循环选取
      return LABEL_COLORS[labels.length % LABEL_COLORS.length];
    } catch (e) {
      log('ERROR', 'pickLabelColor failed: ' + (e.message || e));
      return LABEL_COLORS[0];
    }
  }

  // ===== 查找动作标签 =====
  function findActionLabelById(id) {
    try {
      if (!id) return null;
      var labels = state.annotations.action_segmentation.labels || [];
      for (var i = 0; i < labels.length; i++) {
        if (labels[i] && labels[i].id === id) return labels[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findActionLabelById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 查找动作段 =====
  function findActionSegmentById(id) {
    try {
      if (!id) return null;
      var segments = state.annotations.action_segmentation.segments || [];
      for (var i = 0; i < segments.length; i++) {
        if (segments[i] && segments[i].id === id) return segments[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findActionSegmentById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 查找包含指定帧的动作段 =====
  function findActionSegmentAt(frame) {
    try {
      var segments = state.annotations.action_segmentation.segments || [];
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        if (s && frame >= s.start_frame && frame <= s.end_frame) return s;
      }
      return null;
    } catch (e) {
      log('ERROR', 'findActionSegmentAt failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== Task 6.1：时间轴渲染（canvas） =====
  function renderTimeline() {
    try {
      if (!dom.timelineCanvas) return;
      var canvas = dom.timelineCanvas;
      var ctx;
      try {
        ctx = canvas.getContext('2d');
      } catch (e) {
        log('ERROR', 'renderTimeline: getContext failed: ' + (e.message || e));
        return;
      }
      if (!ctx) return;

      // 设置画布尺寸（CSS 像素 * dpr 以保证清晰度）
      var dpr = window.devicePixelRatio || 1;
      var cssW = canvas.clientWidth || 0;
      var cssH = canvas.clientHeight || 0;
      if (cssW <= 0 || cssH <= 0) {
        // 容器尚未布局完成，跳过本次渲染
        return;
      }
      var bufW = Math.round(cssW * dpr);
      var bufH = Math.round(cssH * dpr);
      if (canvas.width !== bufW || canvas.height !== bufH) {
        canvas.width = bufW;
        canvas.height = bufH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var w = cssW;
      var h = cssH;

      // 清空
      ctx.clearRect(0, 0, w, h);

      // 计算缩放
      var totalFrames = state.totalFrames || 0;
      if (totalFrames <= 0) {
        // 无视频，绘制提示
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#9ca3af';
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tt('annotate.timeline_no_video', '请先加载视频以显示时间轴'), w / 2, h / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        return;
      }

      var basePixelsPerFrame = w / totalFrames;
      pixelsPerFrame = Math.max(0.001, basePixelsPerFrame * timelineZoom);

      // 绘制背景
      ctx.fillStyle = '#f9fafb';
      ctx.fillRect(0, 0, w, h);

      var fps = state.fps || 30;
      if (fps <= 0) fps = 30;

      // 绘制帧刻度（每秒一个刻度，每 5 秒长刻度，每 10 秒显示时间标签）
      var totalSeconds = Math.ceil(totalFrames / fps);
      var sec;
      for (sec = 0; sec <= totalSeconds; sec++) {
        var x = sec * fps * pixelsPerFrame - timelineOffset;
        if (x < -50 || x > w + 50) continue;
        var isLong = sec % 5 === 0;
        ctx.strokeStyle = isLong ? '#6b7280' : '#d1d5db';
        ctx.lineWidth = 1;
        ctx.beginPath();
        var tickH = isLong ? 16 : 8;
        ctx.moveTo(Math.round(x) + 0.5, h - tickH);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
        if (sec % 10 === 0) {
          ctx.fillStyle = '#6b7280';
          ctx.font = '10px Inter, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(formatTimelineTime(sec), x + 3, h - 22);
        }
      }

      // 绘制动作段
      var segments = state.annotations.action_segmentation.segments || [];
      var labels = state.annotations.action_segmentation.labels || [];
      var labelMap = {};
      for (var li = 0; li < labels.length; li++) {
        if (labels[li]) labelMap[labels[li].id] = labels[li];
      }
      var segTop = 4;
      var segHeight = Math.max(20, h - 30);
      for (var si = 0; si < segments.length; si++) {
        var seg = segments[si];
        if (!seg) continue;
        var label = labelMap[seg.label_id];
        var color = label ? label.color : '#888888';
        var x1 = seg.start_frame * pixelsPerFrame - timelineOffset;
        var x2 = (seg.end_frame + 1) * pixelsPerFrame - timelineOffset;
        var segW = Math.max(1, x2 - x1);
        // 半透明填充
        ctx.fillStyle = hexToRgba(color, 0.45);
        ctx.fillRect(x1, segTop, segW, segHeight);
        // 边框
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, segTop + 0.5, Math.max(1, segW - 1), segHeight - 1);
        // 选中态高亮
        if (state.selectedIds.segment === seg.id) {
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 - 1, segTop - 1, Math.max(1, segW + 2), segHeight + 2);
        }
        // 标签文字
        if (label && segW > 20) {
          ctx.fillStyle = '#111827';
          ctx.font = '11px Inter, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          var maxTextW = segW - 6;
          var text = label.name || '';
          var textW = ctx.measureText(text).width;
          if (textW > maxTextW) {
            var truncText = text;
            while (truncText.length > 1 && ctx.measureText(truncText + '…').width > maxTextW) {
              truncText = truncText.substring(0, truncText.length - 1);
            }
            text = truncText + '…';
          }
          ctx.fillText(text, x1 + 3, segTop + 3);
        }
      }

      // 绘制正在拖选的预览矩形
      if (timelineInteraction.mode === 'drawing') {
        var dx1 = timelineInteraction.drawStartFrame * pixelsPerFrame - timelineOffset;
        var dx2 = (timelineInteraction.drawEndFrame + 1) * pixelsPerFrame - timelineOffset;
        var dxLeft = Math.min(dx1, dx2);
        var dxRight = Math.max(dx1, dx2);
        ctx.fillStyle = 'rgba(0, 229, 255, 0.20)';
        ctx.fillRect(dxLeft, segTop, Math.max(1, dxRight - dxLeft), segHeight);
        ctx.strokeStyle = '#00E5FF';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(dxLeft + 0.5, segTop + 0.5, Math.max(1, dxRight - dxLeft - 1), segHeight - 1);
        ctx.setLineDash([]);
        // 显示拖选帧范围
        var startF = Math.min(timelineInteraction.drawStartFrame, timelineInteraction.drawEndFrame);
        var endF = Math.max(timelineInteraction.drawStartFrame, timelineInteraction.drawEndFrame);
        ctx.fillStyle = '#00E5FF';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText((startF + 1) + ' - ' + (endF + 1), (dxLeft + dxRight) / 2, segTop + segHeight + 2);
        ctx.textAlign = 'left';
      }

      // 绘制当前帧指示器（红色竖线）
      var currentX = Math.round(state.currentFrame * pixelsPerFrame - timelineOffset) + 0.5;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(currentX, 0);
      ctx.lineTo(currentX, h);
      ctx.stroke();
      // 顶部小三角
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(currentX - 4, 0);
      ctx.lineTo(currentX + 4, 0);
      ctx.lineTo(currentX, 5);
      ctx.closePath();
      ctx.fill();
    } catch (e) {
      log('ERROR', 'renderTimeline failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.1：时间轴鼠标事件绑定 =====
  function bindTimelineEvents() {
    try {
      if (!dom.timelineCanvas) {
        log('WARN', 'bindTimelineEvents: timelineCanvas not found');
        return;
      }
      var canvas = dom.timelineCanvas;

      // 将屏幕 x 坐标转换为帧号
      function screenXToFrame(clientX) {
        try {
          var rect = canvas.getBoundingClientRect();
          var x = clientX - rect.left;
          var frame = Math.floor((x + timelineOffset) / pixelsPerFrame);
          if (frame < 0) frame = 0;
          var total = state.totalFrames || 0;
          if (total > 0 && frame >= total) frame = total - 1;
          return frame;
        } catch (e) {
          log('ERROR', 'screenXToFrame failed: ' + (e.message || e));
          return 0;
        }
      }

      // 命中测试：检测点是否在某段的边缘（5 像素内）
      function hitTestSegmentEdge(frame, clientX) {
        try {
          var rect = canvas.getBoundingClientRect();
          var x = clientX - rect.left;
          var segments = state.annotations.action_segmentation.segments || [];
          var edgeThreshold = 5; // 像素
          for (var i = segments.length - 1; i >= 0; i--) {
            var seg = segments[i];
            if (!seg) continue;
            if (frame < seg.start_frame - 2 || frame > seg.end_frame + 2) continue;
            var x1 = seg.start_frame * pixelsPerFrame - timelineOffset;
            var x2 = (seg.end_frame + 1) * pixelsPerFrame - timelineOffset;
            if (Math.abs(x - x1) <= edgeThreshold) {
              return { segmentId: seg.id, edge: 'left' };
            }
            if (Math.abs(x - x2) <= edgeThreshold) {
              return { segmentId: seg.id, edge: 'right' };
            }
          }
          return null;
        } catch (e) {
          log('ERROR', 'hitTestSegmentEdge failed: ' + (e.message || e));
          return null;
        }
      }

      // 命中测试：检测点是否在某段内部
      function hitTestSegmentBody(frame) {
        try {
          var segments = state.annotations.action_segmentation.segments || [];
          for (var i = segments.length - 1; i >= 0; i--) {
            var seg = segments[i];
            if (!seg) continue;
            if (frame >= seg.start_frame && frame <= seg.end_frame) {
              return seg;
            }
          }
          return null;
        } catch (e) {
          log('ERROR', 'hitTestSegmentBody failed: ' + (e.message || e));
          return null;
        }
      }

      // mousedown
      canvas.addEventListener('mousedown', function (e) {
        try {
          if (e.button !== 0) return;
          if (state.currentStep !== 3) return;
          if (state.totalFrames <= 0) {
            log('TIMELINE', 'mousedown: no video loaded');
            return;
          }
          var frame = screenXToFrame(e.clientX);
          timelineInteraction.startX = e.clientX;
          timelineInteraction.startFrame = frame;
          timelineInteraction.currentFrame = frame;
          timelineInteraction.moved = false;

          // 1. 检测边缘 resize
          var edge = hitTestSegmentEdge(frame, e.clientX);
          if (edge) {
            timelineInteraction.mode = 'resizing';
            timelineInteraction.resizeSegmentId = edge.segmentId;
            timelineInteraction.resizeEdge = edge.edge;
            state.selectedIds.segment = edge.segmentId;
            log('TIMELINE', 'mousedown resize edge=' + edge.edge + ' segId=' + edge.segmentId);
            renderTimeline();
            renderActionPanel();
            return;
          }

          // 2. 检测段内部
          var seg = hitTestSegmentBody(frame);
          if (seg) {
            timelineInteraction.mode = 'selected';
            state.selectedIds.segment = seg.id;
            log('TIMELINE', 'mousedown select segId=' + seg.id);
            renderTimeline();
            renderActionPanel();
            return;
          }

          // 3. 空白处：进入 pending_draw（区分点击 vs 拖拽）
          timelineInteraction.mode = 'pending_draw';
          timelineInteraction.drawStartFrame = frame;
          timelineInteraction.drawEndFrame = frame;
          // 清空选中
          state.selectedIds.segment = null;
          log('TIMELINE', 'mousedown pending_draw frame=' + frame);
          renderTimeline();
          renderActionPanel();
        } catch (err) {
          log('ERROR', 'timeline mousedown handler failed: ' + (err.message || err));
        }
      });

      // mousemove
      canvas.addEventListener('mousemove', function (e) {
        try {
          if (timelineInteraction.mode === 'idle') return;
          var frame = screenXToFrame(e.clientX);
          timelineInteraction.currentFrame = frame;

          // 判断是否移动超过阈值（5 像素）
          if (!timelineInteraction.moved) {
            var dx = Math.abs(e.clientX - timelineInteraction.startX);
            if (dx >= 5) {
              timelineInteraction.moved = true;
              if (timelineInteraction.mode === 'pending_draw') {
                timelineInteraction.mode = 'drawing';
                log('TIMELINE', 'move threshold exceeded -> drawing mode');
              }
            }
          }

          if (timelineInteraction.mode === 'drawing') {
            timelineInteraction.drawEndFrame = frame;
            renderTimeline();
          } else if (timelineInteraction.mode === 'resizing') {
            var seg = findActionSegmentById(timelineInteraction.resizeSegmentId);
            if (seg) {
              if (timelineInteraction.resizeEdge === 'left') {
                if (frame < seg.end_frame) {
                  seg.start_frame = Math.max(0, frame);
                }
              } else {
                var total = state.totalFrames || 1;
                if (frame > seg.start_frame) {
                  seg.end_frame = Math.min(total - 1, frame);
                }
              }
              renderTimeline();
            }
          }
        } catch (err) {
          log('ERROR', 'timeline mousemove handler failed: ' + (err.message || err));
        }
      });

      // mouseup
      function handleMouseUp(e) {
        try {
          var mode = timelineInteraction.mode;
          if (mode === 'idle') return;

          if (mode === 'pending_draw') {
            // 点击（未拖拽）：跳转到对应帧
            var clickFrame = screenXToFrame(e.clientX);
            log('TIMELINE', 'click to jump frame=' + clickFrame);
            setFrame(clickFrame);
          } else if (mode === 'drawing') {
            // 拖拽完成：创建段
            var startF = Math.min(timelineInteraction.drawStartFrame, timelineInteraction.drawEndFrame);
            var endF = Math.max(timelineInteraction.drawStartFrame, timelineInteraction.drawEndFrame);
            if (endF - startF < 1) {
              log('TIMELINE', 'draw span too small (' + startF + '-' + endF + '), discarded');
            } else {
              log('TIMELINE', 'draw complete, start=' + startF + ' end=' + endF);
              showActionLabelModal(function (labelId) {
                if (labelId) {
                  createActionSegment(startF, endF, labelId);
                } else {
                  log('TIMELINE', 'label selection cancelled, segment discarded');
                }
              });
            }
          } else if (mode === 'resizing') {
            log('TIMELINE', 'resize complete, saving');
            saveToLocalStorage();
            renderActionPanel();
            pushHistory(state);
          }

          // 重置交互状态
          timelineInteraction.mode = 'idle';
          timelineInteraction.moved = false;
          timelineInteraction.resizeEdge = null;
          timelineInteraction.resizeSegmentId = null;
          renderTimeline();
        } catch (err) {
          log('ERROR', 'timeline mouseup handler failed: ' + (err.message || err));
        }
      }
      canvas.addEventListener('mouseup', handleMouseUp);
      canvas.addEventListener('mouseleave', function (e) {
        try {
          if (timelineInteraction.mode !== 'idle') {
            handleMouseUp(e);
          }
        } catch (err) {
          log('ERROR', 'timeline mouseleave handler failed: ' + (err.message || err));
        }
      });

      // 双击：编辑段标签
      canvas.addEventListener('dblclick', function (e) {
        try {
          if (state.totalFrames <= 0) return;
          var frame = screenXToFrame(e.clientX);
          var seg = hitTestSegmentBody(frame);
          if (seg) {
            log('TIMELINE', 'dblclick to edit segId=' + seg.id);
            state.selectedIds.segment = seg.id;
            renderTimeline();
            showActionLabelModal(function (labelId) {
              if (labelId) {
                seg.label_id = labelId;
                log('ACTION', 'segment label changed, segId=' + seg.id + ' labelId=' + labelId);
                saveToLocalStorage();
                renderTimeline();
                renderActionPanel();
                triggerRedraw();
                pushHistory(state);
              }
            });
          }
        } catch (err) {
          log('ERROR', 'timeline dblclick handler failed: ' + (err.message || err));
        }
      });

      // 滚轮缩放
      canvas.addEventListener('wheel', function (e) {
        try {
          if (state.totalFrames <= 0) return;
          e.preventDefault();
          var delta = e.deltaY;
          var factor = delta < 0 ? 1.15 : 1 / 1.15;
          var newZoom = timelineZoom * factor;
          if (newZoom < 0.5) newZoom = 0.5;
          if (newZoom > 50) newZoom = 50;
          if (newZoom === timelineZoom) return;
          timelineZoom = newZoom;
          log('TIMELINE', 'wheel zoom -> ' + timelineZoom.toFixed(2));
          renderTimeline();
        } catch (err) {
          log('ERROR', 'timeline wheel handler failed: ' + (err.message || err));
        }
      }, { passive: false });

      // 监听容器尺寸变化（重渲染时间轴）
      try {
        if (typeof ResizeObserver !== 'undefined') {
          var ro = new ResizeObserver(function () {
            try {
              renderTimeline();
            } catch (err) {
              log('ERROR', 'timeline ResizeObserver callback failed: ' + (err.message || err));
            }
          });
          ro.observe(canvas);
        } else {
          window.addEventListener('resize', function () {
            try { renderTimeline(); } catch (err) {}
          });
        }
      } catch (err) {
        log('WARN', 'timeline ResizeObserver setup failed: ' + (err.message || err));
      }

      log('INIT', 'Timeline events bound');
    } catch (e) {
      log('ERROR', 'bindTimelineEvents failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.2：标签选择弹窗（已有标签 + 新建标签） =====
  function showActionLabelModal(onSelect) {
    try {
      var labels = state.annotations.action_segmentation.labels || [];
      var selectHtml = '';
      if (labels.length > 0) {
        selectHtml = '<label style="display:block;margin:0 0 6px 0;font-size:12px;color:var(--color-on-surface-variant);">' +
          tt('annotate.action_select_label', '选择已有标签') + '</label>' +
          '<select id="actionLabelSelect" style="width:100%;padding:6px 8px;background:var(--color-surface-container-high);color:var(--color-on-surface);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:13px;margin-bottom:12px;box-sizing:border-box;">';
        for (var i = 0; i < labels.length; i++) {
          selectHtml += '<option value="' + labels[i].id + '">' + escapeHtml(labels[i].name) + '</option>';
        }
        selectHtml += '</select>';
      } else {
        selectHtml = '<p style="margin:0 0 12px 0;font-size:12px;color:var(--color-on-surface-variant);">' +
          tt('annotate.action_no_labels', '暂无标签，请输入新标签名称') + '</p>';
      }

      var body = selectHtml +
        '<label style="display:block;margin:0 0 6px 0;font-size:12px;color:var(--color-on-surface-variant);">' +
        tt('annotate.action_new_label', '或输入新标签名称') + '</label>' +
        '<input type="text" id="actionLabelInput" placeholder="' +
        tt('annotate.action_label_placeholder', '如：拿杯子') +
        '" style="width:100%;padding:6px 8px;background:var(--color-surface-container-high);color:var(--color-on-surface);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:13px;box-sizing:border-box;">';

      showModal({
        title: tt('annotate.action_label_title', '选择动作标签'),
        body: body,
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var input = qs('actionLabelInput');
            var select = qs('actionLabelSelect');
            var newName = input ? (input.value || '').trim() : '';
            if (newName) {
              // 创建新标签
              var label = {
                id: genActionLabelId(),
                name: newName,
                color: pickLabelColor()
              };
              state.annotations.action_segmentation.labels.push(label);
              log('ACTION', 'new label created: ' + label.name + ' color=' + label.color);
              saveToLocalStorage();
              renderActionPanel();
              renderTimeline();
              hideModal();
              if (typeof onSelect === 'function') onSelect(label.id);
            } else if (select && select.value) {
              // 使用已有标签
              hideModal();
              if (typeof onSelect === 'function') onSelect(select.value);
            } else {
              log('WARN', 'action label modal: no label selected');
              showToast(tt('annotate.action_select_label_required', '请选择或输入标签'));
            }
          } catch (e) {
            log('ERROR', 'action label modal onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'showActionLabelModal failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.2：创建动作段 =====
  function createActionSegment(startFrame, endFrame, labelId) {
    try {
      if (startFrame == null || endFrame == null || !labelId) {
        log('WARN', 'createActionSegment: invalid params start=' + startFrame + ' end=' + endFrame + ' label=' + labelId);
        return null;
      }
      if (startFrame > endFrame) {
        var tmp = startFrame;
        startFrame = endFrame;
        endFrame = tmp;
      }
      var total = state.totalFrames || 0;
      if (total > 0 && endFrame >= total) endFrame = total - 1;
      if (startFrame < 0) startFrame = 0;

      var seg = {
        id: genActionSegmentId(),
        start_frame: startFrame,
        end_frame: endFrame,
        label_id: labelId
      };
      state.annotations.action_segmentation.segments.push(seg);
      state.selectedIds.segment = seg.id;
      log('ACTION', 'segment created id=' + seg.id + ' start=' + startFrame + ' end=' + endFrame + ' label=' + labelId);

      saveToLocalStorage();
      renderTimeline();
      renderActionPanel();
      triggerRedraw();
      pushHistory(state);
      return seg;
    } catch (e) {
      log('ERROR', 'createActionSegment failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== Task 6.3：删除动作段 =====
  function deleteActionSegment(id) {
    try {
      if (!id) {
        log('WARN', 'deleteActionSegment: id is null');
        return;
      }
      var segments = state.annotations.action_segmentation.segments;
      if (!Array.isArray(segments)) return;
      for (var i = 0; i < segments.length; i++) {
        if (segments[i] && segments[i].id === id) {
          var removed = segments[i];
          segments.splice(i, 1);
          log('ACTION', 'segment deleted id=' + id + ' start=' + removed.start_frame + ' end=' + removed.end_frame);
          if (state.selectedIds.segment === id) {
            state.selectedIds.segment = null;
          }
          saveToLocalStorage();
          renderTimeline();
          renderActionPanel();
          triggerRedraw();
          pushHistory(state);
          return;
        }
      }
      log('WARN', 'deleteActionSegment: id not found ' + id);
    } catch (e) {
      log('ERROR', 'deleteActionSegment failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.3：调整动作段边缘（外部调用接口） =====
  function resizeActionSegment(id, edge, newFrame) {
    try {
      var seg = findActionSegmentById(id);
      if (!seg) {
        log('WARN', 'resizeActionSegment: segment not found ' + id);
        return;
      }
      if (edge === 'left') {
        if (newFrame < seg.end_frame) {
          seg.start_frame = Math.max(0, newFrame);
        }
      } else if (edge === 'right') {
        var total = state.totalFrames || 1;
        if (newFrame > seg.start_frame) {
          seg.end_frame = Math.min(total - 1, newFrame);
        }
      }
      log('ACTION', 'resize segment id=' + id + ' edge=' + edge + ' newFrame=' + newFrame);
      saveToLocalStorage();
      renderTimeline();
      renderActionPanel();
      pushHistory(state);
    } catch (e) {
      log('ERROR', 'resizeActionSegment failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.4：添加动作标签 =====
  function addActionLabel(name) {
    try {
      name = (name || '').trim();
      if (!name) {
        log('WARN', 'addActionLabel: name is empty');
        showToast(tt('annotate.action_name_required', '请输入标签名称'));
        return null;
      }
      var labels = state.annotations.action_segmentation.labels || [];
      for (var i = 0; i < labels.length; i++) {
        if (labels[i] && labels[i].name === name) {
          log('WARN', 'addActionLabel: name already exists ' + name);
          showToast(tt('annotate.action_name_exists', '标签名已存在'));
          return labels[i];
        }
      }
      var label = {
        id: genActionLabelId(),
        name: name,
        color: pickLabelColor()
      };
      state.annotations.action_segmentation.labels.push(label);
      log('ACTION', 'label added id=' + label.id + ' name=' + name + ' color=' + label.color);
      saveToLocalStorage();
      renderActionPanel();
      renderTimeline();
      pushHistory(state);
      return label;
    } catch (e) {
      log('ERROR', 'addActionLabel failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== Task 6.4：重命名动作标签 =====
  function renameActionLabel(id, newName) {
    try {
      var label = findActionLabelById(id);
      if (!label) {
        log('WARN', 'renameActionLabel: label not found ' + id);
        return;
      }
      newName = (newName || '').trim();
      if (!newName) {
        log('WARN', 'renameActionLabel: name is empty');
        showToast(tt('annotate.action_name_required', '请输入标签名称'));
        return;
      }
      var oldName = label.name;
      label.name = newName;
      log('ACTION', 'label renamed id=' + id + ' "' + oldName + '" -> "' + newName + '"');
      saveToLocalStorage();
      renderActionPanel();
      renderTimeline();
      pushHistory(state);
    } catch (e) {
      log('ERROR', 'renameActionLabel failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.4：删除动作标签（及其所有段） =====
  function deleteActionLabel(id) {
    try {
      if (!id) {
        log('WARN', 'deleteActionLabel: id is null');
        return;
      }
      var labels = state.annotations.action_segmentation.labels || [];
      var segments = state.annotations.action_segmentation.segments || [];
      var label = findActionLabelById(id);
      if (!label) {
        log('WARN', 'deleteActionLabel: label not found ' + id);
        return;
      }
      var segCount = 0;
      for (var i = segments.length - 1; i >= 0; i--) {
        if (segments[i] && segments[i].label_id === id) {
          segments.splice(i, 1);
          segCount++;
        }
      }
      for (var j = 0; j < labels.length; j++) {
        if (labels[j] && labels[j].id === id) {
          labels.splice(j, 1);
          break;
        }
      }
      if (state.selectedIds.segment) {
        var sel = findActionSegmentById(state.selectedIds.segment);
        if (!sel) state.selectedIds.segment = null;
      }
      log('ACTION', 'label deleted id=' + id + ' name=' + label.name + ' segmentsRemoved=' + segCount);
      saveToLocalStorage();
      renderActionPanel();
      renderTimeline();
      triggerRedraw();
      pushHistory(state);
      showToast(tt('annotate.action_label_deleted', '已删除标签及其 ' + segCount + ' 个段'));
    } catch (e) {
      log('ERROR', 'deleteActionLabel failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.4：设置标签颜色 =====
  function setActionLabelColor(id, color) {
    try {
      var label = findActionLabelById(id);
      if (!label) {
        log('WARN', 'setActionLabelColor: label not found ' + id);
        return;
      }
      var oldColor = label.color;
      label.color = color;
      log('ACTION', 'label color changed id=' + id + ' ' + oldColor + ' -> ' + color);
      saveToLocalStorage();
      renderActionPanel();
      renderTimeline();
      triggerRedraw();
      pushHistory(state);
    } catch (e) {
      log('ERROR', 'setActionLabelColor failed: ' + (e.message || e));
    }
  }

  // ===== Task 6.4：渲染动作面板（标签列表 + 段列表） =====
  function renderActionPanel() {
    try {
      var panel = qs('actionPanel');
      if (!panel) {
        log('WARN', 'renderActionPanel: actionPanel not found');
        return;
      }
      // 仅在 action tab 显示
      if (state.activeTab !== 'action') {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = '';

      // === 1. 渲染标签列表 ===
      var labelsListEl = qs('actionLabelsList');
      var labels = state.annotations.action_segmentation.labels || [];
      if (labelsListEl) {
        if (labels.length === 0) {
          labelsListEl.innerHTML = '<p style="margin:0;padding:8px;font-size:12px;color:var(--color-on-surface-variant);text-align:center;">' +
            tt('annotate.action_no_labels_hint', '点击「+ 添加」创建标签') + '</p>';
        } else {
          var html = '<ul style="list-style:none;padding:0;margin:0;">';
          for (var i = 0; i < labels.length; i++) {
            var lb = labels[i];
            var segCount = 0;
            var segs = state.annotations.action_segmentation.segments || [];
            for (var k = 0; k < segs.length; k++) {
              if (segs[k] && segs[k].label_id === lb.id) segCount++;
            }
            html += '<li class="action-label-item" data-label-id="' + lb.id + '" style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:4px;margin-bottom:2px;font-size:12px;">' +
              '<input type="color" class="action-label-color" data-label-id="' + lb.id + '" value="' + lb.color + '" style="width:16px;height:16px;padding:0;border:none;background:transparent;cursor:pointer;flex-shrink:0;">' +
              '<span class="action-label-name" style="flex:1;color:var(--color-on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(lb.name) + '</span>' +
              '<span style="color:var(--color-on-surface-variant);font-size:11px;">' + segCount + '</span>' +
              '<button type="button" class="action-label-rename" data-label-id="' + lb.id + '" title="' + tt('annotate.rename', '重命名') + '" style="background:transparent;border:none;color:var(--color-on-surface-variant);cursor:pointer;padding:2px 4px;font-size:14px;line-height:1;border-radius:4px;">✎</button>' +
              '<button type="button" class="action-label-delete" data-label-id="' + lb.id + '" title="' + tt('annotate.delete', '删除') + '" style="background:transparent;border:none;color:#ef4444;cursor:pointer;padding:2px 4px;font-size:14px;line-height:1;border-radius:4px;">×</button>' +
            '</li>';
          }
          html += '</ul>';
          labelsListEl.innerHTML = html;

          // 绑定颜色选择
          var colorInputs = labelsListEl.querySelectorAll('.action-label-color');
          for (var ci = 0; ci < colorInputs.length; ci++) {
            (function (input) {
              input.addEventListener('change', function () {
                try {
                  var id = input.getAttribute('data-label-id');
                  setActionLabelColor(id, input.value);
                } catch (e) {
                  log('ERROR', 'color input change failed: ' + (e.message || e));
                }
              });
            })(colorInputs[ci]);
          }

          // 绑定重命名按钮
          var renameBtns = labelsListEl.querySelectorAll('.action-label-rename');
          for (var ri = 0; ri < renameBtns.length; ri++) {
            (function (btn) {
              btn.addEventListener('click', function (e) {
                try {
                  e.stopPropagation();
                  var id = btn.getAttribute('data-label-id');
                  var lb2 = findActionLabelById(id);
                  var newName = window.prompt(tt('annotate.action_rename_prompt', '请输入新的标签名称'), lb2 ? lb2.name : '');
                  if (newName !== null) {
                    renameActionLabel(id, newName);
                  }
                } catch (err) {
                  log('ERROR', 'rename btn click failed: ' + (err.message || err));
                }
              });
            })(renameBtns[ri]);
          }

          // 绑定删除按钮
          var deleteBtns = labelsListEl.querySelectorAll('.action-label-delete');
          for (var di = 0; di < deleteBtns.length; di++) {
            (function (btn) {
              btn.addEventListener('click', function (e) {
                try {
                  e.stopPropagation();
                  var id = btn.getAttribute('data-label-id');
                  var lb3 = findActionLabelById(id);
                  showModal({
                    title: tt('annotate.action_delete_label_title', '删除标签'),
                    body: '<p>' + tt('annotate.action_delete_label_body',
                      '确认删除标签「' + (lb3 ? lb3.name : '') + '」及其所有时间段？此操作不可撤销。') + '</p>',
                    confirmText: tt('annotate.delete', '删除'),
                    cancelText: tt('annotate.modal_cancel', '取消'),
                    onConfirm: function () {
                      try {
                        deleteActionLabel(id);
                        hideModal();
                      } catch (err) {
                        log('ERROR', 'delete label onConfirm failed: ' + (err.message || err));
                        hideModal();
                      }
                    }
                  });
                } catch (err) {
                  log('ERROR', 'delete btn click failed: ' + (err.message || err));
                }
              });
            })(deleteBtns[di]);
          }
        }
      }

      // === 2. 渲染段列表 ===
      var segsListEl = qs('actionSegmentsList');
      var segments = state.annotations.action_segmentation.segments || [];
      if (segsListEl) {
        if (segments.length === 0) {
          segsListEl.innerHTML = '<p style="margin:0;padding:8px;font-size:12px;color:var(--color-on-surface-variant);text-align:center;">' +
            tt('annotate.action_no_segments', '在时间轴上拖拽创建时间段') + '</p>';
        } else {
          var sorted = segments.slice().sort(function (a, b) {
            return (a.start_frame || 0) - (b.start_frame || 0);
          });
          var sHtml = '<ul style="list-style:none;padding:0;margin:0;">';
          for (var si = 0; si < sorted.length; si++) {
            var s = sorted[si];
            var sl = findActionLabelById(s.label_id);
            var sColor = sl ? sl.color : '#888888';
            var sName = sl ? sl.name : tt('annotate.action_unknown_label', '未知');
            var isSelected = state.selectedIds.segment === s.id;
            var sStyle = isSelected ?
              'background:rgba(255,255,255,0.08);border-left:3px solid ' + sColor + ';' :
              'border-left:3px solid ' + sColor + ';';
            sHtml += '<li class="action-segment-item" data-seg-id="' + s.id + '" style="display:flex;align-items:center;gap:6px;padding:5px 8px;' + sStyle + 'border-radius:4px;margin-bottom:2px;font-size:12px;cursor:pointer;">' +
              '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + sColor + ';flex-shrink:0;"></span>' +
              '<span style="flex:1;color:var(--color-on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(sName) + '</span>' +
              '<span style="color:var(--color-on-surface-variant);font-size:11px;font-variant-numeric:tabular-nums;">' +
                (s.start_frame + 1) + '-' + (s.end_frame + 1) + '</span>' +
              '<button type="button" class="action-segment-delete" data-seg-id="' + s.id + '" title="' + tt('annotate.delete', '删除') + '" style="background:transparent;border:none;color:#ef4444;cursor:pointer;padding:2px 4px;font-size:14px;line-height:1;border-radius:4px;">×</button>' +
            '</li>';
          }
          sHtml += '</ul>';
          segsListEl.innerHTML = sHtml;

          // 绑定段项点击（选中并跳转）
          var segItems = segsListEl.querySelectorAll('.action-segment-item');
          for (var si2 = 0; si2 < segItems.length; si2++) {
            (function (item) {
              item.addEventListener('click', function (e) {
                try {
                  if (e.target && e.target.classList && e.target.classList.contains('action-segment-delete')) return;
                  var id = item.getAttribute('data-seg-id');
                  var seg2 = findActionSegmentById(id);
                  if (seg2) {
                    state.selectedIds.segment = id;
                    setFrame(seg2.start_frame);
                    log('ACTION', 'panel item selected, segId=' + id + ' jump to ' + seg2.start_frame);
                  }
                } catch (err) {
                  log('ERROR', 'segment item click failed: ' + (err.message || err));
                }
              });
            })(segItems[si2]);
          }

          // 绑定段删除按钮
          var segDeleteBtns = segsListEl.querySelectorAll('.action-segment-delete');
          for (var sd = 0; sd < segDeleteBtns.length; sd++) {
            (function (btn) {
              btn.addEventListener('click', function (e) {
                try {
                  e.stopPropagation();
                  var id = btn.getAttribute('data-seg-id');
                  var seg3 = findActionSegmentById(id);
                  if (seg3) {
                    var segLabel = findActionLabelById(seg3.label_id);
                    showModal({
                      title: tt('annotate.action_delete_seg_title', '删除时间段'),
                      body: '<p>' + tt('annotate.action_delete_seg_body',
                        '确认删除时间段（' + (seg3.start_frame + 1) + '-' + (seg3.end_frame + 1) + '）' +
                        (segLabel ? '「' + segLabel.name + '」' : '') + '？') + '</p>',
                      confirmText: tt('annotate.delete', '删除'),
                      cancelText: tt('annotate.modal_cancel', '取消'),
                      onConfirm: function () {
                        try {
                          deleteActionSegment(id);
                          hideModal();
                        } catch (err) {
                          log('ERROR', 'delete segment onConfirm failed: ' + (err.message || err));
                          hideModal();
                        }
                      }
                    });
                  }
                } catch (err) {
                  log('ERROR', 'segment delete btn click failed: ' + (err.message || err));
                }
              });
            })(segDeleteBtns[sd]);
          }
        }
      }

      // === 3. 更新面板计数 ===
      updatePanelCount();
    } catch (e) {
      log('ERROR', 'renderActionPanel failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // 阶段 7：手物交互（物体框 + 关系）
  // 数据结构：
  //   state.annotations.objects: [{id, frame_idx, name, bbox:[x,y,w,h], color}]
  //   state.annotations.hand_object: [{id, frame_idx, hand_bbox_id, object_bbox_id, relation, critical_frame}]
  // ============================================================

  // ===== 工具：生成物体 ID =====
  function genObjectId() {
    try {
      return 'obj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    } catch (e) {
      return 'obj_' + Date.now() + '_fallback';
    }
  }

  // ===== 工具：生成关系 ID =====
  function genRelationId() {
    try {
      return 'ho_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    } catch (e) {
      return 'ho_' + Date.now() + '_fallback';
    }
  }

  // ===== 工具：按 ID 查找物体框 =====
  function findObjectById(id) {
    try {
      if (!id) return null;
      var list = state.annotations.objects || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findObjectById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 工具：按 ID 查找关系 =====
  function findRelationById(id) {
    try {
      if (!id) return null;
      var list = state.annotations.hand_object || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findRelationById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 工具：按 ID 查找手部检测框 =====
  function findHandDetectionById(id) {
    try {
      if (!id) return null;
      var list = state.annotations.hand_detection || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    } catch (e) {
      log('ERROR', 'findHandDetectionById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== Task 7.1：手物交互 - 物体框绘制完成处理 =====
  function handleHandObjectDrawComplete(rect) {
    try {
      if (!rect || rect.length < 4) {
        log('WARN', 'handleHandObjectDrawComplete: invalid rect');
        return;
      }
      var bbox = [rect[0], rect[1], rect[2], rect[3]];
      log('HAND_OBJECT', 'draw complete, showing object name modal, bbox=' +
        JSON.stringify(bbox) + ' frame=' + state.currentFrame);

      // 弹窗输入物体名称（必填）
      var body =
        '<p style="margin:0 0 10px 0;font-size:13px;color:var(--color-on-surface-variant);">' +
          tt('annotate.ho_object_name_prompt', '请输入物体名称（如：杯子、螺丝刀）') +
        '</p>' +
        '<input type="text" id="hoObjectNameInput" class="annotate-input" ' +
          'placeholder="' + tt('annotate.ho_object_name_placeholder', '物体名称') + '" ' +
          'style="width:100%;padding:8px 10px;background:var(--color-surface-container-high);' +
          'color:var(--color-on-surface);border:1px solid rgba(255,255,255,0.1);' +
          'border-radius:6px;font-size:14px;box-sizing:border-box;" autofocus>';

      showModal({
        title: tt('annotate.ho_object_name_title', '命名物体'),
        body: body,
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var inputEl = qs('hoObjectNameInput');
            var name = inputEl ? String(inputEl.value || '').trim() : '';
            if (!name) {
              log('WARN', 'handleHandObjectDrawComplete: object name is empty');
              showToast(tt('annotate.ho_err_name_required', '物体名称不能为空'));
              return;
            }
            var obj = {
              id: genObjectId(),
              frame_idx: state.currentFrame,
              name: name,
              bbox: bbox,
              color: '#f97316'
            };
            state.annotations.objects.push(obj);
            state.selectedIds.object = obj.id;
            log('HAND_OBJECT', 'object created, id=' + obj.id +
              ' name=' + name + ' frame=' + obj.frame_idx +
              ' bbox=[' + bbox[0].toFixed(1) + ',' + bbox[1].toFixed(1) +
              ',' + bbox[2].toFixed(1) + ',' + bbox[3].toFixed(1) + ']');

            saveToLocalStorage();
            triggerRedraw();
            renderPanel();
            pushHistory(state);
            hideModal();
          } catch (e) {
            log('ERROR', 'handleHandObjectDrawComplete onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });

      // 自动聚焦输入框
      setTimeout(function () {
        try {
          var el = qs('hoObjectNameInput');
          if (el) el.focus();
        } catch (e) {
          log('WARN', 'hoObjectNameInput focus failed: ' + (e.message || e));
        }
      }, 50);
    } catch (e) {
      log('ERROR', 'handleHandObjectDrawComplete failed: ' + (e.message || e));
    }
  }

  // ===== Task 7.2：手物交互 - 添加关系弹窗 =====
  function showAddRelationModal() {
    try {
      var frame = state.currentFrame;
      var handList = (state.annotations.hand_detection || []).filter(function (h) {
        return h && h.frame_idx === frame;
      });
      var objList = (state.annotations.objects || []).filter(function (o) {
        return o && o.frame_idx === frame;
      });

      log('RELATION', 'showAddRelationModal frame=' + frame +
        ' hands=' + handList.length + ' objects=' + objList.length);

      if (handList.length === 0) {
        showToast(tt('annotate.ho_err_no_hand', '当前帧没有手部检测框，请先在手部检测 Tab 标注'));
        return;
      }
      if (objList.length === 0) {
        showToast(tt('annotate.ho_err_no_object', '当前帧没有物体框，请在画布上拖拽创建'));
        return;
      }

      // 构造手框选项
      var handOptionsHtml = '';
      for (var i = 0; i < handList.length; i++) {
        var h = handList[i];
        var label = (h.hand === 'left' ? 'L' : 'R') + ' · frame ' + (h.frame_idx + 1);
        handOptionsHtml += '<option value="' + escapeHtml(h.id) + '">' + escapeHtml(label) + '</option>';
      }
      // 构造物体框选项
      var objOptionsHtml = '';
      for (var j = 0; j < objList.length; j++) {
        var o = objList[j];
        objOptionsHtml += '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(o.name || '(unnamed)') + '</option>';
      }

      var selectStyle = 'width:100%;padding:6px 8px;background:var(--color-surface-container-high);' +
        'color:var(--color-on-surface);border:1px solid rgba(255,255,255,0.1);' +
        'border-radius:6px;font-size:13px;box-sizing:border-margin;margin-bottom:10px;';

      var radioStyle = 'display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;' +
        'color:var(--color-on-surface);padding:4px 6px;border-radius:4px;';

      var body =
        '<div style="margin-bottom:10px;">' +
          '<label style="display:block;margin:0 0 4px 0;font-size:12px;color:var(--color-on-surface-variant);font-weight:600;">' +
            tt('annotate.ho_select_hand', '选择手框') +
          '</label>' +
          '<select id="hoRelHandSelect" style="' + selectStyle + '">' + handOptionsHtml + '</select>' +
        '</div>' +
        '<div style="margin-bottom:10px;">' +
          '<label style="display:block;margin:0 0 4px 0;font-size:12px;color:var(--color-on-surface-variant);font-weight:600;">' +
            tt('annotate.ho_select_object', '选择物体框') +
          '</label>' +
          '<select id="hoRelObjectSelect" style="' + selectStyle + '">' + objOptionsHtml + '</select>' +
        '</div>' +
        '<div style="margin-bottom:10px;">' +
          '<label style="display:block;margin:0 0 4px 0;font-size:12px;color:var(--color-on-surface-variant);font-weight:600;">' +
            tt('annotate.ho_relation_type', '关系类型') +
          '</label>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoRelation" value="hold" checked> hold</label>' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoRelation" value="touch"> touch</label>' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoRelation" value="release"> release</label>' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoRelation" value="manipulate"> manipulate</label>' +
          '</div>' +
        '</div>' +
        '<div style="margin-bottom:6px;">' +
          '<label style="display:block;margin:0 0 4px 0;font-size:12px;color:var(--color-on-surface-variant);font-weight:600;">' +
            tt('annotate.ho_critical_frame', '关键帧类型') +
          '</label>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoCriticalFrame" value="PRE" checked> PRE</label>' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoCriticalFrame" value="CONTACT"> CONTACT</label>' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoCriticalFrame" value="PNR"> PNR</label>' +
            '<label style="' + radioStyle + '"><input type="radio" name="hoCriticalFrame" value="POST"> POST</label>' +
          '</div>' +
        '</div>';

      showModal({
        title: tt('annotate.ho_add_relation_title', '添加手物关系'),
        body: body,
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var handSel = qs('hoRelHandSelect');
            var objSel = qs('hoRelObjectSelect');
            var handId = handSel ? handSel.value : '';
            var objId = objSel ? objSel.value : '';

            if (!handId || !objId) {
              log('WARN', 'showAddRelationModal: missing handId or objId');
              showToast(tt('annotate.ho_err_selection', '请选择手框和物体框'));
              return;
            }

            // 读取单选值
            var relation = 'hold';
            var relRadios = document.getElementsByName('hoRelation');
            for (var r = 0; r < relRadios.length; r++) {
              if (relRadios[r].checked) { relation = relRadios[r].value; break; }
            }
            var criticalFrame = 'PRE';
            var cfRadios = document.getElementsByName('hoCriticalFrame');
            for (var c = 0; c < cfRadios.length; c++) {
              if (cfRadios[c].checked) { criticalFrame = cfRadios[c].value; break; }
            }

            // 校验枚举值
            var validRelations = ['hold', 'touch', 'release', 'manipulate'];
            var validCFs = ['PRE', 'CONTACT', 'PNR', 'POST'];
            if (validRelations.indexOf(relation) === -1) relation = 'hold';
            if (validCFs.indexOf(criticalFrame) === -1) criticalFrame = 'PRE';

            var rel = {
              id: genRelationId(),
              frame_idx: state.currentFrame,
              hand_bbox_id: handId,
              object_bbox_id: objId,
              relation: relation,
              critical_frame: criticalFrame
            };
            state.annotations.hand_object.push(rel);
            state.selectedIds.relation = rel.id;
            state.selectedIds.object = null;

            log('RELATION', 'relation created, id=' + rel.id +
              ' hand=' + handId + ' obj=' + objId +
              ' relation=' + relation + ' cf=' + criticalFrame +
              ' frame=' + rel.frame_idx);

            saveToLocalStorage();
            triggerRedraw();
            renderPanel();
            pushHistory(state);
            hideModal();
          } catch (e) {
            log('ERROR', 'showAddRelationModal onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'showAddRelationModal failed: ' + (e.message || e));
    }
  }

  // ===== Task 7.3：删除关系 =====
  function deleteRelation(id) {
    try {
      if (!id) {
        log('WARN', 'deleteRelation: id is null');
        return;
      }
      var list = state.annotations.hand_object;
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          var removed = list[i];
          list.splice(i, 1);
          log('RELATION', 'deleteRelation id=' + id +
            ' (hand=' + removed.hand_bbox_id + ', obj=' + removed.object_bbox_id +
            ', frame=' + removed.frame_idx + ')');
          if (state.selectedIds.relation === id) {
            state.selectedIds.relation = null;
          }
          saveToLocalStorage();
          triggerRedraw();
          renderPanel();
          return;
        }
      }
      log('WARN', 'deleteRelation: id not found ' + id);
    } catch (e) {
      log('ERROR', 'deleteRelation failed: ' + (e.message || e));
    }
  }

  // ===== Task 7.3：删除物体框（同时级联删除引用它的关系） =====
  function deleteObject(id) {
    try {
      if (!id) {
        log('WARN', 'deleteObject: id is null');
        return;
      }
      var list = state.annotations.objects;
      if (!Array.isArray(list)) return;

      // 1. 删除物体框
      var removedObj = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) {
          removedObj = list[i];
          list.splice(i, 1);
          break;
        }
      }
      if (!removedObj) {
        log('WARN', 'deleteObject: id not found ' + id);
        return;
      }
      log('HAND_OBJECT', 'deleteObject id=' + id +
        ' name=' + removedObj.name + ' frame=' + removedObj.frame_idx);

      // 2. 级联删除引用该物体的关系
      var relList = state.annotations.hand_object || [];
      var removedRelCount = 0;
      for (var j = relList.length - 1; j >= 0; j--) {
        if (relList[j] && relList[j].object_bbox_id === id) {
          relList.splice(j, 1);
          removedRelCount++;
        }
      }
      if (removedRelCount > 0) {
        log('RELATION', 'cascade deleted ' + removedRelCount +
          ' relation(s) referencing object ' + id);
      }

      // 3. 清空选中
      if (state.selectedIds.object === id) {
        state.selectedIds.object = null;
      }
      // 如果有引用该物体的关系被选中，也清空
      // （上面的循环已删除关系，selectedIds.relation 若指向被删除的关系，下次选中时会自动失效）

      saveToLocalStorage();
      triggerRedraw();
      renderPanel();
    } catch (e) {
      log('ERROR', 'deleteObject failed: ' + (e.message || e));
    }
  }

  // ===== Task 7.3：渲染手物交互面板 =====
  function renderHandObjectPanel() {
    try {
      var panel = dom.handObjectPanel || qs('handObjectPanel');
      if (!panel) {
        log('WARN', 'renderHandObjectPanel: handObjectPanel not found');
        return;
      }
      // 仅在 hand_object tab 显示
      if (state.activeTab !== 'hand_object') {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = '';

      var frame = state.currentFrame;
      var frameObjects = (state.annotations.objects || []).filter(function (o) {
        return o && o.frame_idx === frame;
      });
      var allRelations = state.annotations.hand_object || [];

      // === 1. 渲染物体列表（当前帧） ===
      var objectsListEl = dom.objectsList || qs('objectsList');
      if (objectsListEl) {
        if (frameObjects.length === 0) {
          objectsListEl.innerHTML = '<p style="margin:0;padding:6px;font-size:11px;' +
            'color:var(--color-on-surface-variant);text-align:center;">' +
            tt('annotate.ho_no_objects', '当前帧暂无物体，在画布上拖拽创建') + '</p>';
        } else {
          var objHtml = '<ul style="list-style:none;padding:0;margin:0;">';
          for (var i = 0; i < frameObjects.length; i++) {
            var obj = frameObjects[i];
            var isObjSelected = state.selectedIds.object === obj.id;
            var objStyle = isObjSelected ?
              'background:rgba(249,115,22,0.15);border-left:3px solid #f97316;' :
              'border-left:3px solid #f97316;';
            objHtml += '<li class="ho-object-item" data-obj-id="' + escapeHtml(obj.id) + '" ' +
              'style="display:flex;align-items:center;gap:6px;padding:5px 8px;' + objStyle +
              'border-radius:4px;margin-bottom:2px;font-size:12px;cursor:pointer;">' +
              '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;' +
              'background:' + (obj.color || '#f97316') + ';flex-shrink:0;"></span>' +
              '<span style="flex:1;color:var(--color-on-surface);overflow:hidden;' +
              'text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(obj.name || '(unnamed)') + '</span>' +
              '<button type="button" class="ho-object-delete" data-obj-id="' + escapeHtml(obj.id) + '" ' +
              'title="' + tt('annotate.delete', '删除') + '" ' +
              'style="background:transparent;border:none;color:#ef4444;cursor:pointer;' +
              'padding:2px 4px;font-size:14px;line-height:1;border-radius:4px;">×</button>' +
              '</li>';
          }
          objHtml += '</ul>';
          objectsListEl.innerHTML = objHtml;

          // 绑定物体项点击（选中）
          var objItems = objectsListEl.querySelectorAll('.ho-object-item');
          for (var oi = 0; oi < objItems.length; oi++) {
            (function (item) {
              item.addEventListener('click', function (e) {
                try {
                  if (e.target && e.target.classList && e.target.classList.contains('ho-object-delete')) return;
                  var id = item.getAttribute('data-obj-id');
                  state.selectedIds.object = id;
                  state.selectedIds.relation = null;
                  log('HAND_OBJECT', 'panel object selected, id=' + id);
                  triggerRedraw();
                  renderPanel();
                } catch (err) {
                  log('ERROR', 'object item click failed: ' + (err.message || err));
                }
              });
            })(objItems[oi]);
          }

          // 绑定物体删除按钮
          var objDeleteBtns = objectsListEl.querySelectorAll('.ho-object-delete');
          for (var od = 0; od < objDeleteBtns.length; od++) {
            (function (btn) {
              btn.addEventListener('click', function (e) {
                try {
                  e.stopPropagation();
                  var id = btn.getAttribute('data-obj-id');
                  var obj2 = findObjectById(id);
                  showModal({
                    title: tt('annotate.ho_delete_object_title', '删除物体'),
                    body: '<p>' + tt('annotate.ho_delete_object_body',
                      '确认删除物体「' + (obj2 ? obj2.name : '') + '」？关联的关系也将一并删除。') + '</p>',
                    confirmText: tt('annotate.delete', '删除'),
                    cancelText: tt('annotate.modal_cancel', '取消'),
                    onConfirm: function () {
                      try {
                        deleteObject(id);
                        hideModal();
                      } catch (err) {
                        log('ERROR', 'delete object onConfirm failed: ' + (err.message || err));
                        hideModal();
                      }
                    }
                  });
                } catch (err) {
                  log('ERROR', 'object delete btn click failed: ' + (err.message || err));
                }
              });
            })(objDeleteBtns[od]);
          }
        }
      }

      // === 2. 渲染关系列表（所有帧，按 frame_idx 排序） ===
      var relationsListEl = dom.relationsList || qs('relationsList');
      if (relationsListEl) {
        if (allRelations.length === 0) {
          relationsListEl.innerHTML = '<p style="margin:0;padding:6px;font-size:11px;' +
            'color:var(--color-on-surface-variant);text-align:center;">' +
            tt('annotate.ho_no_relations', '点击「+ 添加关系」创建') + '</p>';
        } else {
          // 排序：按 frame_idx 升序
          var sortedRels = allRelations.slice().sort(function (a, b) {
            return (a.frame_idx || 0) - (b.frame_idx || 0);
          });
          var relHtml = '<ul style="list-style:none;padding:0;margin:0;">';
          for (var ri = 0; ri < sortedRels.length; ri++) {
            var r = sortedRels[ri];
            var hand = findHandDetectionById(r.hand_bbox_id);
            var obj3 = findObjectById(r.object_bbox_id);
            var handLabel = hand ?
              (hand.hand === 'left' ? 'L' : 'R') : '?';
            var objLabel = obj3 ? (obj3.name || '?') : '?';
            var isRelSelected = state.selectedIds.relation === r.id;
            var relStyle = isRelSelected ?
              'background:rgba(249,115,22,0.15);border-left:3px solid #f97316;' :
              'border-left:3px solid #f97316;';
            relHtml += '<li class="ho-relation-item" data-rel-id="' + escapeHtml(r.id) + '" ' +
              'style="display:flex;align-items:center;gap:6px;padding:5px 8px;' + relStyle +
              'border-radius:4px;margin-bottom:2px;font-size:12px;cursor:pointer;">' +
              '<span style="color:#22c55e;font-weight:600;min-width:14px;">' + escapeHtml(handLabel) + '</span>' +
              '<span style="color:var(--color-on-surface-variant);">→</span>' +
              '<span style="color:#f97316;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                escapeHtml(objLabel) + '</span>' +
              '<span style="color:var(--color-on-surface);font-size:11px;">' +
                escapeHtml(r.relation || '?') + ' · ' + escapeHtml(r.critical_frame || '?') + '</span>' +
              '<span style="color:var(--color-on-surface-variant);font-size:10px;font-variant-numeric:tabular-nums;">f' +
                (r.frame_idx + 1) + '</span>' +
              '<button type="button" class="ho-relation-delete" data-rel-id="' + escapeHtml(r.id) + '" ' +
              'title="' + tt('annotate.delete', '删除') + '" ' +
              'style="background:transparent;border:none;color:#ef4444;cursor:pointer;' +
              'padding:2px 4px;font-size:14px;line-height:1;border-radius:4px;">×</button>' +
              '</li>';
          }
          relHtml += '</ul>';
          relationsListEl.innerHTML = relHtml;

          // 绑定关系项点击（选中 + 跳转帧）
          var relItems = relationsListEl.querySelectorAll('.ho-relation-item');
          for (var ri2 = 0; ri2 < relItems.length; ri2++) {
            (function (item) {
              item.addEventListener('click', function (e) {
                try {
                  if (e.target && e.target.classList && e.target.classList.contains('ho-relation-delete')) return;
                  var id = item.getAttribute('data-rel-id');
                  var rel2 = findRelationById(id);
                  if (rel2) {
                    state.selectedIds.relation = id;
                    state.selectedIds.object = null;
                    log('RELATION', 'panel item selected, relId=' + id + ' jump to ' + rel2.frame_idx);
                    setFrame(rel2.frame_idx);
                  }
                } catch (err) {
                  log('ERROR', 'relation item click failed: ' + (err.message || err));
                }
              });
            })(relItems[ri2]);
          }

          // 绑定关系删除按钮
          var relDeleteBtns = relationsListEl.querySelectorAll('.ho-relation-delete');
          for (var rd = 0; rd < relDeleteBtns.length; rd++) {
            (function (btn) {
              btn.addEventListener('click', function (e) {
                try {
                  e.stopPropagation();
                  var id = btn.getAttribute('data-rel-id');
                  var rel3 = findRelationById(id);
                  if (rel3) {
                    var relHand = findHandDetectionById(rel3.hand_bbox_id);
                    var relObj = findObjectById(rel3.object_bbox_id);
                    showModal({
                      title: tt('annotate.ho_delete_relation_title', '删除关系'),
                      body: '<p>' + tt('annotate.ho_delete_relation_body',
                        '确认删除关系（' + (relHand ? (relHand.hand === 'left' ? 'L' : 'R') : '?') +
                        ' → ' + (relObj ? relObj.name : '?') + ', ' +
                        (rel3.relation || '?') + ' · ' + (rel3.critical_frame || '?') + '）？') + '</p>',
                      confirmText: tt('annotate.delete', '删除'),
                      cancelText: tt('annotate.modal_cancel', '取消'),
                      onConfirm: function () {
                        try {
                          deleteRelation(id);
                          hideModal();
                        } catch (err) {
                          log('ERROR', 'delete relation onConfirm failed: ' + (err.message || err));
                          hideModal();
                        }
                      }
                    });
                  }
                } catch (err) {
                  log('ERROR', 'relation delete btn click failed: ' + (err.message || err));
                }
              });
            })(relDeleteBtns[rd]);
          }
        }
      }

      // === 3. 提示信息 ===
      if (dom.handObjectHint) {
        var totalObjs = (state.annotations.objects || []).length;
        var totalRels = (state.annotations.hand_object || []).length;
        dom.handObjectHint.textContent =
          '当前帧物体 ' + frameObjects.length + ' · 全部物体 ' + totalObjs +
          ' · 全部关系 ' + totalRels;
      }

      // === 4. 更新面板计数（显示关系总数） ===
      if (dom.panelCount) {
        dom.panelCount.textContent = String(allRelations.length);
      }

      // === 5. 清空主列表区（panelList）的占位，避免在 hand_object tab 显示手部检测列表 ===
      if (dom.panelList) {
        dom.panelList.innerHTML = '';
      }
    } catch (e) {
      log('ERROR', 'renderHandObjectPanel failed: ' + (e.message || e));
    }
  }

  // ===== 统一面板渲染入口（根据 activeTab 分发） =====
  function renderPanel() {
    try {
      var tab = state.activeTab;
      // 先按需隐藏各 tab 专属面板，避免残留显示
      var kpPanel = qs('keypointsPanel');
      var hdAttrPanel = qs('handDetectionAttrPanel');
      var actionPanelEl = dom.actionPanel || qs('actionPanel');
      var hoPanelEl = dom.handObjectPanel || qs('handObjectPanel');
      if (tab !== 'keypoints' && kpPanel) {
        kpPanel.style.display = 'none';
      }
      if (tab !== 'hand_detection' && hdAttrPanel) {
        hdAttrPanel.style.display = 'none';
      }
      if (tab !== 'action' && actionPanelEl) {
        actionPanelEl.style.display = 'none';
      }
      if (tab !== 'hand_object' && hoPanelEl) {
        hoPanelEl.style.display = 'none';
      }

      if (tab === 'hand_detection') {
        renderHandDetectionPanel();
      } else if (tab === 'keypoints') {
        renderKeypointsPanel();
      } else if (tab === 'action') {
        // 阶段 6：动作分割面板
        renderActionPanel();
      } else if (tab === 'hand_object') {
        // 阶段 7：手物交互面板
        renderHandObjectPanel();
      } else {
        updatePanelCount();
      }
    } catch (e) {
      log('ERROR', 'renderPanel failed: ' + (e.message || e));
    }
  }

  // ===== 渲染初始 UI 状态 =====
  function renderInitial() {
    try {
      updateStepsIndicator();
      updatePanelTitle(state.activeTab);
      updatePanelCount();
      // 初始化右侧面板内容（阶段 4：手部检测面板）
      renderPanel();
      // 帧号 / 时间戳 / 进度条初始化
      updateFrameDisplay();
      if (dom.speedLabel) dom.speedLabel.textContent = (PLAYBACK_SPEEDS[state.playbackSpeedIdx] || 1) + 'x';
      if (dom.stepNavInfo) dom.stepNavInfo.textContent = state.currentStep + ' / ' + TOTAL_STEPS;

      // 同步 Tab UI
      for (var i = 0; i < dom.tabBtns.length; i++) {
        var btn = dom.tabBtns[i];
        var tab = btn.getAttribute('data-tab');
        if (tab === state.activeTab) btn.classList.add('active');
        else btn.classList.remove('active');
      }

      // 同步步骤内容显示
      for (var j = 0; j < dom.stepContents.length; j++) {
        if (dom.stepContents[j]) {
          if (j + 1 === state.currentStep) dom.stepContents[j].classList.add('active');
          else dom.stepContents[j].classList.remove('active');
        }
      }

      // 上一步按钮禁用状态
      if (dom.prevBtn) {
        dom.prevBtn.disabled = (state.currentStep === 1);
        dom.prevBtn.style.opacity = (state.currentStep === 1) ? '0.5' : '1';
        dom.prevBtn.style.cursor = (state.currentStep === 1) ? 'not-allowed' : 'pointer';
      }

      // 元信息表单回填
      if (dom.sceneTypeInput) dom.sceneTypeInput.value = state.meta.scene_type || '';
      if (dom.deviceInput) dom.deviceInput.value = state.meta.device || '';
      if (dom.collectorInput) dom.collectorInput.value = state.meta.collector || '';
      if (dom.dateInput) dom.dateInput.value = state.meta.date || '';
      if (dom.fpsInput) dom.fpsInput.value = state.meta.fps || 30;
      if (dom.resolutionInput && state.videoResolution[0] > 0 && state.videoResolution[1] > 0) {
        dom.resolutionInput.value = state.videoResolution[0] + ' × ' + state.videoResolution[1];
      }
      if (dom.remarkInput) dom.remarkInput.value = state.meta.remark || '';

      // 阶段 6：动作分割 — 初始化时间轴渲染 + 动作面板
      try {
        if (typeof renderTimeline === 'function') {
          renderTimeline();
        }
      } catch (eTL) {
        log('ERROR', 'renderTimeline in renderInitial failed: ' + (eTL.message || eTL));
      }
      try {
        if (typeof renderActionPanel === 'function') {
          renderActionPanel();
        }
      } catch (eAP) {
        log('ERROR', 'renderActionPanel in renderInitial failed: ' + (eAP.message || eAP));
      }

      // 文件信息回填（仅元信息，不含 videoUrl 运行时字段）
      if (state.videoFileName && dom.fileName) {
        dom.fileName.textContent = state.videoFileName;
        updateFileInfoUI();
        if (dom.fileInfo) dom.fileInfo.removeAttribute('hidden');
      }

      log('INIT', 'Initial render complete');
    } catch (e) {
      log('ERROR', 'renderInitial failed: ' + (e.message || e));
    }
  }

  // ===== 注册 Canvas 钩子（onDrawComplete / onKeypointClick） =====
  // 由于 annotate-canvas.js 的 init 通过 setTimeout(0) 延后执行，
  // 需要确保 AIX_ANNOTATE_CANVAS 已暴露且未被 init 重置 onDrawComplete。
  function registerCanvasHooks() {
    try {
      if (!window.AIX_ANNOTATE_CANVAS) {
        log('WARN', 'registerCanvasHooks: AIX_ANNOTATE_CANVAS not ready, retry in 50ms');
        setTimeout(registerCanvasHooks, 50);
        return;
      }
      window.AIX_ANNOTATE_CANVAS.onDrawComplete = handleDrawComplete;
      log('INIT', 'Registered AIX_ANNOTATE_CANVAS.onDrawComplete = handleDrawComplete');
      // 阶段 5：注册关键点点击回调（canvas click 添加关键点）
      window.AIX_ANNOTATE_CANVAS.onKeypointClick = handleKeypointClick;
      log('INIT', 'Registered AIX_ANNOTATE_CANVAS.onKeypointClick = handleKeypointClick');
    } catch (e) {
      log('ERROR', 'registerCanvasHooks failed: ' + (e.message || e));
    }
  }

  // ===== 初始化 =====
  function init() {
    try {
      log('INIT', 'Annotate page initializing...');

      cacheDom();

      // 校验关键 DOM 元素
      var criticalMissing = [];
      if (!dom.steps) criticalMissing.push('annotateSteps');
      if (!dom.prevBtn) criticalMissing.push('annotatePrevBtn');
      if (!dom.nextBtn) criticalMissing.push('annotateNextBtn');
      if (!dom.tabs) criticalMissing.push('annotateTabs');
      if (!dom.uploadZone) criticalMissing.push('annotateUploadZone');
      if (!dom.video) criticalMissing.push('annotateVideo');
      if (!dom.canvas) criticalMissing.push('annotateCanvas');
      if (!dom.panelList) criticalMissing.push('annotatePanelList');
      if (!dom.timeline) criticalMissing.push('annotateTimeline');
      if (criticalMissing.length > 0) {
        log('ERROR', 'Missing critical DOM elements: ' + criticalMissing.join(', '));
      } else {
        log('INIT', 'All critical DOM elements found');
      }

      // 从 localStorage 恢复状态
      var saved = loadFromLocalStorage();
      if (saved) {
        applySavedState(saved);
        log('INIT', 'State restored from localStorage');
      } else {
        log('INIT', 'No saved state, using defaults');
      }

      // 渲染初始 UI
      renderInitial();

      // 绑定事件
      bindEvents();

      // 注册 Canvas 钩子（onDrawComplete / onAnnotationEdited）
      registerCanvasHooks();

      log('INIT', 'Annotate page ready, currentStep=' + state.currentStep + ' activeTab=' + state.activeTab);
    } catch (e) {
      log('ERROR', 'init failed: ' + (e.message || e));
      // 致命错误时尝试提示用户
      try {
        showToast('标注工具初始化失败: ' + (e.message || e));
      } catch (_) {}
    }
  }

  // ===== 暴露 API =====
  window.AIX_ANNOTATE = {
    state: state,
    log: log,
    goToStep: goToStep,
    nextStep: nextStep,
    prevStep: prevStep,
    switchTab: switchTab,
    setFrame: setFrame,
    togglePlay: togglePlay,
    stepFrame: stepFrame,
    goToFramePrompt: goToFramePrompt,
    cyclePlaybackRate: cyclePlaybackRate,
    toggleFullscreen: toggleFullscreen,
    updateFrameDisplay: updateFrameDisplay,
    handleFileSelect: handleFileSelect,
    handleDrop: handleDrop,
    detectVideoMetadata: detectVideoMetadata,
    validateMetaForm: validateMetaForm,
    saveToLocalStorage: saveToLocalStorage,
    loadFromLocalStorage: loadFromLocalStorage,
    clearAnnotations: clearAnnotations,
    importAnnotations: importAnnotations,
    pushHistory: pushHistory,
    undo: undo,
    redo: redo,
    showModal: showModal,
    hideModal: hideModal,
    showToast: showToast,
    // 阶段 4：手部检测相关函数
    renderPanel: renderPanel,
    renderHandDetectionPanel: renderHandDetectionPanel,
    renderHandDetectionAttrPanel: renderHandDetectionAttrPanel,
    deleteHandDetection: deleteHandDetection,
    setHandOcclusion: setHandOcclusion,
    recomputeInterpolation: recomputeInterpolation,
    handleDrawComplete: handleDrawComplete,
    handleHandDetectionDrawComplete: handleHandDetectionDrawComplete,
    onAnnotationEdited: onAnnotationEdited,
    // 阶段 5：关键点相关函数
    renderKeypointsPanel: renderKeypointsPanel,
    handleKeypointClick: handleKeypointClick,
    startKeypointAnnotation: startKeypointAnnotation,
    copyKeypointsFromPrevFrame: copyKeypointsFromPrevFrame,
    clearKeypointsCurrentFrame: clearKeypointsCurrentFrame,
    setKeypointVisibility: setKeypointVisibility,
    deleteKeypointAnnotation: deleteKeypointAnnotation,
    findKeypointAnnotationById: findKeypointAnnotationById,
    findKeypointAnnotationByHand: findKeypointAnnotationByHand,
    HAND_KEYPOINT_NAMES: HAND_KEYPOINT_NAMES,
    HAND_KEYPOINT_BONES: HAND_KEYPOINT_BONES,
    // 阶段 6：动作分割相关函数
    renderTimeline: renderTimeline,
    bindTimelineEvents: bindTimelineEvents,
    createActionSegment: createActionSegment,
    deleteActionSegment: deleteActionSegment,
    resizeActionSegment: resizeActionSegment,
    renderActionPanel: renderActionPanel,
    addActionLabel: addActionLabel,
    renameActionLabel: renameActionLabel,
    deleteActionLabel: deleteActionLabel,
    setActionLabelColor: setActionLabelColor,
    showActionLabelModal: showActionLabelModal,
    findActionSegmentAt: findActionSegmentAt,
    findActionLabelById: findActionLabelById,
    findActionSegmentById: findActionSegmentById,
    pickLabelColor: pickLabelColor,
    LABEL_COLORS: LABEL_COLORS,
    // 阶段 7：手物交互相关函数
    handleHandObjectDrawComplete: handleHandObjectDrawComplete,
    showAddRelationModal: showAddRelationModal,
    renderHandObjectPanel: renderHandObjectPanel,
    deleteRelation: deleteRelation,
    deleteObject: deleteObject,
    findObjectById: findObjectById,
    findRelationById: findRelationById,
    findHandDetectionById: findHandDetectionById,
    genObjectId: genObjectId,
    genRelationId: genRelationId,
    // 阶段 9：预览回放模式 API
    enterPreviewMode: enterPreviewMode,
    exitPreviewMode: exitPreviewMode,
    syncPreviewVisibleFlags: syncPreviewVisibleFlags,
    updatePreviewPlayBtnIcon: updatePreviewPlayBtnIcon,
    updatePreviewSpeedLabel: updatePreviewSpeedLabel,
    updatePreviewProgress: updatePreviewProgress,
    updatePreviewTimeLabel: updatePreviewTimeLabel,
    // 回调钩子（供 annotate-canvas.js / annotate-export.js 注册）
    onFrameChange: null,
    onTabChange: null,
    onStepEnter: null,
    redrawCanvas: null
  };

  log('INIT', 'annotate.js loaded, AIX_ANNOTATE exposed');

  // 启动
  domReady(init);
})();
