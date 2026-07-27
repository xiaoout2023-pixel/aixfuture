/*!
 * AIX未来视野 - EGO 数据标注工具 Canvas 渲染层 (annotate-canvas.js)
 * 阶段 3：Canvas 渲染基础 / 坐标变换 / 鼠标交互基础
 *
 * 依赖：window.AIX_ANNOTATE (annotate.js)
 *
 * 暴露 API：window.AIX_ANNOTATE_CANVAS
 *  - init(): 初始化 canvas / video / 事件
 *  - render(): 重绘 canvas（清屏 + 绘制标注 + 绘制交互辅助）
 *  - resizeCanvas(): 同步 canvas 尺寸到 video 显示尺寸
 *  - screenToVideoCoords(sx, sy): 屏幕坐标 -> 视频原始坐标
 *  - videoToCanvasCoords(vx, vy): 视频原始坐标 -> canvas 绘图坐标
 *  - drawRect / drawCircle / drawLine / drawText: 基础绘图辅助
 *  - getScale(): 获取当前缩放比 (canvas显示尺寸 / 视频原始尺寸)
 *  - drawHandDetection / drawHandKeypoints / drawActionSegmentation / drawHandObject:
 *      绘制钩子（阶段 4-7 注册，本阶段为 null）
 *  - interactionState: 鼠标交互状态
 *  - bindMouseEvents(): 绑定鼠标事件
 *  - getResizeHandle(x, y, bbox): 命中测试 8 个调整点
 *  - isPointInBBox / isPointInCircle: 几何命中测试
 *  - onDrawComplete: 绘制完成回调钩子（阶段 4-7 注册）
 */
(function () {
  'use strict';

  // ===== 模块内部状态 =====
  var canvas, ctx, video;
  var videoOriginalWidth = 0, videoOriginalHeight = 0;
  var canvasDisplayWidth = 0, canvasDisplayHeight = 0;
  // 视频在 object-fit:contain 下的实际显示区域（含偏移）
  // canvas 的 CSS 位置/尺寸将匹配此区域，确保标注层与视频画面完全对齐
  var displayOffsetX = 0, displayOffsetY = 0;
  var displayWidth = 0, displayHeight = 0;
  var scale = 1;  // 视频实际显示尺寸 / 视频原始尺寸（已修正黑边）
  // 缩放与平移（标注画布查看模式）
  // zoomLevel=1 原始大小；>1 放大；<1 缩小
  // panX/panY 为 CSS 像素平移量（相对未缩放时的显示位置）
  var zoomLevel = 1;
  var panX = 0, panY = 0;
  var isInitialized = false;
  var resizeObserver = null;

  // ===== 鼠标交互状态 =====
  var interactionState = {
    mode: 'idle',           // idle / drawing / selecting / resizing / moving
    startX: 0, startY: 0,   // 鼠标按下时的视频坐标
    currentX: 0, currentY: 0, // 当前鼠标视频坐标
    drawingRect: null,      // 正在绘制的矩形 [x, y, w, h]（视频坐标）
    selectedId: null,       // 当前选中的标注 ID
    resizeHandle: null,     // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w' 或 null
    _movingKeypointIndex: null, // 阶段 5：拖拽中的关键点索引（keypoints tab）
    _hitType: null          // 阶段 7：hand_object tab 命中类型 ('object' | 'relation' | null)
  };

  // ===== 阶段 9：预览回放模式状态 =====
  // previewMode = true 时，drawAnnotations 调用所有勾选的绘制函数（不区分 activeTab）
  var previewMode = false;
  // 4 种标注的可见开关（默认全部显示）
  var previewVisibleFlags = {
    hand: true,
    keypoints: true,
    action: true,
    handObject: true
  };

  // ===== 日志函数 =====
  // 格式: [AIX][AnnotateCanvas][TAG][HH:MM:SS.mmm] message
  function log(tag, message) {
    try {
      var now = new Date();
      var hh = pad(now.getHours(), 2);
      var mm = pad(now.getMinutes(), 2);
      var ss = pad(now.getSeconds(), 2);
      var ms = pad(now.getMilliseconds(), 3);
      var timestamp = hh + ':' + mm + ':' + ss + '.' + ms;
      console.log('[AIX][AnnotateCanvas][' + tag + '][' + timestamp + '] ' + message);
    } catch (e) {
      // console 不可用时降级（不阻断主流程）
    }
  }

  function pad(num, len) {
    try {
      num = String(num);
      while (num.length < len) num = '0' + num;
      return num;
    } catch (e) {
      return num;
    }
  }

  // ===== 安全获取 AIX_ANNOTATE 引用 =====
  function getAnnotate() {
    try {
      return (typeof window !== 'undefined' && window.AIX_ANNOTATE) ? window.AIX_ANNOTATE : null;
    } catch (e) {
      log('ERROR', 'getAnnotate failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 初始化 =====
  function init() {
    try {
      log('INIT', 'AnnotateCanvas initializing...');

      // 获取 DOM 元素
      canvas = document.getElementById('annotateCanvas');
      video = document.getElementById('annotateVideo');

      if (!canvas) {
        log('ERROR', 'init: canvas element #annotateCanvas not found');
        return;
      }
      if (!video) {
        log('ERROR', 'init: video element #annotateVideo not found');
        return;
      }

      // 获取 2D 上下文
      try {
        ctx = canvas.getContext('2d');
      } catch (e) {
        log('ERROR', 'init: getContext("2d") failed: ' + (e.message || e));
        return;
      }
      if (!ctx) {
        log('ERROR', 'init: canvas 2d context is null');
        return;
      }

      var A = getAnnotate();
      if (!A) {
        log('ERROR', 'init: window.AIX_ANNOTATE not available (annotate.js not loaded?)');
        // 不直接 return，仍允许基础事件绑定，但回调注册跳过
      }

      // 注册到 AIX_ANNOTATE 的回调钩子
      if (A) {
        try {
          A.onFrameChange = function (frame) {
            try {
              render();
              // 帧变化后刷新右侧面板
              if (typeof A.renderPanel === 'function') {
                A.renderPanel();
              }
            } catch (e) {
              log('ERROR', 'onFrameChange handler failed: ' + (e.message || e));
            }
          };
          log('INIT', 'Registered AIX_ANNOTATE.onFrameChange = render + renderPanel');
        } catch (e) {
          log('ERROR', 'init: register onFrameChange failed: ' + (e.message || e));
        }
        try {
          A.redrawCanvas = function () {
            try {
              render();
              if (typeof A.renderPanel === 'function') {
                A.renderPanel();
              }
            } catch (e) {
              log('ERROR', 'redrawCanvas handler failed: ' + (e.message || e));
            }
          };
          log('INIT', 'Registered AIX_ANNOTATE.redrawCanvas = render + renderPanel');
        } catch (e) {
          log('ERROR', 'init: register redrawCanvas failed: ' + (e.message || e));
        }
        try {
          A.onTabChange = function () {
            try {
              log('TAB', 'onTabChange callback -> render');
              // 切换 Tab 时清空交互状态，避免跨 Tab 残留选中
              resetInteractionState();
              render();
              // 切换 Tab 后刷新右侧面板
              if (typeof A.renderPanel === 'function') {
                A.renderPanel();
              }
            } catch (e) {
              log('ERROR', 'onTabChange handler failed: ' + (e.message || e));
            }
          };
          log('INIT', 'Registered AIX_ANNOTATE.onTabChange');
        } catch (e) {
          log('ERROR', 'init: register onTabChange failed: ' + (e.message || e));
        }
        try {
          A.onStepEnter = function (step) {
            try {
              // 进入步骤 3（标注）时显示缩放控件，其他步骤隐藏
              var zc = document.getElementById('annotateZoomControls');
              if (zc) {
                if (step === 3) {
                  zc.removeAttribute('hidden');
                } else {
                  zc.setAttribute('hidden', '');
                }
              }
              // 进入步骤 3 时重置缩放（新视频/重新进入标注时）
              if (step === 3) {
                resetZoom();
              }
            } catch (e) {
              log('ERROR', 'onStepEnter handler failed: ' + (e.message || e));
            }
          };
          log('INIT', 'Registered AIX_ANNOTATE.onStepEnter');
        } catch (e) {
          log('ERROR', 'init: register onStepEnter failed: ' + (e.message || e));
        }
      }

      // 监听 video 事件触发 render
      try {
        video.addEventListener('loadedmetadata', function () {
          try {
            videoOriginalWidth = video.videoWidth || 0;
            videoOriginalHeight = video.videoHeight || 0;
            log('VIDEO', 'loadedmetadata: ' + videoOriginalWidth + 'x' + videoOriginalHeight);
            resizeCanvas();
            render();
          } catch (e) {
            log('ERROR', 'video loadedmetadata handler failed: ' + (e.message || e));
          }
        });
        video.addEventListener('timeupdate', function () {
          try {
            render();
          } catch (e) {
            log('ERROR', 'video timeupdate render failed: ' + (e.message || e));
          }
        });
        video.addEventListener('play', function () {
          try {
            log('VIDEO', 'play event -> render');
            render();
          } catch (e) {
            log('ERROR', 'video play handler failed: ' + (e.message || e));
          }
        });
        video.addEventListener('pause', function () {
          try {
            log('VIDEO', 'pause event -> render');
            render();
          } catch (e) {
            log('ERROR', 'video pause handler failed: ' + (e.message || e));
          }
        });
        video.addEventListener('seeked', function () {
          try {
            log('VIDEO', 'seeked event -> render');
            render();
          } catch (e) {
            log('ERROR', 'video seeked handler failed: ' + (e.message || e));
          }
        });
      } catch (e) {
        log('ERROR', 'init: bind video events failed: ' + (e.message || e));
      }

      // 监听 window resize
      try {
        var resizeTimer = null;
        window.addEventListener('resize', function () {
          try {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
              resizeCanvas();
              render();
            }, 100);
          } catch (e) {
            log('ERROR', 'window resize handler failed: ' + (e.message || e));
          }
        });
        log('INIT', 'window resize listener bound');
      } catch (e) {
        log('ERROR', 'init: bind window resize failed: ' + (e.message || e));
      }

      // 监听 canvas 自身尺寸变化（ResizeObserver）
      try {
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(function (entries) {
            try {
              resizeCanvas();
              render();
            } catch (e) {
              log('ERROR', 'ResizeObserver callback failed: ' + (e.message || e));
            }
          });
          resizeObserver.observe(canvas);
          log('INIT', 'ResizeObserver bound to canvas');
        } else {
          log('INIT', 'ResizeObserver not supported, fallback to window resize only');
        }
      } catch (e) {
        log('ERROR', 'init: ResizeObserver setup failed: ' + (e.message || e));
      }

      // 绑定鼠标交互事件
      bindMouseEvents();

      // 绑定缩放控件事件
      bindZoomControls();

      // 初始尺寸同步
      resizeCanvas();

      isInitialized = true;
      log('INIT', 'AnnotateCanvas ready, scale=' + scale + ' canvasDisplay=' + canvasDisplayWidth + 'x' + canvasDisplayHeight);

      // 首次渲染
      log('RENDER', 'initial render after init');
      render();
    } catch (e) {
      log('ERROR', 'init failed: ' + (e.message || e));
    }
  }

  // ===== 重置交互状态 =====
  function resetInteractionState() {
    try {
      interactionState.mode = 'idle';
      interactionState.startX = 0;
      interactionState.startY = 0;
      interactionState.currentX = 0;
      interactionState.currentY = 0;
      interactionState.drawingRect = null;
      interactionState.selectedId = null;
      interactionState.resizeHandle = null;
      // 清空单关键点拖拽索引
      interactionState._movingKeypointIndex = null;
    } catch (e) {
      log('ERROR', 'resetInteractionState failed: ' + (e.message || e));
    }
  }

  // ===== 同步 canvas 尺寸 =====
  // 计算 video 在 object-fit:contain 下的实际显示矩形（含黑边偏移）
  // 将 canvas 的 CSS 位置/尺寸设为视频实际显示区域，确保标注层与视频画面完全对齐
  // canvas.width/height = video.videoWidth/Height（绘图缓冲区=视频原始尺寸，1:1 绘图坐标）
  function resizeCanvas() {
    try {
      if (!canvas || !video) {
        log('WARN', 'resizeCanvas: canvas or video not ready');
        return;
      }

      var vw = video.videoWidth || 0;
      var vh = video.videoHeight || 0;
      var cw = video.clientWidth || 0;
      var ch = video.clientHeight || 0;

      if (vw <= 0 || vh <= 0) {
        log('WARN', 'resizeCanvas: video metadata not ready (videoWidth=' + vw + ' videoHeight=' + vh + ')');
        canvasDisplayWidth = cw;
        canvasDisplayHeight = ch;
        scale = 1;
        return;
      }

      if (cw <= 0 || ch <= 0) {
        videoOriginalWidth = vw;
        videoOriginalHeight = vh;
        log('WARN', 'resizeCanvas: video client size is 0 (not visible yet)');
        return;
      }

      // 计算 object-fit:contain 的实际显示矩形
      // 视频保持宽高比，在容器内居中，可能产生黑边（letterbox/pillarbox）
      var videoRatio = vw / vh;
      var containerRatio = cw / ch;
      // 检测视频原始尺寸变化（切换视频时重置缩放）
      var videoChanged = (vw !== videoOriginalWidth || vh !== videoOriginalHeight);
      var dispW, dispH, offX, offY;
      if (videoRatio > containerRatio) {
        // 视频更宽：上下有黑边
        dispW = cw;
        dispH = cw / videoRatio;
        offX = 0;
        offY = (ch - dispH) / 2;
      } else {
        // 视频更高：左右有黑边
        dispH = ch;
        dispW = ch * videoRatio;
        offX = (cw - dispW) / 2;
        offY = 0;
      }

      // 设置 canvas 绘图缓冲区为视频原始尺寸（1:1 绘图坐标）
      try {
        canvas.width = vw;
        canvas.height = vh;
      } catch (e) {
        log('ERROR', 'resizeCanvas: set canvas.width/height failed: ' + (e.message || e));
        return;
      }

      // 设置 canvas CSS 位置/尺寸匹配视频实际显示区域（消除黑边导致的对齐偏差）
      try {
        canvas.style.left = offX + 'px';
        canvas.style.top = offY + 'px';
        canvas.style.width = dispW + 'px';
        canvas.style.height = dispH + 'px';
      } catch (e) {
        log('WARN', 'resizeCanvas: set canvas.style failed: ' + (e.message || e));
      }

      videoOriginalWidth = vw;
      videoOriginalHeight = vh;
      canvasDisplayWidth = cw;
      canvasDisplayHeight = ch;
      displayOffsetX = offX;
      displayOffsetY = offY;
      displayWidth = dispW;
      displayHeight = dispH;
      scale = dispW / vw;  // 修正后的 scale（实际显示宽 / 视频原始宽）

      // 视频切换时重置缩放和平移（新视频不应继承旧视频的缩放状态）
      if (videoChanged) {
        zoomLevel = 1;
        panX = 0;
        panY = 0;
      }
      // 应用 transform（确保 transform 始终同步）
      applyTransform();

      log('SCALE', 'video=' + vw + 'x' + vh + ' container=' + cw + 'x' + ch +
        ' display=' + dispW.toFixed(0) + 'x' + dispH.toFixed(0) +
        ' offset=(' + offX.toFixed(0) + ',' + offY.toFixed(0) + ')' +
        ' scale=' + scale.toFixed(4));
    } catch (e) {
      log('ERROR', 'resizeCanvas failed: ' + (e.message || e));
    }
  }

  // ===== 渲染入口 =====
  function render() {
    try {
      if (!isInitialized) {
        // 初始化前静默返回（避免日志噪音）
        return;
      }
      if (!canvas || !ctx) {
        log('WARN', 'render: canvas or ctx not ready');
        return;
      }
      if (!video || video.readyState < 2) {
        // 视频未就绪，清空 canvas 避免残留
        try {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        } catch (e) {}
        return;
      }

      // 仅在交互态下记录 RENDER 日志（避免播放时 timeupdate 触发刷屏）
      if (interactionState.mode !== 'idle') {
        log('RENDER', 'mode=' + interactionState.mode + ' frame=' + (getAnnotate() && getAnnotate().state ? getAnnotate().state.currentFrame : '?'));
      }
      if (previewMode) {
        // 预览模式下记录一次（便于调试）
        log('PREVIEW', 'render in preview mode, frame=' + (getAnnotate() && getAnnotate().state ? getAnnotate().state.currentFrame : '?'));
      }

      // 如果 video 尺寸已变化，先同步
      var vw = video.videoWidth || 0;
      var vh = video.videoHeight || 0;
      if ((vw > 0 && vw !== videoOriginalWidth) || (vh > 0 && vh !== videoOriginalHeight)) {
        resizeCanvas();
      }
      // 如果显示尺寸变化（例如布局调整），也同步
      var cw = video.clientWidth || 0;
      var ch = video.clientHeight || 0;
      if (cw > 0 && ch > 0 && (cw !== canvasDisplayWidth || ch !== canvasDisplayHeight)) {
        resizeCanvas();
      }

      // 清空 canvas（注意：不需要绘制视频帧本身，视频在 canvas 下层显示）
      try {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch (e) {
        log('ERROR', 'render: clearRect failed: ' + (e.message || e));
        return;
      }

      // 绘制所有标注
      drawAnnotations();

      // 绘制交互辅助（如正在拖拽的矩形）— 预览模式下不绘制（避免干扰）
      if (!previewMode) {
        drawInteraction();
      }
    } catch (e) {
      log('ERROR', 'render failed: ' + (e.message || e));
    }
  }

  // ===== 绘制所有标注 =====
  // 根据 activeTab 调用对应的绘制钩子（阶段 4-7 注册）
  // 阶段 9：previewMode = true 时，根据 previewVisibleFlags 调用所有勾选的绘制函数
  function drawAnnotations() {
    try {
      var A = getAnnotate();
      if (!A || !A.state) {
        return;
      }
      var tab = A.state.activeTab;
      var self = window.AIX_ANNOTATE_CANVAS;
      if (!self) return;

      if (previewMode) {
        // ===== 预览模式：根据 4 个开关调用对应绘制函数（叠加显示所有标注） =====
        log('PREVIEW', 'drawAnnotations: flags=' +
          (previewVisibleFlags.hand ? 'H' : '-') +
          (previewVisibleFlags.keypoints ? 'K' : '-') +
          (previewVisibleFlags.action ? 'A' : '-') +
          (previewVisibleFlags.handObject ? 'O' : '-'));

        if (previewVisibleFlags.hand && typeof self.drawHandDetection === 'function') {
          try {
            self.drawHandDetection(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawHandDetection (preview) hook failed: ' + (e.message || e));
          }
        }
        if (previewVisibleFlags.keypoints && typeof self.drawHandKeypoints === 'function') {
          try {
            self.drawHandKeypoints(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawHandKeypoints (preview) hook failed: ' + (e.message || e));
          }
        }
        if (previewVisibleFlags.action && typeof self.drawActionSegmentation === 'function') {
          try {
            self.drawActionSegmentation(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawActionSegmentation (preview) hook failed: ' + (e.message || e));
          }
        }
        if (previewVisibleFlags.handObject && typeof self.drawHandObject === 'function') {
          try {
            self.drawHandObject(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawHandObject (preview) hook failed: ' + (e.message || e));
          }
        }
        return;
      }

      // ===== 正常模式：只画当前 Tab =====
      if (tab === 'hand_detection') {
        if (typeof self.drawHandDetection === 'function') {
          try {
            self.drawHandDetection(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawHandDetection hook failed: ' + (e.message || e));
          }
        }
      } else if (tab === 'keypoints') {
        if (typeof self.drawHandKeypoints === 'function') {
          try {
            self.drawHandKeypoints(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawHandKeypoints hook failed: ' + (e.message || e));
          }
        }
      } else if (tab === 'action') {
        if (typeof self.drawActionSegmentation === 'function') {
          try {
            self.drawActionSegmentation(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawActionSegmentation hook failed: ' + (e.message || e));
          }
        }
      } else if (tab === 'hand_object') {
        if (typeof self.drawHandObject === 'function') {
          try {
            self.drawHandObject(ctx, A.state);
          } catch (e) {
            log('ERROR', 'drawHandObject hook failed: ' + (e.message || e));
          }
        }
      } else {
        log('WARN', 'drawAnnotations: unknown activeTab=' + tab);
      }
    } catch (e) {
      log('ERROR', 'drawAnnotations failed: ' + (e.message || e));
    }
  }

  // ===== 绘制交互辅助（正在拖拽的矩形、调整点等） =====
  function drawInteraction() {
    try {
      // 正在绘制矩形：实时显示半透明矩形
      if (interactionState.mode === 'drawing' && interactionState.drawingRect) {
        var r = interactionState.drawingRect;
        // 校正 w/h 可能为负（拖拽方向反向）
        var x = r[2] < 0 ? r[0] + r[2] : r[0];
        var y = r[3] < 0 ? r[1] + r[3] : r[1];
        var w = Math.abs(r[2]);
        var h = Math.abs(r[3]);
        drawRect([x, y, w, h], {
          color: '#00E5FF',
          lineWidth: 2,
          dash: [6, 4],
          fill: 'rgba(0, 229, 255, 0.15)'
        });
      }
      // moving / resizing 模式下，具体绘制由各 tab 的绘制函数负责（选中态高亮）
      // 此处仅作占位，阶段 4-7 实现选中高亮逻辑
    } catch (e) {
      log('ERROR', 'drawInteraction failed: ' + (e.message || e));
    }
  }

  // ===== 屏幕坐标 -> 视频原始坐标 =====
  // 输入：屏幕坐标（鼠标 clientX/Y）
  // 输出：{x, y} 视频原始坐标
  function screenToVideoCoords(sx, sy) {
    try {
      if (!canvas) {
        return { x: 0, y: 0 };
      }
      var rect = canvas.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { x: 0, y: 0 };
      }
      var cx = sx - rect.left;  // canvas 显示坐标（CSS 像素，已含 transform 偏移）
      var cy = sy - rect.top;
      // 除以 scale*zoomLevel 得到视频原始坐标
      // getBoundingClientRect 返回 transform 后的尺寸，rect.width = displayWidth * zoomLevel
      var s = (scale > 0 && zoomLevel > 0) ? (scale * zoomLevel) : 1;
      var vx = cx / s;
      var vy = cy / s;
      // 边界裁剪（避免拖到 canvas 外产生异常坐标）
      if (vx < 0) vx = 0;
      if (vy < 0) vy = 0;
      if (videoOriginalWidth > 0 && vx > videoOriginalWidth) vx = videoOriginalWidth;
      if (videoOriginalHeight > 0 && vy > videoOriginalHeight) vy = videoOriginalHeight;
      return { x: vx, y: vy };
    } catch (e) {
      log('ERROR', 'screenToVideoCoords failed: ' + (e.message || e));
      return { x: 0, y: 0 };
    }
  }

  // ===== 应用缩放/平移变换到 video 和 canvas =====
  // transform-origin: 0 0（video 和 canvas 必须一致，否则缩放后不对齐）
  var _zoomDisplayEl = null;  // 缓存 DOM 引用避免重复查找
  function applyTransform() {
    try {
      var tf = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoomLevel + ')';
      if (video) video.style.transform = tf;
      if (canvas) canvas.style.transform = tf;
      // 更新缩放百分比显示（缓存引用）
      if (!_zoomDisplayEl) _zoomDisplayEl = document.getElementById('annotateZoomLevel');
      if (_zoomDisplayEl) {
        _zoomDisplayEl.textContent = Math.round(zoomLevel * 100) + '%';
      }
    } catch (e) {
      log('ERROR', 'applyTransform failed: ' + (e.message || e));
    }
  }

  // ===== 重置缩放和平移 =====
  function resetZoom() {
    try {
      zoomLevel = 1;
      panX = 0;
      panY = 0;
      applyTransform();
      log('ZOOM', 'reset to 100%');
    } catch (e) {
      log('ERROR', 'resetZoom failed: ' + (e.message || e));
    }
  }

  // ===== 视频原始坐标 -> canvas 绘图坐标 =====
  // 注意：canvas.width = video.videoWidth，所以 canvas 绘图坐标 = 视频坐标（1:1）
  function videoToCanvasCoords(vx, vy) {
    try {
      return { x: vx, y: vy };
    } catch (e) {
      log('ERROR', 'videoToCanvasCoords failed: ' + (e.message || e));
      return { x: 0, y: 0 };
    }
  }

  // ===== 基础绘图：矩形 =====
  // bbox = [x, y, w, h] 视频坐标
  // options: { color, lineWidth, dash, fill }
  function drawRect(bbox, options) {
    try {
      if (!ctx || !bbox || bbox.length < 4) return;
      options = options || {};
      var x = bbox[0], y = bbox[1], w = bbox[2], h = bbox[3];

      ctx.save();
      try {
        if (options.fill) {
          ctx.fillStyle = options.fill;
          ctx.fillRect(x, y, w, h);
        }
        if (options.color) {
          ctx.strokeStyle = options.color;
        } else {
          ctx.strokeStyle = '#00E5FF';
        }
        ctx.lineWidth = options.lineWidth || 2;
        if (options.dash && options.dash.length > 0) {
          ctx.setLineDash(options.dash);
        } else {
          ctx.setLineDash([]);
        }
        ctx.strokeRect(x, y, w, h);
      } finally {
        ctx.restore();
      }
    } catch (e) {
      log('ERROR', 'drawRect failed: ' + (e.message || e));
    }
  }

  // ===== 基础绘图：圆 =====
  function drawCircle(x, y, radius, options) {
    try {
      if (!ctx) return;
      options = options || {};
      var r = Math.max(0, radius || 0);
      ctx.save();
      try {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        if (options.fill) {
          ctx.fillStyle = options.fill;
          ctx.fill();
        }
        ctx.strokeStyle = options.color || '#00E5FF';
        ctx.lineWidth = options.lineWidth || 2;
        if (options.dash && options.dash.length > 0) {
          ctx.setLineDash(options.dash);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
      } finally {
        ctx.restore();
      }
    } catch (e) {
      log('ERROR', 'drawCircle failed: ' + (e.message || e));
    }
  }

  // ===== 基础绘图：直线 =====
  function drawLine(x1, y1, x2, y2, options) {
    try {
      if (!ctx) return;
      options = options || {};
      ctx.save();
      try {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = options.color || '#00E5FF';
        ctx.lineWidth = options.lineWidth || 2;
        if (options.dash && options.dash.length > 0) {
          ctx.setLineDash(options.dash);
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
      } finally {
        ctx.restore();
      }
    } catch (e) {
      log('ERROR', 'drawLine failed: ' + (e.message || e));
    }
  }

  // ===== 基础绘图：文字 =====
  function drawText(text, x, y, options) {
    try {
      if (!ctx) return;
      options = options || {};
      ctx.save();
      try {
        ctx.font = options.font || '14px Inter, sans-serif';
        ctx.textAlign = options.align || 'left';
        ctx.textBaseline = options.baseline || 'top';
        if (options.background) {
          // 绘制背景矩形
          var metrics = ctx.measureText(text || '');
          var padX = options.padX != null ? options.padX : 4;
          var padY = options.padY != null ? options.padY : 2;
          var tw = metrics.width;
          var th = parseInt(ctx.font, 10) || 14;
          var bgX = x;
          if (options.align === 'center') bgX = x - tw / 2;
          else if (options.align === 'right') bgX = x - tw;
          ctx.fillStyle = options.background;
          ctx.fillRect(bgX - padX, y - padY, tw + padX * 2, th + padY * 2);
        }
        ctx.fillStyle = options.color || '#FFFFFF';
        ctx.fillText(text || '', x, y);
      } finally {
        ctx.restore();
      }
    } catch (e) {
      log('ERROR', 'drawText failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // Task 3.2：鼠标交互基础
  // ============================================================

  // ===== 绑定鼠标事件 =====
  function bindMouseEvents() {
    try {
      if (!canvas) {
        log('ERROR', 'bindMouseEvents: canvas not ready');
        return;
      }

      // mousedown：根据点中位置和 activeTab 决定模式
      canvas.addEventListener('mousedown', function (e) {
        try {
          if (!isInitialized) return;
          // 中键（button 1）：进入平移模式（缩放后拖拽画布）
          if (e.button === 1) {
            e.preventDefault();
            interactionState.mode = 'panning';
            interactionState.startX = e.clientX;
            interactionState.startY = e.clientY;
            canvas.style.cursor = 'grabbing';
            _attachWindowMouseListeners();  // 绑定 window 监听，鼠标移出 canvas 也能继续
            log('ZOOM', 'panning start at (' + e.clientX + ',' + e.clientY + ')');
            return;
          }
          // 仅响应左键
          if (e.button !== 0) return;
          // 阶段 9：预览模式下不响应鼠标事件（避免误触发标注）
          if (previewMode) return;
          var A = getAnnotate();
          if (!A || !A.state) return;
          // 仅在标注步骤（步骤 3）启用绘制
          if (A.state.currentStep !== 3) return;

          var tab = A.state.activeTab;
          // action tab：不响应 canvas 鼠标事件（用时间轴操作）
          if (tab === 'action') return;

          var coords = screenToVideoCoords(e.clientX, e.clientY);
          interactionState.startX = coords.x;
          interactionState.startY = coords.y;
          interactionState.currentX = coords.x;
          interactionState.currentY = coords.y;
          // 清空单关键点拖拽索引（每次按下重新计算）
          interactionState._movingKeypointIndex = null;
          // 阶段 7：清空命中类型（每次按下重新计算）
          interactionState._hitType = null;

          log('MOUSE', 'down at video(' + coords.x.toFixed(1) + ', ' + coords.y.toFixed(1) + ') tab=' + tab);

          // 绑定 window 级 mousemove/mouseup，确保鼠标移出 canvas（如黑边区域）也能继续操作
          _attachWindowMouseListeners();

          // keypoints 模式：点击添加关键点 或 命中已有 keypoint 进入 moving
          if (tab === 'keypoints') {
            // 1. 命中测试已有 keypoint
            var hitId = hitTestAnnotation(coords.x, coords.y);
            if (hitId !== null) {
              interactionState.mode = 'moving';
              interactionState.selectedId = hitId;
              setSelectedId(hitId);
              log('MOUSE', 'keypoints mode=moving selectedId=' + hitId + ' kpIdx=' + interactionState._movingKeypointIndex);
              render();
              return;
            }
            // 2. 未命中：触发 onKeypointClick 回调（由 annotate.js 处理添加关键点逻辑）
            interactionState.selectedId = null;
            setSelectedId(null);
            if (typeof window.AIX_ANNOTATE_CANVAS.onKeypointClick === 'function') {
              try {
                log('KEYPOINT', 'onKeypointClick video(' + coords.x.toFixed(1) + ', ' + coords.y.toFixed(1) + ')');
                window.AIX_ANNOTATE_CANVAS.onKeypointClick(coords.x, coords.y);
              } catch (err) {
                log('ERROR', 'onKeypointClick callback failed: ' + (err.message || err));
              }
            } else {
              log('WARN', 'onKeypointClick hook not registered (stage 5 will register)');
            }
            return;
          }

          // hand_detection / hand_object 模式：原有画框 / 移动 / 调整逻辑
          // 1. 检查是否点中选中标注的调整点
          var handle = checkResizeHandleAt(coords.x, coords.y);
          if (handle) {
            interactionState.mode = 'resizing';
            interactionState.resizeHandle = handle;
            log('MOUSE', 'mode=resizing handle=' + handle);
            return;
          }

          // 2. 检查是否点中某个标注（命中测试）
          var hitId2 = hitTestAnnotation(coords.x, coords.y);
          if (hitId2 !== null) {
            interactionState.mode = 'moving';
            interactionState.selectedId = hitId2;
            // 同步到 AIX_ANNOTATE.state.selectedIds
            setSelectedId(hitId2);
            log('MOUSE', 'mode=moving selectedId=' + hitId2);
            render();
            return;
          }

          // 3. 否则进入绘制模式
          interactionState.mode = 'drawing';
          interactionState.drawingRect = [coords.x, coords.y, 0, 0];
          interactionState.selectedId = null;
          // 清空选中
          setSelectedId(null);
          log('MOUSE', 'mode=drawing start');
        } catch (err) {
          log('ERROR', 'mousedown handler failed: ' + (err.message || err));
        }
      });

      // mousemove/mouseup 处理函数（提取为命名函数，便于在 window 上绑定/解绑）
      // 绑定到 window 而非 canvas，确保鼠标移出 canvas（如黑边区域）也能继续操作
      var _moveRafPending = false;
      function _handleMouseMove(e) {
        try {
          if (!isInitialized) return;
          if (interactionState.mode === 'idle') return;

          // 平移模式：更新 panX/panY（rAF 节流避免高频重排掉帧）
          if (interactionState.mode === 'panning') {
            var pdx = e.clientX - interactionState.startX;
            var pdy = e.clientY - interactionState.startY;
            panX += pdx;
            panY += pdy;
            interactionState.startX = e.clientX;
            interactionState.startY = e.clientY;
            if (!_moveRafPending) {
              _moveRafPending = true;
              requestAnimationFrame(function () {
                _moveRafPending = false;
                try { applyTransform(); } catch (e) { log('ERROR', 'rAF applyTransform failed: ' + (e.message || e)); }
              });
            }
            return;
          }

          var coords = screenToVideoCoords(e.clientX, e.clientY);
          interactionState.currentX = coords.x;
          interactionState.currentY = coords.y;

          if (interactionState.mode === 'drawing') {
            if (interactionState.drawingRect) {
              var sx = interactionState.startX;
              var sy = interactionState.startY;
              interactionState.drawingRect = [sx, sy, coords.x - sx, coords.y - sy];
            }
          } else if (interactionState.mode === 'moving') {
            // 移动选中的标注：dx, dy 增量应用到标注位置
            var dx = coords.x - interactionState.startX;
            var dy = coords.y - interactionState.startY;
            applyMoveToSelected(dx, dy);
            // 更新起点，使移动是连续的相对位移
            interactionState.startX = coords.x;
            interactionState.startY = coords.y;
          } else if (interactionState.mode === 'resizing') {
            // 调整尺寸：将当前鼠标位置作为新的角/边位置
            applyResizeToSelected(coords.x, coords.y, interactionState.resizeHandle);
          }

          // rAF 节流：一帧内只重绘一次
          if (!_moveRafPending) {
            _moveRafPending = true;
            requestAnimationFrame(function () {
              _moveRafPending = false;
              try { render(); } catch (e) { log('ERROR', 'rAF render failed: ' + (e.message || e)); }
            });
          }
        } catch (err) {
          log('ERROR', 'mousemove handler failed: ' + (err.message || err));
        }
      }

      function _handleMouseUp(e) {
        try {
          if (!isInitialized) return;
          // 平移模式结束
          if (interactionState.mode === 'panning') {
            interactionState.mode = 'idle';
            canvas.style.cursor = 'crosshair';
            log('ZOOM', 'panning end');
            _detachWindowMouseListeners();
            return;
          }
          log('MOUSE', 'up mode=' + interactionState.mode);
          finishMouseAction();
          _detachWindowMouseListeners();
        } catch (err) {
          log('ERROR', 'mouseup handler failed: ' + (err.message || err));
          _detachWindowMouseListeners();
        }
      }

      // window 级监听绑定/解绑（mousedown 时绑定，mouseup 时解绑）
      // 使用 capture 阶段确保优先于其他监听
      function _attachWindowMouseListeners() {
        window.addEventListener('mousemove', _handleMouseMove, true);
        window.addEventListener('mouseup', _handleMouseUp, true);
      }
      function _detachWindowMouseListeners() {
        window.removeEventListener('mousemove', _handleMouseMove, true);
        window.removeEventListener('mouseup', _handleMouseUp, true);
      }

      // canvas 仍保留 mousemove/mouseup（用于非操作状态的 hover 等，idle 模式直接 return）
      canvas.addEventListener('mousemove', _handleMouseMove);
      canvas.addEventListener('mouseup', _handleMouseUp);

      // mouseleave：不再中断操作（window mouseup 会负责结束）
      canvas.addEventListener('mouseleave', function (e) {
        try {
          if (!isInitialized) return;
          // 不再因 mouseleave 中断拉框/移动/调整操作
          // 鼠标移出 canvas（如黑边区域）时，window 级 mousemove/mouseup 继续工作
        } catch (err) {
          log('ERROR', 'mouseleave handler failed: ' + (err.message || err));
        }
      });

      // 滚轮缩放：以鼠标位置为中心缩放
      canvas.addEventListener('wheel', function (e) {
        try {
          if (!isInitialized) return;
          // 仅在标注步骤（步骤 3）启用缩放
          var A = getAnnotate();
          if (!A || !A.state || A.state.currentStep !== 3) return;
          e.preventDefault();
          // 缩放因子：滚轮向上放大，向下缩小
          var delta = e.deltaY > 0 ? 0.9 : 1.1;
          var newZoom = zoomLevel * delta;
          // 限制缩放范围：10% ~ 1000%
          if (newZoom < 0.1) newZoom = 0.1;
          if (newZoom > 10) newZoom = 10;
          if (Math.abs(newZoom - zoomLevel) < 0.001) return;

          // 以鼠标位置为中心缩放：
          // 保持鼠标位置在视频坐标上不变
          // 缩放前：鼠标在 canvas 显示坐标 = e.clientX - rect.left
          // 缩放后：该显示坐标对应的视频坐标应不变
          // => panX 需要调整以保持中心点
          var rect = canvas.getBoundingClientRect();
          var mouseDispX = e.clientX - rect.left;  // 相对 transform 后左上角
          var mouseDispY = e.clientY - rect.top;
          // 鼠标在视频坐标中的位置（缩放前）
          var sOld = (scale > 0 && zoomLevel > 0) ? (scale * zoomLevel) : 1;
          var videoX = mouseDispX / sOld;
          var videoY = mouseDispY / sOld;

          zoomLevel = newZoom;

          // 缩放后，要让视频坐标 (videoX, videoY) 仍然出现在鼠标位置
          // 新的显示坐标 = videoX * scale * zoomLevel
          // panX 调整 = mouseDispX - videoX * scale * zoomLevel ... 但 panX 是相对原位的偏移
          // 实际：rect.left = offX + panX（offX 是 resizeCanvas 设的 style.left）
          // mouseDispX = e.clientX - rect.left = e.clientX - offX - panX
          // 缩放后期望：mouseDispX_new = videoX * scale * newZoom
          // mouseDispX_new = e.clientX - offX - panX_new
          // => panX_new = e.clientX - offX - videoX * scale * newZoom
          // => panX_new = (e.clientX - offX) - videoX * scale * newZoom
          //   其中 (e.clientX - offX) = mouseDispX + panX（旧）
          // 所以：panX_new = mouseDispX + panX_old - videoX * scale * newZoom
          var sNew = (scale > 0 && zoomLevel > 0) ? (scale * zoomLevel) : 1;
          panX = (mouseDispX + panX) - videoX * sNew;
          panY = (mouseDispY + panY) - videoY * sNew;

          applyTransform();
          log('ZOOM', 'wheel zoom=' + zoomLevel.toFixed(3) + ' pan=(' + panX.toFixed(0) + ',' + panY.toFixed(0) + ')');
        } catch (err) {
          log('ERROR', 'wheel handler failed: ' + (err.message || err));
        }
      }, { passive: false });

      // 双击重置缩放
      canvas.addEventListener('dblclick', function (e) {
        try {
          if (!isInitialized) return;
          var A = getAnnotate();
          if (!A || !A.state || A.state.currentStep !== 3) return;
          e.preventDefault();
          resetZoom();
        } catch (err) {
          log('ERROR', 'dblclick handler failed: ' + (err.message || err));
        }
      });

      // 阻止 canvas 上的右键菜单（避免干扰，但保留默认）
      canvas.addEventListener('contextmenu', function (e) {
        try {
          // 不阻止默认行为，让阶段 4-7 自行决定是否需要右键菜单
        } catch (err) {
          log('ERROR', 'contextmenu handler failed: ' + (err.message || err));
        }
      });

      log('INIT', 'Mouse events bound (mousedown/mousemove/mouseup/mouseleave/wheel/dblclick)');
    } catch (e) {
      log('ERROR', 'bindMouseEvents failed: ' + (e.message || e));
    }
  }

  // ===== 按倍数缩放（以画布中心为中心） =====
  // factor > 1 放大，< 1 缩小
  function zoomBy(factor) {
    try {
      var newZoom = zoomLevel * factor;
      if (newZoom < 0.1) newZoom = 0.1;
      if (newZoom > 10) newZoom = 10;
      if (Math.abs(newZoom - zoomLevel) < 0.001) return;

      // 以画布显示区域中心为缩放中心
      var rect = canvas.getBoundingClientRect();
      var centerX = rect.width / 2;
      var centerY = rect.height / 2;
      var sOld = (scale > 0 && zoomLevel > 0) ? (scale * zoomLevel) : 1;
      var videoX = centerX / sOld;
      var videoY = centerY / sOld;

      zoomLevel = newZoom;
      var sNew = (scale > 0 && zoomLevel > 0) ? (scale * zoomLevel) : 1;
      panX = (centerX + panX) - videoX * sNew;
      panY = (centerY + panY) - videoY * sNew;
      applyTransform();
      log('ZOOM', 'zoomBy factor=' + factor + ' zoom=' + zoomLevel.toFixed(3));
    } catch (e) {
      log('ERROR', 'zoomBy failed: ' + (e.message || e));
    }
  }

  // ===== 绑定缩放控件按钮事件 =====
  function bindZoomControls() {
    try {
      var btnIn = document.getElementById('annotateZoomIn');
      var btnOut = document.getElementById('annotateZoomOut');
      var btnReset = document.getElementById('annotateZoomReset');
      if (btnIn) {
        btnIn.addEventListener('click', function () { zoomBy(1.2); });
      }
      if (btnOut) {
        btnOut.addEventListener('click', function () { zoomBy(1 / 1.2); });
      }
      if (btnReset) {
        btnReset.addEventListener('click', function () { resetZoom(); });
      }
      log('INIT', 'Zoom controls bound');
    } catch (e) {
      log('ERROR', 'bindZoomControls failed: ' + (e.message || e));
    }
  }

  // ===== 完成鼠标操作 =====
  function finishMouseAction() {
    try {
      var A = getAnnotate();
      var mode = interactionState.mode;

      if (mode === 'drawing') {
        // 完成绘制：校验矩形有效性（面积 > 阈值）
        var r = interactionState.drawingRect;
        if (r && r.length >= 4) {
          // 标准化（处理负 w/h）
          var x = r[2] < 0 ? r[0] + r[2] : r[0];
          var y = r[3] < 0 ? r[1] + r[3] : r[1];
          var w = Math.abs(r[2]);
          var h = Math.abs(r[3]);
          // 最小尺寸阈值（视频坐标 5 像素），避免误点击
          if (w >= 5 && h >= 5) {
            var finalRect = [x, y, w, h];
            log('MOUSE', 'draw complete rect=[' + x.toFixed(1) + ',' + y.toFixed(1) + ',' + w.toFixed(1) + ',' + h.toFixed(1) + ']');
            // 调用 onDrawComplete 回调（阶段 4-7 注册）
            if (A && typeof A.pushHistory === 'function') {
              try {
                A.pushHistory(A.state);
              } catch (e) {
                log('ERROR', 'pushHistory on draw failed: ' + (e.message || e));
              }
            }
            if (typeof window.AIX_ANNOTATE_CANVAS.onDrawComplete === 'function') {
              try {
                window.AIX_ANNOTATE_CANVAS.onDrawComplete(finalRect, A ? A.state.activeTab : null);
              } catch (e) {
                log('ERROR', 'onDrawComplete callback failed: ' + (e.message || e));
              }
            } else {
              log('MOUSE', 'onDrawComplete hook not registered (stage 4-7 will register)');
            }
          } else {
            log('MOUSE', 'draw rect too small (' + w + 'x' + h + '), discarded');
          }
        }
      } else if (mode === 'moving' || mode === 'resizing') {
        // 完成移动/调整：保存到 localStorage
        log('MOUSE', mode + ' complete, saving to localStorage');
        if (A && typeof A.saveToLocalStorage === 'function') {
          try {
            A.saveToLocalStorage();
          } catch (e) {
            log('ERROR', 'saveToLocalStorage after ' + mode + ' failed: ' + (e.message || e));
          }
        }
        // 触发标注编辑回调（用于 hand_detection 重新计算插值等）
        if (A && typeof A.onAnnotationEdited === 'function') {
          try {
            A.onAnnotationEdited(A.state.activeTab);
          } catch (e) {
            log('ERROR', 'onAnnotationEdited callback failed: ' + (e.message || e));
          }
        }
        // 刷新右侧面板
        if (A && typeof A.renderPanel === 'function') {
          try {
            A.renderPanel();
          } catch (e) {
            log('ERROR', 'renderPanel after ' + mode + ' failed: ' + (e.message || e));
          }
        }
      }

      // 重置状态
      interactionState.mode = 'idle';
      interactionState.drawingRect = null;
      interactionState.resizeHandle = null;
      // 清空单关键点拖拽索引
      interactionState._movingKeypointIndex = null;
      // 阶段 7：清空命中类型（保留到 setSelectedId 之后已生效，这里清空避免残留）
      interactionState._hitType = null;
      // 保留 selectedId（选中态由用户点击空白处或 Esc 清除）

      render();
    } catch (e) {
      log('ERROR', 'finishMouseAction failed: ' + (e.message || e));
    }
  }

  // ===== 命中测试：检查点是否在选中标注的调整点上 =====
  function checkResizeHandleAt(x, y) {
    try {
      var A = getAnnotate();
      if (!A || !A.state) return null;
      var selectedBBox = getSelectedBBox();
      if (!selectedBBox) return null;
      return getResizeHandle(x, y, selectedBBox);
    } catch (e) {
      log('ERROR', 'checkResizeHandleAt failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 命中测试：检查点是否在某个标注内 =====
  // 辅助：按 ID 查找手部框/物体框的 bbox（限定帧）
  // type: 'hand' -> state.annotations.hand_detection；'object' -> state.annotations.objects
  function findBBoxById(id, frame, type) {
    try {
      var A = getAnnotate();
      if (!A || !A.state) return null;
      var list;
      if (type === 'hand') list = A.state.annotations.hand_detection || [];
      else if (type === 'object') list = A.state.annotations.objects || [];
      else return null;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it && it.id === id && it.frame_idx === frame && it.bbox && it.bbox.length >= 4) {
          return it.bbox;
        }
      }
      return null;
    } catch (e) {
      log('ERROR', 'findBBoxById failed: ' + (e.message || e));
      return null;
    }
  }

  function hitTestAnnotation(x, y) {
    try {
      var A = getAnnotate();
      if (!A || !A.state) return null;
      var tab = A.state.activeTab;
      var ann = A.state.annotations;
      var frame = A.state.currentFrame;
      var i, item, bbox;

      if (tab === 'hand_detection') {
        // hand_detection: [{id, frame_idx, bbox:[x,y,w,h], hand, occlusion, interpolated, ...}]
        var handList = ann.hand_detection || [];
        for (i = handList.length - 1; i >= 0; i--) {
          item = handList[i];
          if (!item || item.frame_idx !== frame) continue;
          bbox = item.bbox;
          if (bbox && isPointInBBox(x, y, bbox)) return item.id;
        }
      } else if (tab === 'keypoints') {
        // keypoints: 关键点用圆命中测试
        // 数据结构（阶段 5）：{id, frame_idx, hand, hand_detection_id, keypoints: [[x,y,v],...21], source}
        var kpList = ann.hand_keypoints || [];
        var hitRadius = 10 / (scale > 0 ? scale : 1);  // 10 像素（屏幕）转为视频坐标
        for (i = kpList.length - 1; i >= 0; i--) {
          item = kpList[i];
          if (!item || item.frame_idx !== frame) continue;
          if (item.keypoints && item.keypoints.length > 0) {
            for (var p = 0; p < item.keypoints.length; p++) {
              var kp = item.keypoints[p];
              if (!kp || kp.length < 2) continue;
              if (isPointInCircle(x, y, kp[0], kp[1], hitRadius)) {
                // 命中时记录被拖拽的关键点索引到 interactionState（供 applyMoveToSelected 使用）
                interactionState._movingKeypointIndex = p;
                return item.id;
              }
            }
          }
        }
      } else if (tab === 'hand_object') {
        // 阶段 7 新 schema：
        //   state.annotations.objects: [{id, frame_idx, name, bbox:[x,y,w,h], color}]
        //   state.annotations.hand_object: [{id, frame_idx, hand_bbox_id, object_bbox_id, relation, critical_frame}]
        // 优先命中物体框（可移动/调整），其次命中关系连线中点（仅用于选中/删除）
        var objList = ann.objects || [];
        for (i = objList.length - 1; i >= 0; i--) {
          item = objList[i];
          if (!item || item.frame_idx !== frame) continue;
          bbox = item.bbox;
          if (bbox && isPointInBBox(x, y, bbox)) {
            interactionState._hitType = 'object';
            return item.id;
          }
        }
        // 关系连线中点命中（半径 12 像素屏幕 -> 视频坐标）
        var relList = ann.hand_object || [];
        var relHitRadius = 12 / (scale > 0 ? scale : 1);
        for (i = relList.length - 1; i >= 0; i--) {
          item = relList[i];
          if (!item || item.frame_idx !== frame) continue;
          var handBox = findBBoxById(item.hand_bbox_id, frame, 'hand');
          var objBox2 = findBBoxById(item.object_bbox_id, frame, 'object');
          if (!handBox || !objBox2) continue;
          var mx = (handBox[0] + handBox[2] / 2 + objBox2[0] + objBox2[2] / 2) / 2;
          var my = (handBox[1] + handBox[3] / 2 + objBox2[1] + objBox2[3] / 2) / 2;
          if (Math.abs(x - mx) <= relHitRadius && Math.abs(y - my) <= relHitRadius) {
            interactionState._hitType = 'relation';
            return item.id;
          }
        }
      } else if (tab === 'action') {
        // 动作分割是时间段，不是空间区域，不在 canvas 上命中
        return null;
      }
      return null;
    } catch (e) {
      log('ERROR', 'hitTestAnnotation failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 获取当前选中标注的 bbox（用于调整点命中测试） =====
  function getSelectedBBox() {
    try {
      var A = getAnnotate();
      if (!A || !A.state) return null;
      var tab = A.state.activeTab;
      var ann = A.state.annotations;
      var sel = A.state.selectedIds;
      var frame = A.state.currentFrame;
      var i, item, id;

      if (tab === 'hand_detection') {
        id = sel.hand;
        if (id === null) return null;
        var handList = ann.hand_detection || [];
        for (i = 0; i < handList.length; i++) {
          item = handList[i];
          if (item && item.id === id && item.frame_idx === frame) {
            return item.bbox;
          }
        }
      } else if (tab === 'hand_object') {
        // 阶段 7：优先返回物体框 bbox（用于移动/调整尺寸），
        // 关系没有自身 bbox（仅引用 ID），返回 null（不支持 resize）
        id = sel.object;
        if (id !== null) {
          var objListSel = ann.objects || [];
          for (i = 0; i < objListSel.length; i++) {
            item = objListSel[i];
            if (item && item.id === id && item.frame_idx === frame) {
              return item.bbox;
            }
          }
        }
        return null;
      }
      // keypoints / action 暂不支持调整点（阶段 5/6 实现）
      return null;
    } catch (e) {
      log('ERROR', 'getSelectedBBox failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 设置当前选中 ID（同步到 AIX_ANNOTATE.state.selectedIds） =====
  function setSelectedId(id) {
    try {
      var A = getAnnotate();
      if (!A || !A.state) return;
      var tab = A.state.activeTab;
      if (tab === 'hand_detection') A.state.selectedIds.hand = id;
      else if (tab === 'keypoints') A.state.selectedIds.keypoint = id;
      else if (tab === 'action') A.state.selectedIds.segment = id;
      else if (tab === 'hand_object') {
        // 阶段 7：根据命中类型分别设置 object / relation
        // 传 null 时清空两个选中
        if (id === null) {
          A.state.selectedIds.object = null;
          A.state.selectedIds.relation = null;
        } else if (interactionState._hitType === 'object') {
          A.state.selectedIds.object = id;
          A.state.selectedIds.relation = null;
        } else if (interactionState._hitType === 'relation') {
          A.state.selectedIds.relation = id;
          A.state.selectedIds.object = null;
        } else {
          // 兜底：未知类型时清空两个（避免残留）
          A.state.selectedIds.object = null;
          A.state.selectedIds.relation = null;
        }
      }
      interactionState.selectedId = id;
    } catch (e) {
      log('ERROR', 'setSelectedId failed: ' + (e.message || e));
    }
  }

  // ===== 应用移动增量到选中标注 =====
  function applyMoveToSelected(dx, dy) {
    try {
      if (!dx && !dy) return;
      var A = getAnnotate();
      if (!A || !A.state) return;
      var tab = A.state.activeTab;
      var ann = A.state.annotations;
      var frame = A.state.currentFrame;
      var id = interactionState.selectedId;
      if (id === null) return;
      var i, item;

      if (tab === 'hand_detection') {
        var handList = ann.hand_detection || [];
        for (i = 0; i < handList.length; i++) {
          item = handList[i];
          if (item && item.id === id && item.frame_idx === frame) {
            if (item.bbox && item.bbox.length >= 4) {
              item.bbox[0] += dx;
              item.bbox[1] += dy;
              // 编辑后，插值标注改为手动
              if (item.interpolated === true) {
                item.interpolated = false;
                log('HAND', 'interpolated annotation edited -> interpolated=false, id=' + id);
              }
            }
            return;
          }
        }
      } else if (tab === 'hand_object') {
        // 阶段 7：仅支持移动物体框（关系无自身 bbox）
        var objListMove = ann.objects || [];
        for (i = 0; i < objListMove.length; i++) {
          item = objListMove[i];
          if (item && item.id === id && item.frame_idx === frame) {
            if (item.bbox && item.bbox.length >= 4) {
              item.bbox[0] += dx;
              item.bbox[1] += dy;
              log('HAND_OBJECT', 'moving object id=' + id + ' dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1));
            }
            return;
          }
        }
      } else if (tab === 'keypoints') {
        // 数据结构（阶段 5）：{id, frame_idx, hand, hand_detection_id, keypoints: [[x,y,v],...21], source}
        var kpList = ann.hand_keypoints || [];
        for (i = 0; i < kpList.length; i++) {
          item = kpList[i];
          if (item && item.id === id && item.frame_idx === frame) {
            if (item.keypoints && item.keypoints.length > 0) {
              // 若命中时记录了关键点索引，则只移动该关键点（拖拽微调）
              var kpIdx = interactionState._movingKeypointIndex;
              if (kpIdx != null && item.keypoints[kpIdx] && item.keypoints[kpIdx].length >= 2) {
                item.keypoints[kpIdx][0] += dx;
                item.keypoints[kpIdx][1] += dy;
                log('KEYPOINT', 'moving kp[' + kpIdx + '] dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1));
              } else {
                // 否则整体移动所有关键点
                for (var p = 0; p < item.keypoints.length; p++) {
                  if (item.keypoints[p] && item.keypoints[p].length >= 2) {
                    item.keypoints[p][0] += dx;
                    item.keypoints[p][1] += dy;
                  }
                }
              }
            }
            return;
          }
        }
      }
    } catch (e) {
      log('ERROR', 'applyMoveToSelected failed: ' + (e.message || e));
    }
  }

  // ===== 应用调整尺寸到选中标注 =====
  function applyResizeToSelected(x, y, handle) {
    try {
      if (!handle) return;
      var A = getAnnotate();
      if (!A || !A.state) return;
      var tab = A.state.activeTab;
      var ann = A.state.annotations;
      var frame = A.state.currentFrame;
      var id = interactionState.selectedId;
      if (id === null) return;
      var i, item, bbox;

      function resizeBBox(bb) {
        if (!bb || bb.length < 4) return;
        var bx = bb[0], by = bb[1], bw = bb[2], bh = bb[3];
        // 根据调整点更新对应边
        if (handle.indexOf('w') >= 0) {
          var newX = x;
          bw = bx + bw - newX;
          if (bw < 1) { bw = 1; newX = bx + bw - 1; }
          bb[0] = newX;
          bb[2] = bw;
        }
        if (handle.indexOf('n') >= 0) {
          var newY = y;
          bh = by + bh - newY;
          if (bh < 1) { bh = 1; newY = by + bh - 1; }
          bb[1] = newY;
          bb[3] = bh;
        }
        if (handle.indexOf('e') >= 0) {
          bw = x - bx;
          if (bw < 1) bw = 1;
          bb[2] = bw;
        }
        if (handle.indexOf('s') >= 0) {
          bh = y - by;
          if (bh < 1) bh = 1;
          bb[3] = bh;
        }
      }

      if (tab === 'hand_detection') {
        var handList = ann.hand_detection || [];
        for (i = 0; i < handList.length; i++) {
          item = handList[i];
          if (item && item.id === id && item.frame_idx === frame) {
            resizeBBox(item.bbox);
            // 编辑后，插值标注改为手动
            if (item.interpolated === true) {
              item.interpolated = false;
              log('HAND', 'interpolated annotation resized -> interpolated=false, id=' + id);
            }
            return;
          }
        }
      } else if (tab === 'hand_object') {
        // 阶段 7：调整物体框尺寸（关系无 bbox，不支持 resize）
        var objListResize = ann.objects || [];
        for (i = 0; i < objListResize.length; i++) {
          item = objListResize[i];
          if (item && item.id === id && item.frame_idx === frame) {
            if (item.bbox) resizeBBox(item.bbox);
            log('HAND_OBJECT', 'resizing object id=' + id + ' handle=' + handle);
            return;
          }
        }
      }
      // keypoints / action 暂不支持 resize
    } catch (e) {
      log('ERROR', 'applyResizeToSelected failed: ' + (e.message || e));
    }
  }

  // ===== 判断坐标是否在 bbox 的 8 个调整点之一上 =====
  // bbox = [x, y, w, h] 视频坐标
  // 调整点为 8x8 像素（屏幕尺寸），转换为视频坐标判断
  function getResizeHandle(x, y, bbox) {
    try {
      if (!bbox || bbox.length < 4) return null;
      var bx = bbox[0], by = bbox[1], bw = bbox[2], bh = bbox[3];
      if (bw <= 0 || bh <= 0) return null;

      // 调整点屏幕尺寸 8 像素，转换为视频坐标半径
      var s = (scale > 0) ? scale : 1;
      var halfSize = 4 / s;  // 4 = 8/2

      // 8 个调整点的位置（视频坐标）
      var handles = [
        { name: 'nw', x: bx,         y: by         },
        { name: 'n',  x: bx + bw / 2, y: by         },
        { name: 'ne', x: bx + bw,    y: by         },
        { name: 'e',  x: bx + bw,    y: by + bh / 2 },
        { name: 'se', x: bx + bw,    y: by + bh    },
        { name: 's',  x: bx + bw / 2, y: by + bh    },
        { name: 'sw', x: bx,         y: by + bh    },
        { name: 'w',  x: bx,         y: by + bh / 2 }
      ];

      for (var i = 0; i < handles.length; i++) {
        var h = handles[i];
        if (Math.abs(x - h.x) <= halfSize && Math.abs(y - h.y) <= halfSize) {
          return h.name;
        }
      }
      return null;
    } catch (e) {
      log('ERROR', 'getResizeHandle failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 点是否在矩形内 =====
  function isPointInBBox(x, y, bbox) {
    try {
      if (!bbox || bbox.length < 4) return false;
      var bx = bbox[0], by = bbox[1], bw = bbox[2], bh = bbox[3];
      return (x >= bx && x <= bx + bw && y >= by && y <= by + bh);
    } catch (e) {
      log('ERROR', 'isPointInBBox failed: ' + (e.message || e));
      return false;
    }
  }

  // ===== 点是否在圆内 =====
  function isPointInCircle(x, y, cx, cy, r) {
    try {
      var dx = x - cx;
      var dy = y - cy;
      var radius = Math.max(0, r || 0);
      return (dx * dx + dy * dy) <= radius * radius;
    } catch (e) {
      log('ERROR', 'isPointInCircle failed: ' + (e.message || e));
      return false;
    }
  }

  // ============================================================
  // Task 4.1 / 4.5：手部检测绘制钩子
  // ============================================================

  // ===== 绘制 8 个调整点（选中态辅助） =====
  // bbox = [x, y, w, h] 视频坐标
  function drawResizeHandles(bbox) {
    try {
      if (!ctx || !bbox || bbox.length < 4) return;
      var bx = bbox[0], by = bbox[1], bw = bbox[2], bh = bbox[3];
      if (bw <= 0 || bh <= 0) return;

      // 8 个调整点的位置（视频坐标）
      var handles = [
        [bx,         by         ],  // nw
        [bx + bw / 2, by         ],  // n
        [bx + bw,    by         ],  // ne
        [bx + bw,    by + bh / 2 ],  // e
        [bx + bw,    by + bh    ],  // se
        [bx + bw / 2, by + bh    ],  // s
        [bx,         by + bh    ],  // sw
        [bx,         by + bh / 2 ]   // w
      ];

      // 调整点显示尺寸：屏幕 8 像素，转换为视频坐标
      var s = (scale > 0) ? scale : 1;
      var halfSize = 4 / s;
      var fullSize = halfSize * 2;

      for (var i = 0; i < handles.length; i++) {
        var hx = handles[i][0];
        var hy = handles[i][1];
        ctx.save();
        try {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1 / s;  // 保证显示 1px
          ctx.fillRect(hx - halfSize, hy - halfSize, fullSize, fullSize);
          ctx.strokeRect(hx - halfSize, hy - halfSize, fullSize, fullSize);
        } finally {
          ctx.restore();
        }
      }
    } catch (e) {
      log('ERROR', 'drawResizeHandles failed: ' + (e.message || e));
    }
  }

  // ===== 手部检测绘制钩子（drawAnnotations 调用） =====
  // 参数：ctx（2D 上下文）, state（AIX_ANNOTATE.state）
  function drawHandDetection(ictx, istate) {
    try {
      if (!ictx || !istate || !istate.annotations) return;
      var frame = istate.currentFrame;
      var list = (istate.annotations.hand_detection || []).filter(function (a) {
        return a && a.frame_idx === frame && a.bbox && a.bbox.length >= 4;
      });

      log('HAND', 'drawHandDetection frame=' + frame + ' count=' + list.length);

      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var color = a.hand === 'left' ? '#22c55e' : '#3b82f6';
        // 根据遮挡状态选择线型：visible=实线, occluded=虚线, truncated=点划线
        var dash = [];
        if (a.occlusion === 'occluded') {
          dash = [6 / (scale > 0 ? scale : 1), 4 / (scale > 0 ? scale : 1)];
        } else if (a.occlusion === 'truncated') {
          dash = [2 / (scale > 0 ? scale : 1), 4 / (scale > 0 ? scale : 1)];
        }
        var isSelected = istate.selectedIds && istate.selectedIds.hand === a.id;

        // 绘制矩形
        drawRect(a.bbox, {
          color: color,
          lineWidth: isSelected ? 4 / (scale > 0 ? scale : 1) : 2 / (scale > 0 ? scale : 1),
          dash: dash,
          fill: isSelected ? 'rgba(255,255,255,0.10)' : null
        });

        // 标签：L / R，插值标注附加 (auto)
        var label = (a.hand === 'left' ? 'L' : 'R') + (a.interpolated ? ' (auto)' : '');
        drawText(label, a.bbox[0], a.bbox[1] - 8 / (scale > 0 ? scale : 1), {
          color: color,
          font: (14 / (scale > 0 ? scale : 1)) + 'px Inter, sans-serif',
          background: 'rgba(0,0,0,0.6)',
          padX: 4 / (scale > 0 ? scale : 1),
          padY: 2 / (scale > 0 ? scale : 1)
        });

        // 选中态：绘制 8 个调整点
        if (isSelected) {
          drawResizeHandles(a.bbox);
        }
      }
    } catch (e) {
      log('ERROR', 'drawHandDetection hook failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // Task 5.2：手部关键点绘制钩子
  // ============================================================

  // MediaPipe Hand 21 关键点骨骼连线拓扑
  var HAND_KEYPOINT_BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
    [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
    [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
    [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
    [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
    [0, 17]                                   // 手掌底部
  ];

  // ===== 手部关键点绘制钩子（drawAnnotations 调用） =====
  // 参数：ctx（2D 上下文）, state（AIX_ANNOTATE.state）
  // 数据结构：{id, frame_idx, hand, hand_detection_id, keypoints: [[x,y,v],...21], source}
  function drawHandKeypoints(ictx, istate) {
    try {
      if (!ictx || !istate || !istate.annotations) return;
      var frame = istate.currentFrame;
      var list = (istate.annotations.hand_keypoints || []).filter(function (a) {
        return a && a.frame_idx === frame && a.keypoints && a.keypoints.length > 0;
      });

      log('KEYPOINT', 'drawHandKeypoints frame=' + frame + ' count=' + list.length);

      var s = (scale > 0) ? scale : 1;
      // 关键点半径（屏幕 5px -> 视频坐标）
      var kpRadius = 5 / s;
      // 选中态关键点半径
      var selKpRadius = 7 / s;
      // 线宽
      var boneWidth = 2 / s;
      var selBoneWidth = 3 / s;

      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        var color = a.hand === 'left' ? '#22c55e' : '#3b82f6';
        var isSelected = istate.selectedIds && istate.selectedIds.keypoint === a.id;
        var kps = a.keypoints;

        // 1. 绘制骨骼连线
        for (var b = 0; b < HAND_KEYPOINT_BONES.length; b++) {
          var bone = HAND_KEYPOINT_BONES[b];
          var p1 = kps[bone[0]];
          var p2 = kps[bone[1]];
          if (!p1 || !p2 || p1.length < 2 || p2.length < 2) continue;
          drawLine(p1[0], p1[1], p2[0], p2[1], {
            color: color,
            lineWidth: isSelected ? selBoneWidth : boneWidth
          });
        }

        // 2. 绘制关键点
        for (var k = 0; k < kps.length; k++) {
          var p = kps[k];
          if (!p || p.length < 2) continue;
          var visible = p[2] !== 0;  // 1=visible, 0=occluded
          var r = isSelected ? selKpRadius : kpRadius;
          // visible 实心圆，occluded 虚线圆
          drawCircle(p[0], p[1], r, {
            color: color,
            fill: visible ? color : null,
            dash: visible ? [] : [3 / s, 3 / s],
            lineWidth: 2 / s
          });
          // 选中态：在关键点旁绘制索引
          if (isSelected) {
            drawText(String(k), p[0] + r, p[1] - r, {
              color: '#FFFFFF',
              font: (10 / s) + 'px Inter, sans-serif',
              background: 'rgba(0,0,0,0.6)',
              padX: 2 / s,
              padY: 1 / s
            });
          }
        }

        // 3. 标签：L / R + source 标识
        var firstKp = kps[0];
        if (firstKp && firstKp.length >= 2) {
          var label = (a.hand === 'left' ? 'L' : 'R') + '-KP' +
            (a.source === 'copy' ? ' (copy)' : '');
          drawText(label, firstKp[0], firstKp[1] - 14 / s, {
            color: color,
            font: (12 / s) + 'px Inter, sans-serif',
            background: 'rgba(0,0,0,0.6)',
            padX: 4 / s,
            padY: 2 / s
          });
        }
      }
    } catch (e) {
      log('ERROR', 'drawHandKeypoints hook failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // Task 6.x：动作分割绘制钩子
  // ============================================================

  // 在 canvas 顶部居中显示当前帧所属的动作段标签（颜色块 + 名称 + 帧范围）
  // 参数：ictx（2D 上下文）, istate（AIX_ANNOTATE.state）
  function drawActionSegmentation(ictx, istate) {
    try {
      if (!ictx || !istate || !istate.annotations) return;
      var frame = istate.currentFrame;
      var segs = (istate.annotations.action_segmentation && istate.annotations.action_segmentation.segments) || [];
      var labels = (istate.annotations.action_segmentation && istate.annotations.action_segmentation.labels) || [];

      // 查找包含当前帧的段
      var matched = null;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s && frame >= s.start_frame && frame <= s.end_frame) {
          matched = s;
          break;
        }
      }
      if (!matched) {
        // 当前帧无匹配段，静默返回（不算错误）
        return;
      }

      // 查找标签
      var label = null;
      for (var j = 0; j < labels.length; j++) {
        if (labels[j] && labels[j].id === matched.label_id) {
          label = labels[j];
          break;
        }
      }
      var labelName = label ? (label.name || '') : '';
      var labelColor = (label && label.color) ? label.color : '#888888';

      // 绘制位置：canvas 顶部居中
      var canvasW = canvas.width || 0;
      if (canvasW <= 0) return;
      var s = (scale > 0 ? scale : 1);
      // 字体大小按视频坐标缩放，确保显示尺寸约 16px CSS
      var fontSize = 16 / s;
      var padX = 6 / s;
      var padY = 3 / s;
      var colorBoxSize = 14 / s;
      var margin = 8 / s;
      var gap = 6 / s;

      // 构造显示文本：[标签名] [startFrame - endFrame]
      var text = labelName + '  [' + matched.start_frame + ' - ' + matched.end_frame + ']';
      ictx.save();
      try {
        ictx.font = fontSize + 'px Inter, sans-serif';
        ictx.textAlign = 'left';
        ictx.textBaseline = 'middle';
        var textWidth = ictx.measureText(text).width;
        // 总宽度 = 颜色块 + gap + 文本 + 内边距*2
        var totalW = colorBoxSize + gap + textWidth + padX * 2;
        var totalH = fontSize + padY * 2;
        // 顶部居中
        var x = (canvasW - totalW) / 2;
        var y = margin;

        // 1. 绘制半透明背景矩形（圆角）
        ictx.fillStyle = 'rgba(0,0,0,0.65)';
        try {
          if (typeof ictx.roundRect === 'function') {
            ictx.beginPath();
            ictx.roundRect(x, y, totalW, totalH, 4 / s);
            ictx.fill();
          } else {
            ictx.fillRect(x, y, totalW, totalH);
          }
        } catch (eRR) {
          ictx.fillRect(x, y, totalW, totalH);
        }

        // 2. 绘制颜色块（标签颜色，居中垂直对齐）
        var boxY = y + (totalH - colorBoxSize) / 2;
        ictx.fillStyle = labelColor;
        ictx.fillRect(x + padX, boxY, colorBoxSize, colorBoxSize);

        // 3. 绘制文本
        ictx.fillStyle = '#FFFFFF';
        ictx.fillText(text, x + padX + colorBoxSize + gap, y + totalH / 2);

        log('ACTION', 'drawActionSegmentation frame=' + frame + ' label=' + labelName + ' seg=' + matched.start_frame + '-' + matched.end_frame);
      } finally {
        ictx.restore();
      }
    } catch (e) {
      log('ERROR', 'drawActionSegmentation hook failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // Task 7.x：手物交互绘制钩子
  // ============================================================

  // 数据结构：
  //   state.annotations.objects: [{id, frame_idx, name, bbox:[x,y,w,h], color}]
  //   state.annotations.hand_object: [{id, frame_idx, hand_bbox_id, object_bbox_id, relation, critical_frame}]
  // 绘制：
  //   1. 物体框（橙色，选中态高亮 + 调整点）
  //   2. 手框到物框的连线 + 中点标签（relation · critical_frame）
  function drawHandObject(ictx, istate) {
    try {
      if (!ictx || !istate || !istate.annotations) return;
      var frame = istate.currentFrame;
      var s = (scale > 0) ? scale : 1;
      var objects = (istate.annotations.objects || []).filter(function (o) {
        return o && o.frame_idx === frame && o.bbox && o.bbox.length >= 4;
      });
      var relations = (istate.annotations.hand_object || []).filter(function (r) {
        return r && r.frame_idx === frame;
      });

      log('HAND_OBJECT', 'drawHandObject frame=' + frame + ' objects=' + objects.length + ' relations=' + relations.length);

      // 1. 绘制关系连线（在物体框之下）
      for (var j = 0; j < relations.length; j++) {
        var r = relations[j];
        // 通过 ID 查找手框和物框
        var handBox = null;
        var handList = istate.annotations.hand_detection || [];
        for (var hi = 0; hi < handList.length; hi++) {
          if (handList[hi] && handList[hi].id === r.hand_bbox_id && handList[hi].frame_idx === frame) {
            handBox = handList[hi].bbox;
            break;
          }
        }
        var objBox = null;
        var objListRel = istate.annotations.objects || [];
        for (var oi = 0; oi < objListRel.length; oi++) {
          if (objListRel[oi] && objListRel[oi].id === r.object_bbox_id && objListRel[oi].frame_idx === frame) {
            objBox = objListRel[oi].bbox;
            break;
          }
        }
        if (!handBox || !objBox) {
          log('WARN', 'drawHandObject: missing handBox or objBox for relation id=' + r.id);
          continue;
        }

        var x1 = handBox[0] + handBox[2] / 2;
        var y1 = handBox[1] + handBox[3] / 2;
        var x2 = objBox[0] + objBox[2] / 2;
        var y2 = objBox[1] + objBox[3] / 2;

        var isRelSelected = istate.selectedIds && istate.selectedIds.relation === r.id;
        drawLine(x1, y1, x2, y2, {
          color: isRelSelected ? '#ffffff' : '#f97316',
          lineWidth: (isRelSelected ? 4 : 2) / s
        });

        // 中点显示标签：relation · critical_frame
        var mx = (x1 + x2) / 2;
        var my = (y1 + y2) / 2;
        var label = (r.relation || '?') + ' · ' + (r.critical_frame || '?');
        drawText(label, mx, my, {
          color: '#ffffff',
          font: (12 / s) + 'px Inter, sans-serif',
          background: isRelSelected ? '#f97316' : 'rgba(0,0,0,0.7)',
          padX: 4 / s,
          padY: 2 / s
        });
      }

      // 2. 绘制物体框
      for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        var color = obj.color || '#f97316';
        var isObjSelected = istate.selectedIds && istate.selectedIds.object === obj.id;
        drawRect(obj.bbox, {
          color: color,
          lineWidth: (isObjSelected ? 4 : 2) / s,
          dash: [],
          fill: isObjSelected ? 'rgba(249,115,22,0.18)' : null
        });

        // 物体名称标签
        var objLabel = obj.name || '(unnamed)';
        drawText(objLabel, obj.bbox[0], obj.bbox[1] - 8 / s, {
          color: color,
          font: (14 / s) + 'px Inter, sans-serif',
          background: 'rgba(0,0,0,0.6)',
          padX: 4 / s,
          padY: 2 / s
        });

        // 选中态：绘制 8 个调整点
        if (isObjSelected) {
          drawResizeHandles(obj.bbox);
        }
      }
    } catch (e) {
      log('ERROR', 'drawHandObject hook failed: ' + (e.message || e));
    }
  }

  // ============================================================
  // Task 9.1：预览回放模式 API
  // ============================================================

  // ===== 设置预览模式 =====
  // mode = true 时进入预览模式：drawAnnotations 调用所有勾选的绘制函数
  // mode = false 时回到正常模式：只画当前 activeTab
  function setPreviewMode(mode) {
    try {
      var newMode = !!mode;
      if (previewMode === newMode) {
        log('PREVIEW', 'setPreviewMode: already ' + newMode + ', skip');
        return;
      }
      previewMode = newMode;
      log('PREVIEW', 'setPreviewMode: ' + newMode);
      if (newMode) {
        // 进入预览模式：重置交互状态（避免选中残留干扰绘制）
        resetInteractionState();
      }
    } catch (e) {
      log('ERROR', 'setPreviewMode failed: ' + (e.message || e));
    }
  }

  // ===== 设置预览可见开关 =====
  // flags = { hand: bool, keypoints: bool, action: bool, handObject: bool }
  // 缺省字段保持原值不变
  function setPreviewVisibleFlags(flags) {
    try {
      if (!flags || typeof flags !== 'object') {
        log('WARN', 'setPreviewVisibleFlags: invalid flags');
        return;
      }
      if (typeof flags.hand === 'boolean') previewVisibleFlags.hand = flags.hand;
      if (typeof flags.keypoints === 'boolean') previewVisibleFlags.keypoints = flags.keypoints;
      if (typeof flags.action === 'boolean') previewVisibleFlags.action = flags.action;
      if (typeof flags.handObject === 'boolean') previewVisibleFlags.handObject = flags.handObject;
      log('PREVIEW', 'setPreviewVisibleFlags: ' +
        'hand=' + previewVisibleFlags.hand +
        ' keypoints=' + previewVisibleFlags.keypoints +
        ' action=' + previewVisibleFlags.action +
        ' handObject=' + previewVisibleFlags.handObject);
    } catch (e) {
      log('ERROR', 'setPreviewVisibleFlags failed: ' + (e.message || e));
    }
  }

  // ===== 获取预览模式状态 =====
  function getPreviewMode() {
    try {
      return previewMode;
    } catch (e) {
      log('ERROR', 'getPreviewMode failed: ' + (e.message || e));
      return false;
    }
  }

  // ===== 获取预览可见开关（副本） =====
  function getPreviewVisibleFlags() {
    try {
      return {
        hand: previewVisibleFlags.hand,
        keypoints: previewVisibleFlags.keypoints,
        action: previewVisibleFlags.action,
        handObject: previewVisibleFlags.handObject
      };
    } catch (e) {
      log('ERROR', 'getPreviewVisibleFlags failed: ' + (e.message || e));
      return { hand: true, keypoints: true, action: true, handObject: true };
    }
  }

  // ===== 暴露到 window.AIX_ANNOTATE_CANVAS =====
  window.AIX_ANNOTATE_CANVAS = {
    // 基础 API
    init: init,
    render: render,
    resizeCanvas: resizeCanvas,
    screenToVideoCoords: screenToVideoCoords,
    videoToCanvasCoords: videoToCanvasCoords,
    drawRect: drawRect,
    drawCircle: drawCircle,
    drawLine: drawLine,
    drawText: drawText,
    getScale: function () { return scale; },
    // 绘制钩子（阶段 4-7 会注册）
    drawHandDetection: drawHandDetection,  // Task 4.1：手部检测绘制钩子
    drawHandKeypoints: drawHandKeypoints,  // Task 5.2：手部关键点绘制钩子
    drawActionSegmentation: drawActionSegmentation,  // Task 6.x：动作分割绘制钩子
    drawHandObject: drawHandObject,  // Task 7.x：手物交互绘制钩子
    drawResizeHandles: drawResizeHandles,  // Task 4.4：暴露给外部使用
    // 鼠标交互
    interactionState: interactionState,
    bindMouseEvents: bindMouseEvents,
    getResizeHandle: getResizeHandle,
    isPointInBBox: isPointInBBox,
    isPointInCircle: isPointInCircle,
    // 绘制完成回调钩子（阶段 4-7 注册，画矩形用）
    onDrawComplete: null,
    // 关键点点击回调钩子（阶段 5 注册，canvas click 添加关键点）
    onKeypointClick: null,
    // 阶段 9：预览回放模式 API
    setPreviewMode: setPreviewMode,
    setPreviewVisibleFlags: setPreviewVisibleFlags,
    getPreviewMode: getPreviewMode,
    getPreviewVisibleFlags: getPreviewVisibleFlags
  };

  log('INIT', 'annotate-canvas.js loaded, AIX_ANNOTATE_CANVAS exposed');

  // DOM 就绪后自动初始化
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        try {
          // 确保 annotate.js 先初始化（其 domReady 也会触发）
          // 用 setTimeout(0) 让 annotate.js 的 init 先执行
          setTimeout(init, 0);
        } catch (e) {
          log('ERROR', 'DOMContentLoaded init failed: ' + (e.message || e));
        }
      });
    } else {
      // 已就绪，延后一帧确保 annotate.js 已暴露 AIX_ANNOTATE
      setTimeout(init, 0);
    }
  } catch (e) {
    log('ERROR', 'annotate-canvas.js bootstrap failed: ' + (e.message || e));
  }
})();
