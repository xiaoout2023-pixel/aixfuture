/*!
 * AIX未来视野 - EGO 视频预处理模块 (annotate-process.js)
 * 功能：
 *   1. Brown-Conrady 畸变模型去畸变 (undistortFrame)
 *   2. 画质统一 (encodeFrameToJPEG)
 *   3. 分辨率对齐 (resizeFrame)
 *   4. 帧率标准化 (resampleFrames)
 *   5. 主处理流程 processVideo（MediaRecorder + canvas.captureStream）
 *
 * 注意：自重构起，预处理结果不再存 IndexedDB，而是由调用方
 * (annotate.js) 通过 File System Access API 写入工作目录的
 * processed/ 子文件夹。本模块仅负责生成 Blob 并通过 onComplete 回调返回。
 *
 * 暴露 API：window.AIX_ANNOTATE_PROCESS
 *   - processVideo(videoElement, config, callbacks)
 *   - undistortFrame(srcImageData, intrinsic, distortion)
 *   - resizeFrame(srcImageData, targetW, targetH)
 *   - encodeFrameToJPEG(canvas, quality)
 *   - resampleFrames(frames, srcFps, dstFps, mode)
 *
 * 约束：
 *   - 纯前端实现，不依赖外部库
 *   - try/catch 包裹所有关键操作
 *   - 每个 key 步骤有 console.log
 *   - 无畸变参数时保留原始帧 + 警告日志
 *   - MediaRecorder 不可用时通过 onError 回调通知
 */
(function () {
  'use strict';

  // ===== 日志函数 =====
  function log(tag, message) {
    var ts = new Date().toISOString().substring(11, 23);
    try {
      console.log('[AIX][Process][' + tag + '][' + ts + '] ' + message);
    } catch (e) {
      // console 不可用时降级（不阻断主流程）
    }
  }

  // ==========================================================================
  // 1. Brown-Conrady 畸变模型去畸变
  // ==========================================================================
  // 对每个目标像素，反向映射到源图像（双线性插值）
  // intrinsic: { fx, fy, cx, cy }
  // distortion: { k1, k2, k3, p1, p2 }
  function undistortFrame(srcImageData, intrinsic, distortion) {
    try {
      var w = srcImageData.width;
      var h = srcImageData.height;
      var src = srcImageData.data;
      var dst = new Uint8ClampedArray(src.length);

      var fx = (intrinsic && intrinsic.fx) || w / 2;
      var fy = (intrinsic && intrinsic.fy) || h / 2;
      var cx = (intrinsic && intrinsic.cx) || w / 2;
      var cy = (intrinsic && intrinsic.cy) || h / 2;
      var k1 = (distortion && distortion.k1) || 0;
      var k2 = (distortion && distortion.k2) || 0;
      var k3 = (distortion && distortion.k3) || 0;
      var p1 = (distortion && distortion.p1) || 0;
      var p2 = (distortion && distortion.p2) || 0;

      // 无畸变参数检测：若全部为 0，直接拷贝源帧并记录警告
      var hasDistortion = (k1 !== 0 || k2 !== 0 || k3 !== 0 || p1 !== 0 || p2 !== 0);
      if (!hasDistortion) {
        dst.set(src);
        return new ImageData(dst, w, h);
      }

      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          // 归一化坐标
          var xn = (x - cx) / fx;
          var yn = (y - cy) / fy;
          var r2 = xn * xn + yn * yn;
          var r4 = r2 * r2;
          var r6 = r4 * r2;
          // 径向畸变
          var radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
          // 切向畸变
          var tx = 2 * p1 * xn * yn + p2 * (r2 + 2 * xn * xn);
          var ty = p1 * (r2 + 2 * yn * yn) + 2 * p2 * xn * yn;
          // 畸变后坐标
          var xd = xn * radial + tx;
          var yd = yn * radial + ty;
          // 转回像素坐标
          var u = fx * xd + cx;
          var v = fy * yd + cy;
          var u0 = Math.floor(u);
          var v0 = Math.floor(v);

          var dstIdx = (y * w + x) * 4;
          if (u0 >= 0 && u0 < w - 1 && v0 >= 0 && v0 < h - 1) {
            // 双线性插值
            var du = u - u0;
            var dv = v - v0;
            var i00 = (v0 * w + u0) * 4;
            var i10 = (v0 * w + (u0 + 1)) * 4;
            var i01 = ((v0 + 1) * w + u0) * 4;
            var i11 = ((v0 + 1) * w + (u0 + 1)) * 4;
            var w00 = (1 - du) * (1 - dv);
            var w10 = du * (1 - dv);
            var w01 = (1 - du) * dv;
            var w11 = du * dv;
            dst[dstIdx]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11;
            dst[dstIdx + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
            dst[dstIdx + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
            dst[dstIdx + 3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
          } else if (u0 >= 0 && u0 < w && v0 >= 0 && v0 < h) {
            // 退化：最近邻（边缘）
            var srcIdx = (v0 * w + u0) * 4;
            dst[dstIdx]     = src[srcIdx];
            dst[dstIdx + 1] = src[srcIdx + 1];
            dst[dstIdx + 2] = src[srcIdx + 2];
            dst[dstIdx + 3] = src[srcIdx + 3];
          } else {
            // 超出边界，黑色（不透明）
            dst[dstIdx]     = 0;
            dst[dstIdx + 1] = 0;
            dst[dstIdx + 2] = 0;
            dst[dstIdx + 3] = 255;
          }
        }
      }
      return new ImageData(dst, w, h);
    } catch (e) {
      log('ERROR', 'undistortFrame failed: ' + (e.message || e));
      // 失败时返回原帧
      return srcImageData;
    }
  }

  // ==========================================================================
  // 2. 画质统一（JPEG 编码单帧）
  // ==========================================================================
  function encodeFrameToJPEG(canvas, quality) {
    return new Promise(function (resolve, reject) {
      try {
        if (!canvas || typeof canvas.toBlob !== 'function') {
          reject(new Error('encodeFrameToJPEG: canvas invalid'));
          return;
        }
        var q = (typeof quality === 'number') ? quality : 0.92;
        if (q < 0 || q > 1) q = 0.92;
        canvas.toBlob(function (blob) {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('encodeFrameToJPEG: toBlob returned null'));
          }
        }, 'image/jpeg', q);
      } catch (e) {
        log('ERROR', 'encodeFrameToJPEG failed: ' + (e.message || e));
        reject(e);
      }
    });
  }

  // ==========================================================================
  // 3. 分辨率对齐（Canvas 缩放）
  // ==========================================================================
  function resizeFrame(srcImageData, targetW, targetH) {
    try {
      if (!srcImageData || !targetW || !targetH) return srcImageData;
      var sw = srcImageData.width;
      var sh = srcImageData.height;
      if (sw === targetW && sh === targetH) return srcImageData;

      // 使用离屏 canvas 缩放
      var canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        log('ERROR', 'resizeFrame: getContext failed');
        return srcImageData;
      }
      // 先绘制到一个临时 canvas（与源同尺寸），再缩放绘制
      var tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = sw;
      tmpCanvas.height = sh;
      var tmpCtx = tmpCanvas.getContext('2d');
      tmpCtx.putImageData(srcImageData, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmpCanvas, 0, 0, sw, sh, 0, 0, targetW, targetH);
      return ctx.getImageData(0, 0, targetW, targetH);
    } catch (e) {
      log('ERROR', 'resizeFrame failed: ' + (e.message || e));
      return srcImageData;
    }
  }

  // ==========================================================================
  // 4. 帧率标准化
  // ==========================================================================
  // frames: ImageData[]
  // mode: 'drop'（丢弃多余帧） | 'interpolate'（线性插帧，alpha 混合）
  function resampleFrames(frames, srcFps, dstFps, mode) {
    try {
      if (!Array.isArray(frames) || frames.length === 0) return [];
      srcFps = srcFps || 30;
      dstFps = dstFps || 30;
      if (srcFps === dstFps) return frames.slice();

      var totalSrc = frames.length;
      var duration = totalSrc / srcFps;
      var totalDst = Math.max(1, Math.round(duration * dstFps));
      var result = [];

      for (var i = 0; i < totalDst; i++) {
        var srcPos = (i / dstFps) * srcFps; // 在源帧序列中的浮点位置
        var idx0 = Math.floor(srcPos);
        var frac = srcPos - idx0;
        if (idx0 >= totalSrc) idx0 = totalSrc - 1;
        var idx1 = Math.min(idx0 + 1, totalSrc - 1);

        if (mode === 'interpolate' && frac > 0 && idx0 !== idx1) {
          // 线性插帧（alpha 混合）
          result.push(blendFrames(frames[idx0], frames[idx1], frac));
        } else {
          // drop 模式 或 interpolate 边界：取最近帧
          result.push(frames[idx0]);
        }
      }
      log('RESAMPLE', 'src=' + srcFps + 'fps(' + totalSrc + 'f) -> dst=' + dstFps + 'fps(' + totalDst + 'f) mode=' + mode);
      return result;
    } catch (e) {
      log('ERROR', 'resampleFrames failed: ' + (e.message || e));
      return frames || [];
    }
  }

  // 帧混合（用于 interpolate 模式）
  function blendFrames(a, b, alpha) {
    try {
      if (!a || !b || a.width !== b.width || a.height !== b.height) return a || b;
      var da = a.data, db = b.data;
      var out = new Uint8ClampedArray(da.length);
      var ia = alpha, ib = 1 - alpha;
      for (var i = 0; i < da.length; i += 4) {
        out[i]     = da[i]     * ia + db[i]     * ib;
        out[i + 1] = da[i + 1] * ia + db[i + 1] * ib;
        out[i + 2] = da[i + 2] * ia + db[i + 2] * ib;
        out[i + 3] = 255;
      }
      return new ImageData(out, a.width, a.height);
    } catch (e) {
      log('ERROR', 'blendFrames failed: ' + (e.message || e));
      return a || b;
    }
  }

  // ==========================================================================
  // 5. 主处理函数 processVideo
  // ==========================================================================
  // config: {
  //   undistort: bool,
  //   intrinsic: { fx, fy, cx, cy },
  //   distortion: { k1, k2, k3, p1, p2 },
  //   quality: int (85-100, JPEG 质量，仅记录到 log，不影响 webm 输出),
  //   resolution: [w, h] | null,
  //   fps: int,
  //   resample_mode: 'drop' | 'interpolate'
  // }
  // callbacks: { onProgress(frame,total), onComplete(result), onError(err) }
  function processVideo(videoElement, config, callbacks) {
    var cancelled = false;
    var recorder = null;
    var stream = null;
    var track = null;
    var processLog = [];

    try {
      // 参数校验
      if (!videoElement) {
        throw new Error('processVideo: videoElement is null');
      }
      config = config || {};
      callbacks = callbacks || {};

      var vW = videoElement.videoWidth || 0;
      var vH = videoElement.videoHeight || 0;
      var duration = (typeof videoElement.duration === 'number' && isFinite(videoElement.duration))
        ? videoElement.duration : 0;

      var fps = config.fps || 30;
      var targetW = (config.resolution && config.resolution[0]) || vW;
      var targetH = (config.resolution && config.resolution[1]) || vH;

      if (!targetW || !targetH) {
        throw new Error('processVideo: invalid target resolution ' + targetW + 'x' + targetH + ' (video meta not loaded?)');
      }
      if (!duration || duration <= 0) {
        throw new Error('processVideo: invalid video duration ' + duration);
      }

      // MediaRecorder 支持检测
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder not supported');
      }

      // 创建 canvas
      var canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('processVideo: canvas 2d context unavailable');
      }

      // 选择编码格式
      var mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
      var chosenMime = '';
      for (var i = 0; i < mimeTypes.length; i++) {
        try {
          if (MediaRecorder.isTypeSupported(mimeTypes[i])) {
            chosenMime = mimeTypes[i];
            break;
          }
        } catch (e) {}
      }

      // captureStream：优先使用手动模式（fps=0 + requestFrame）精确控制每帧；
      // 若浏览器不支持 requestFrame，降级到自动模式（captureStream(fps)）+ 帧间隔延时。
      var canCapture = typeof canvas.captureStream === 'function';
      if (!canCapture) {
        throw new Error('canvas.captureStream not supported');
      }
      var useManualMode = false;
      try {
        stream = canvas.captureStream(0);
        track = stream.getVideoTracks()[0];
        if (track && typeof track.requestFrame === 'function') {
          useManualMode = true;
        }
      } catch (e) {
        log('WARN', 'captureStream(0) failed, fallback to auto mode: ' + (e.message || e));
      }
      if (!useManualMode) {
        // 降级到自动模式
        try {
          if (stream) {
            if (track) { try { track.stop(); } catch (_) {} }
            stream = null; track = null;
          }
          stream = canvas.captureStream(fps);
          track = stream.getVideoTracks()[0];
        } catch (e2) {
          throw new Error('captureStream auto mode failed: ' + (e2.message || e2));
        }
      }
      // 自动模式下每帧间隔（毫秒），保证 recorder 有时间捕获
      var frameDelay = useManualMode ? 0 : Math.max(30, Math.floor(1000 / fps));
      log('STREAM', 'captureStream mode=' + (useManualMode ? 'manual(requestFrame)' : 'auto(' + fps + 'fps)') +
          ' frameDelay=' + frameDelay + 'ms');

      var recOpts = chosenMime ? { mimeType: chosenMime, videoBitsPerSecond: 8000000 } : { videoBitsPerSecond: 8000000 };
      try {
        recorder = new MediaRecorder(stream, recOpts);
      } catch (e1) {
        try { recorder = new MediaRecorder(stream); }
        catch (e2) { throw new Error('MediaRecorder create failed: ' + (e2.message || e2)); }
      }

      var chunks = [];
      recorder.ondataavailable = function (e) {
        if (e && e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = function (e) {
        log('ERROR', 'MediaRecorder error: ' + (e.error && e.error.message || e));
        if (typeof callbacks.onError === 'function') {
          callbacks.onError(e.error || new Error('MediaRecorder error'));
        }
      };

      var totalFrames = Math.max(1, Math.floor(duration * fps));
      var currentFrame = 0;

      // 记录处理日志
      processLog.push({
        item: 'init',
        from: 'raw',
        to: 'processed',
        resolution: [targetW, targetH],
        fps: fps,
        resample_mode: config.resample_mode || 'drop',
        undistort: !!config.undistort,
        quality: config.quality,
        mime: chosenMime,
        timestamp: new Date().toISOString()
      });

      if (config.undistort) {
        if (config.intrinsic && config.distortion) {
          var hasDist = (config.distortion.k1 || config.distortion.k2 || config.distortion.k3 ||
                         config.distortion.p1 || config.distortion.p2);
          if (!hasDist) {
            processLog.push({
              item: 'undistort_warn',
              reason: 'no distortion params (all zero), keep raw frames',
              level: 'warn',
              timestamp: new Date().toISOString()
            });
            log('WARN', 'processVideo: undistort enabled but all distortion params are zero');
          }
        } else {
          processLog.push({
            item: 'undistort_skip',
            reason: 'no intrinsic/distortion params',
            level: 'warn',
            timestamp: new Date().toISOString()
          });
          log('WARN', 'processVideo: undistort enabled but intrinsic/distortion missing');
        }
      }

      log('START', 'processVideo: totalFrames=' + totalFrames + ' fps=' + fps +
          ' res=' + targetW + 'x' + targetH + ' dur=' + duration + ' mime=' + chosenMime);

      recorder.onstop = function () {
        try {
          if (stream && typeof stream.stop === 'function') {
            try { stream.stop(); } catch (_) {}
          } else if (track) {
            try { track.stop(); } catch (_) {}
          }
          var blob = new Blob(chunks, { type: chosenMime || 'video/webm' });
          processLog.push({
            item: 'complete',
            frames_processed: currentFrame,
            blob_size: blob.size,
            timestamp: new Date().toISOString()
          });
          log('COMPLETE', 'processVideo: blob size=' + blob.size + ' frames=' + currentFrame);
          if (typeof callbacks.onComplete === 'function') {
            callbacks.onComplete({ blob: blob, log: processLog, config: config });
          }
        } catch (e) {
          log('ERROR', 'recorder.onstop failed: ' + (e.message || e));
          if (typeof callbacks.onError === 'function') {
            callbacks.onError(e);
          }
        }
      };

      recorder.start();

      function processNextFrame() {
        try {
          if (cancelled) return;
          if (currentFrame >= totalFrames) {
            // 录制结束
            setTimeout(function () {
              try {
                if (recorder && recorder.state !== 'inactive') recorder.stop();
              } catch (e) {
                log('ERROR', 'recorder.stop failed: ' + (e.message || e));
                if (typeof callbacks.onError === 'function') callbacks.onError(e);
              }
            }, 50);
            return;
          }

          var time = currentFrame / fps;
          if (time > duration) time = duration;

          var onSeeked = function () {
            try {
              if (cancelled) return;
              // 绘制到 canvas
              ctx.drawImage(videoElement, 0, 0, targetW, targetH);

              // 去畸变
              if (config.undistort && config.intrinsic && config.distortion) {
                var hasDist = (config.distortion.k1 || config.distortion.k2 || config.distortion.k3 ||
                               config.distortion.p1 || config.distortion.p2);
                if (hasDist) {
                  var imageData = ctx.getImageData(0, 0, targetW, targetH);
                  var undistorted = undistortFrame(imageData, config.intrinsic, config.distortion);
                  ctx.putImageData(undistorted, 0,  0);
                }
              }

              // 通知 canvas 流采集一帧（手动模式）
              if (useManualMode && track && typeof track.requestFrame === 'function') {
                track.requestFrame();
              }

              currentFrame++;
              if (typeof callbacks.onProgress === 'function') {
                callbacks.onProgress(currentFrame, totalFrames);
              }

              // 下一帧：自动模式下延时 frameDelay ms 让 recorder 有时间捕获，
              // 手动模式下延时 0（requestFrame 已精确控制）
              setTimeout(processNextFrame, frameDelay);
            } catch (e) {
              log('ERROR', 'onseeked handler failed: ' + (e.message || e));
              if (typeof callbacks.onError === 'function') callbacks.onError(e);
              try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
            }
          };

          // 设置 seek 完成回调（一次性）
          videoElement.onseeked = onSeeked;
          // 部分浏览器 seek 同一位置不触发 onseeked，做超时兜底
          var seekTimeout = setTimeout(function () {
            if (cancelled) return;
            // 如果 onseeked 没触发，手动调用
            if (videoElement.onseeked === onSeeked) {
              log('WARN', 'seek timeout at frame ' + currentFrame + ', forcing draw');
              onSeeked();
            }
          }, 500);

          // 包装 onseeked 清理 timeout
          var origOnSeeked = onSeeked;
          videoElement.onseeked = function () {
            clearTimeout(seekTimeout);
            origOnSeeked();
          };

          try {
            videoElement.currentTime = time;
          } catch (seekErr) {
            clearTimeout(seekTimeout);
            log('ERROR', 'seek failed at frame ' + currentFrame + ': ' + (seekErr.message || seekErr));
            if (typeof callbacks.onError === 'function') callbacks.onError(seekErr);
            try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
          }
        } catch (e) {
          log('ERROR', 'processNextFrame failed: ' + (e.message || e));
          if (typeof callbacks.onError === 'function') callbacks.onError(e);
          try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
        }
      }

      // 启动逐帧处理
      processNextFrame();

      // 返回 cancel 句柄
      return function cancel() {
        cancelled = true;
        try {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
        } catch (e) {}
        if (stream && typeof stream.stop === 'function') {
          try { stream.stop(); } catch (_) {}
        } else if (track) {
          try { track.stop(); } catch (_) {}
        }
        log('CANCEL', 'processVideo cancelled at frame ' + currentFrame + '/' + totalFrames);
      };
    } catch (e) {
      log('ERROR', 'processVideo init failed: ' + (e.message || e));
      if (stream && typeof stream.stop === 'function') {
        try { stream.stop(); } catch (_) {}
      } else if (track) {
        try { track.stop(); } catch (_) {}
      }
      if (typeof callbacks.onError === 'function') {
        callbacks.onError(e);
      }
      return function () {};
    }
  }

  // ===== 导出 =====
  window.AIX_ANNOTATE_PROCESS = {
    processVideo: processVideo,
    undistortFrame: undistortFrame,
    resizeFrame: resizeFrame,
    encodeFrameToJPEG: encodeFrameToJPEG,
    resampleFrames: resampleFrames
  };

  log('INIT', 'annotate-process.js loaded, AIX_ANNOTATE_PROCESS exposed');
})();
