/*!
 * AIX未来视野 - EGO 数据标注工具 - HDF5 导出模块 (annotate-export.js)
 * 阶段 10：导出前检查 / 构建导出 JSON / 调用 API 导出 HDF5 / 降级 JSON
 *
 * 依赖：
 *  - window.AIX_ANNOTATE.state / .showToast() / .log()（由 annotate.js 暴露）
 *  - window.AIX_CONFIG.apiBase（由 config.js 暴露）
 *
 * 暴露 API：window.AIX_ANNOTATE_EXPORT
 *  - buildExportJson(): 从 state 构建符合 spec 的导出 JSON
 *  - validateExport(): 检查标注数据与必填元信息，返回 { ok, reason, stats }
 *  - getStats(): 返回统计信息
 *  - exportHdf5(): 主入口（校验 → 构建 → 调 API → 下载 HDF5 / 降级 JSON）
 *  - exportJson(): 直接导出 JSON 文件（不调 API）
 */
(function () {
  'use strict';

  // ===== 日志函数（格式：[AIX][AnnotateExport][TAG][HH:MM:SS.mmm]） =====
  function log(tag, message) {
    var timestamp = '';
    try {
      var d = new Date();
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      var ss = String(d.getSeconds()).padStart(2, '0');
      var ms = String(d.getMilliseconds()).padStart(3, '0');
      timestamp = hh + ':' + mm + ':' + ss + '.' + ms;
    } catch (e) {
      timestamp = '00:00:00.000';
    }
    try {
      console.log('[AIX][AnnotateExport][' + tag + '][' + timestamp + '] ' + message);
    } catch (e) {
      // console 不可用时降级（不阻断主流程）
    }
  }

  // ===== 安全读取 state（ annotate.js 暴露） =====
  function getState() {
    try {
      if (window.AIX_ANNOTATE && window.AIX_ANNOTATE.state) {
        return window.AIX_ANNOTATE.state;
      }
    } catch (e) {
      log('ERROR', 'getState failed: ' + (e.message || e));
    }
    return null;
  }

  // ===== 安全调用 Toast（annotate.js 暴露） =====
  function showToast(message) {
    try {
      if (window.AIX_ANNOTATE && typeof window.AIX_ANNOTATE.showToast === 'function') {
        window.AIX_ANNOTATE.showToast(message);
      } else {
        log('WARN', 'showToast unavailable: ' + message);
      }
    } catch (e) {
      log('ERROR', 'showToast failed: ' + (e.message || e));
    }
  }

  // ===== i18n 兜底（与 annotate.js 一致） =====
  function tt(key, fallback) {
    try {
      if (typeof t === 'function') return t(key, fallback);
    } catch (e) {}
    return fallback != null ? fallback : key;
  }

  // ===== Task 10.1：getStats() - 返回统计信息 =====
  function getStats() {
    var empty = {
      hand_detection: 0,
      hand_keypoints: 0,
      action_segments: 0,
      action_labels: 0,
      hand_object: 0,
      objects: 0,
      annotated_frames: 0,
      duration_sec: 0,
      total_frames: 0
    };
    try {
      var st = getState();
      if (!st || !st.annotations) {
        log('WARN', 'getStats: state or annotations missing');
        return empty;
      }
      var ann = st.annotations;
      var handDet = Array.isArray(ann.hand_detection) ? ann.hand_detection : [];
      var handKp = Array.isArray(ann.hand_keypoints) ? ann.hand_keypoints : [];
      var actSeg = (ann.action_segmentation && Array.isArray(ann.action_segmentation.segments)) ? ann.action_segmentation.segments : [];
      var actLab = (ann.action_segmentation && Array.isArray(ann.action_segmentation.labels)) ? ann.action_segmentation.labels : [];
      var ho = Array.isArray(ann.hand_object) ? ann.hand_object : [];
      var objs = Array.isArray(ann.objects) ? ann.objects : [];

      // 已标帧数 = 出现在任意标注中的 frame_idx 去重数
      var frameSet = {};
      var i, item;
      for (i = 0; i < handDet.length; i++) {
        item = handDet[i];
        if (item && item.frame_idx != null) frameSet[item.frame_idx] = 1;
      }
      for (i = 0; i < handKp.length; i++) {
        item = handKp[i];
        if (item && item.frame_idx != null) frameSet[item.frame_idx] = 1;
      }
      for (i = 0; i < ho.length; i++) {
        item = ho[i];
        if (item && item.frame_idx != null) frameSet[item.frame_idx] = 1;
      }
      for (i = 0; i < objs.length; i++) {
        item = objs[i];
        if (item && item.frame_idx != null) frameSet[item.frame_idx] = 1;
      }
      var annotatedFrames = Object.keys(frameSet).length;

      var durationSec = 0;
      var totalFrames = 0;
      try {
        totalFrames = st.totalFrames || 0;
      } catch (e) {}
      try {
        // 阶段 5：优先使用 meta_info.fps，兼容旧 meta.fps
        var fps = (st.fps
          || (st.meta_info && st.meta_info.fps)
          || (st.meta && st.meta.fps)
          || 30);
        if (st.videoDuration) {
          durationSec = Math.round((st.videoDuration) * 10) / 10;
        } else if (totalFrames > 0 && fps > 0) {
          durationSec = Math.round((totalFrames / fps) * 10) / 10;
        }
      } catch (e) {}

      var stats = {
        hand_detection: handDet.length,
        hand_keypoints: handKp.length,
        action_segments: actSeg.length,
        action_labels: actLab.length,
        hand_object: ho.length,
        objects: objs.length,
        annotated_frames: annotatedFrames,
        duration_sec: durationSec,
        total_frames: totalFrames
      };
      log('STATS', 'getStats: ' + JSON.stringify(stats));
      return stats;
    } catch (e) {
      log('ERROR', 'getStats failed: ' + (e.message || e));
      return empty;
    }
  }

  // ===== Task 10.1：validateExport() - 检查标注数据与必填元信息 =====
  // 返回 { ok: bool, reason: string, stats: object, missingMeta: [string], emptyAnnotations: [string] }
  function validateExport() {
    var result = {
      ok: false,
      reason: '',
      stats: null,
      missingMeta: [],
      emptyAnnotations: []
    };
    try {
      var st = getState();
      if (!st) {
        result.reason = 'state unavailable';
        log('VALIDATE', 'validateExport failed: state unavailable');
        return result;
      }

      var stats = getStats();
      result.stats = stats;

      // 检查各标注类型是否有数据
      var ann = st.annotations || {};
      var handDet = Array.isArray(ann.hand_detection) ? ann.hand_detection : [];
      var handKp = Array.isArray(ann.hand_keypoints) ? ann.hand_keypoints : [];
      var actSeg = (ann.action_segmentation && Array.isArray(ann.action_segmentation.segments)) ? ann.action_segmentation.segments : [];
      var ho = Array.isArray(ann.hand_object) ? ann.hand_object : [];
      var objs = Array.isArray(ann.objects) ? ann.objects : [];

      if (handDet.length === 0) result.emptyAnnotations.push('hand_detection');
      if (handKp.length === 0) result.emptyAnnotations.push('hand_keypoints');
      if (actSeg.length === 0) result.emptyAnnotations.push('action_segmentation');
      if (ho.length === 0) result.emptyAnnotations.push('hand_object');
      if (objs.length === 0) result.emptyAnnotations.push('objects');

      var hasAnyAnnotation =
        handDet.length > 0 || handKp.length > 0 || actSeg.length > 0 || ho.length > 0 || objs.length > 0;

      if (!hasAnyAnnotation) {
        result.reason = tt('annotate.export_no_data', '暂无标注数据，请先标注');
        log('VALIDATE', 'validateExport: no annotation data');
        return result;
      }

      // 阶段 5：检查 meta_info 8 个必填字段（按 deliverable.md 定义）
      var mi = st.meta_info || {};
      var miFps = Number(mi.fps || 0);
      var miNumFrames = parseInt(mi.num_frames || 0, 10);
      var miFrameName = Array.isArray(mi.frame_name) ? mi.frame_name : [];
      var miTrajectory = String(mi.trajectory_index || '').trim();
      var miDataSource = String(mi.data_source || '').trim();
      var miSubCam = String(mi.instruction_sub_camera || '').trim();
      var miHorizon = String(mi.task_horizon || '');

      // data_source：非空 string
      if (miDataSource === '') {
        result.missingMeta.push('data_source');
      }
      // trajectory_index：非空 string
      if (miTrajectory === '') {
        result.missingMeta.push('trajectory_index');
      }
      // fps：> 0
      if (!(miFps > 0)) {
        result.missingMeta.push('fps');
      }
      // num_frames：int ≥ 1
      if (!(miNumFrames >= 1)) {
        result.missingMeta.push('num_frames');
      }
      // frame_name：长度 ≥ 1
      if (miFrameName.length < 1) {
        result.missingMeta.push('frame_name');
      } else {
        // 元素互不重复
        var seen = {};
        var hasDup = false;
        for (var fi = 0; fi < miFrameName.length; fi++) {
          var nm = String(miFrameName[fi] || '').trim();
          if (nm === '' || seen[nm]) { hasDup = true; break; }
          seen[nm] = true;
        }
        if (hasDup) {
          result.missingMeta.push('frame_name(unique)');
        }
      }
      // instruction_sub_camera：必须存在于 frame_name 中
      if (miSubCam === '' || miFrameName.indexOf(miSubCam) === -1) {
        result.missingMeta.push('instruction_sub_camera');
      }
      // task_horizon：必须是 short / long / NA
      if (miHorizon !== 'short' && miHorizon !== 'long' && miHorizon !== 'NA') {
        result.missingMeta.push('task_horizon');
      }
      // task_success：bool（默认 True，只要不是 false 都视为 True，不报错）

      if (result.missingMeta.length > 0) {
        result.reason = tt('annotate.export_meta_incomplete', '元信息不完整') +
          ' (' + result.missingMeta.join(', ') + ')';
        log('VALIDATE', 'validateExport: missing meta_info: ' + result.missingMeta.join(','));
        return result;
      }

      result.ok = true;
      result.reason = tt('annotate.export_ready', '可以导出');
      log('VALIDATE', 'validateExport: ok, stats=' + JSON.stringify(stats));
      return result;
    } catch (e) {
      result.reason = 'validateExport error: ' + (e.message || e);
      log('ERROR', 'validateExport failed: ' + (e.message || e));
      return result;
    }
  }

  // ===== Task 10.2：buildExportJson() - 从 state 构建导出 JSON =====
  // 阶段 5：导出结构由 meta → meta_info（按 deliverable.md 8 字段定义）
  function buildExportJson() {
    try {
      var st = getState();
      if (!st) {
        log('ERROR', 'buildExportJson: state unavailable');
        throw new Error('state unavailable');
      }

      // 优先使用 state.meta_info，缺失时从 state.fps / state.totalFrames 兜底
      var mi = (st.meta_info && typeof st.meta_info === 'object') ? st.meta_info : {};
      var legacyMeta = (st.meta && typeof st.meta === 'object') ? st.meta : {};

      var fps = Number(mi.fps != null ? mi.fps : (st.fps || legacyMeta.fps || 30));
      if (!(fps > 0)) fps = 30;
      var numFrames = parseInt(mi.num_frames != null ? mi.num_frames : (st.totalFrames || 0), 10);
      if (!(numFrames >= 0)) numFrames = 0;
      var frameName = Array.isArray(mi.frame_name) ? mi.frame_name.slice() : [];
      var taskSuccess = (mi.task_success !== false); // 默认 true
      var taskHorizon = (mi.task_horizon === 'short' || mi.task_horizon === 'long' || mi.task_horizon === 'NA')
        ? mi.task_horizon : 'NA';

      // 阶段 5：导出 meta_info（按 deliverable.md 定义）
      var exportMetaInfo = {
        data_source: String(mi.data_source != null ? mi.data_source : (legacyMeta.scene_type || '')).trim(),
        trajectory_index: String(mi.trajectory_index != null ? mi.trajectory_index : '').trim(),
        fps: fps,
        num_frames: numFrames,
        frame_name: frameName,
        instruction_sub_camera: String(mi.instruction_sub_camera != null ? mi.instruction_sub_camera : '').trim(),
        task_success: taskSuccess,
        task_horizon: taskHorizon
      };

      // 深拷贝各标注数组（避免外部修改）
      var handDetection = deepCloneArray(st.annotations.hand_detection);
      var handKeypoints = deepCloneArray(st.annotations.hand_keypoints);

      var actionSeg = {
        labels: deepCloneArray(st.annotations.action_segmentation && st.annotations.action_segmentation.labels),
        segments: deepCloneArray(st.annotations.action_segmentation && st.annotations.action_segmentation.segments)
      };

      var handObject = deepCloneArray(st.annotations.hand_object);
      var objects = deepCloneArray(st.annotations.objects);

      var exportJson = {
        meta_info: exportMetaInfo,
        annotations: {
          hand_detection: handDetection,
          hand_keypoints: handKeypoints,
          action_segmentation: actionSeg,
          hand_object: handObject,
          objects: objects
        }
      };

      log('BUILD', 'buildExportJson: meta_info=' + JSON.stringify(exportMetaInfo) +
        ' hand_detection=' + handDetection.length +
        ' hand_keypoints=' + handKeypoints.length +
        ' segments=' + actionSeg.segments.length +
        ' hand_object=' + handObject.length +
        ' objects=' + objects.length);
      return exportJson;
    } catch (e) {
      log('ERROR', 'buildExportJson failed: ' + (e.message || e));
      throw e;
    }
  }

  // ===== 工具：深拷贝数组（保留对象结构） =====
  function deepCloneArray(arr) {
    try {
      if (!Array.isArray(arr)) return [];
      return JSON.parse(JSON.stringify(arr));
    } catch (e) {
      log('WARN', 'deepCloneArray fallback to slice: ' + (e.message || e));
      try {
        return arr.slice();
      } catch (_) {
        return [];
      }
    }
  }

  // ===== Task 10.3：callExportApi(json) - 调用 API 导出 HDF5 =====
  // 返回 Promise：
  //   resolve({ blob, filename })  - 成功（HDF5）
  //   reject({ type, message })    - 失败（type: 'timeout'|'network'|'http'|'content_type'|'unknown'）
  function callExportApi(json) {
    return new Promise(function (resolve, reject) {
      var apiBase = '';
      try {
        apiBase = (window.AIX_CONFIG && window.AIX_CONFIG.apiBase) || '';
      } catch (e) {
        apiBase = '';
      }
      if (!apiBase) {
        log('API', 'callExportApi: apiBase empty, fallback to relative path');
        apiBase = '';
      }
      var url = apiBase + '/api/annotate/export';
      log('API', 'callExportApi: POST ' + url + ' timeout=3000ms');

      var controller = null;
      var timeoutId = null;
      try {
        controller = new AbortController();
      } catch (e) {
        log('WARN', 'AbortController unsupported, will rely on fetch timeout: ' + (e.message || e));
      }

      var bodyStr;
      try {
        bodyStr = JSON.stringify(json);
      } catch (e) {
        log('ERROR', 'callExportApi: JSON.stringify failed: ' + (e.message || e));
        reject({ type: 'unknown', message: 'JSON stringify failed: ' + (e.message || e) });
        return;
      }

      var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr
      };
      if (controller) {
        fetchOpts.signal = controller.signal;
        timeoutId = setTimeout(function () {
          try {
            controller.abort();
          } catch (e) {}
          log('API', 'callExportApi: TIMEOUT after 3000ms');
          reject({ type: 'timeout', message: 'Request timeout (3s)' });
        }, 3000);
      }

      fetch(url, fetchOpts).then(function (response) {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        try {
          if (!response.ok) {
            log('API', 'callExportApi: HTTP error status=' + response.status + ' ' + response.statusText);
            // 尝试读取错误信息
            response.text().then(function (txt) {
              log('API', 'callExportApi: error body: ' + (txt || '').substring(0, 500));
              reject({
                type: 'http',
                message: 'HTTP ' + response.status + ' ' + response.statusText,
                status: response.status,
                body: txt
              });
            }).catch(function () {
              reject({ type: 'http', message: 'HTTP ' + response.status + ' ' + response.statusText, status: response.status });
            });
            return;
          }
          var contentType = '';
          try {
            contentType = response.headers.get('Content-Type') || '';
          } catch (e) {}
          log('API', 'callExportApi: response ok, Content-Type=' + contentType);

          // 检查是否为 HDF5 二进制流
          if (contentType.indexOf('application/octet-stream') === -1 &&
              contentType.indexOf('application/hdf5') === -1 &&
              contentType.indexOf('application/x-hdf5') === -1) {
            log('API', 'callExportApi: unexpected Content-Type: ' + contentType);
            reject({ type: 'content_type', message: 'Unexpected Content-Type: ' + contentType, contentType: contentType });
            return;
          }
          response.blob().then(function (blob) {
            log('API', 'callExportApi: blob received, size=' + (blob && blob.size));
            // 尝试从 Content-Disposition 获取文件名
            var filename = 'annotation.h5';
            try {
              var cd = response.headers.get('Content-Disposition') || '';
              var match = cd.match(/filename="?([^";]+)"?/i);
              if (match && match[1]) filename = match[1];
            } catch (e) {}
            resolve({ blob: blob, filename: filename });
          }).catch(function (e) {
            log('ERROR', 'callExportApi: response.blob() failed: ' + (e.message || e));
            reject({ type: 'unknown', message: 'Failed to read blob: ' + (e.message || e) });
          });
        } catch (e) {
          log('ERROR', 'callExportApi: response handling failed: ' + (e.message || e));
          reject({ type: 'unknown', message: 'Response handling failed: ' + (e.message || e) });
        }
      }).catch(function (err) {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        var msg = (err && (err.message || err)) || 'network error';
        // AbortError → timeout
        if (err && err.name === 'AbortError') {
          log('API', 'callExportApi: AbortError (likely timeout)');
          reject({ type: 'timeout', message: 'Request aborted (timeout)' });
          return;
        }
        log('API', 'callExportApi: fetch error: ' + msg);
        reject({ type: 'network', message: 'Network error: ' + msg });
      });
    });
  }

  // ===== downloadBlob(blob, filename) - 触发文件下载 =====
  function downloadBlob(blob, filename) {
    try {
      if (!blob) {
        log('ERROR', 'downloadBlob: blob is null');
        return false;
      }
      var url = '';
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        log('ERROR', 'downloadBlob: createObjectURL failed: ' + (e.message || e));
        return false;
      }
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || 'download.bin';
      document.body.appendChild(a);
      a.click();
      // 异步释放 URL
      setTimeout(function () {
        try {
          if (a.parentNode) a.parentNode.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (e) {}
      }, 1500);
      log('DOWNLOAD', 'downloadBlob: ' + filename + ' size=' + (blob.size || 'unknown'));
      return true;
    } catch (e) {
      log('ERROR', 'downloadBlob failed: ' + (e.message || e));
      return false;
    }
  }

  // ===== downloadJson(json, filename) - 把 JSON 转 Blob 下载 =====
  function downloadJson(json, filename) {
    try {
      var bodyStr;
      try {
        bodyStr = JSON.stringify(json, null, 2);
      } catch (e) {
        log('ERROR', 'downloadJson: JSON.stringify failed: ' + (e.message || e));
        // 降级：把对象转字符串
        bodyStr = String(json);
      }
      var blob;
      try {
        blob = new Blob([bodyStr], { type: 'application/json;charset=utf-8' });
      } catch (e) {
        log('ERROR', 'downloadJson: Blob creation failed: ' + (e.message || e));
        return false;
      }
      log('DOWNLOAD', 'downloadJson: ' + (filename || 'annotation.json') + ' size=' + (blob.size || 'unknown'));
      return downloadBlob(blob, filename || 'annotation.json');
    } catch (e) {
      log('ERROR', 'downloadJson failed: ' + (e.message || e));
      return false;
    }
  }

  // ===== Task 10.3：exportHdf5() - 主入口 =====
  function exportHdf5() {
    log('EXPORT', 'exportHdf5: start');
    try {
      // 1. validateExport()
      var validation = validateExport();
      if (!validation.ok) {
        log('EXPORT', 'exportHdf5: validation failed - ' + validation.reason);
        showToast(validation.reason);
        return;
      }

      // 2. buildExportJson()
      var exportJson;
      try {
        exportJson = buildExportJson();
      } catch (e) {
        log('ERROR', 'exportHdf5: buildExportJson failed: ' + (e.message || e));
        showToast(tt('annotate.export_build_failed', '构建导出数据失败: ') + (e.message || e));
        return;
      }

      // 提示用户正在导出
      showToast(tt('annotate.exporting', '正在导出 HDF5...'));

      // 3. callExportApi(json)
      callExportApi(exportJson).then(function (result) {
        // 4. 成功：downloadBlob(response.blob, 'annotation.h5')
        log('EXPORT', 'exportHdf5: API success, downloading HDF5');
        try {
          var ok = downloadBlob(result.blob, result.filename || 'annotation.h5');
          if (ok) {
            showToast(tt('annotate.export_success', '导出成功'));
          } else {
            log('ERROR', 'exportHdf5: downloadBlob returned false');
            showToast(tt('annotate.export_download_failed', '下载 HDF5 文件失败'));
          }
        } catch (e) {
          log('ERROR', 'exportHdf5: downloadBlob exception: ' + (e.message || e));
          showToast(tt('annotate.export_download_failed', '下载 HDF5 文件失败'));
        }
      }).catch(function (err) {
        // 5. 失败：降级 downloadJson(json, 'annotation.json') + Toast 提示
        log('EXPORT', 'exportHdf5: API failed type=' + (err && err.type) + ' msg=' + (err && err.message) + ' → fallback to JSON');
        try {
          var fallbackOk = downloadJson(exportJson, 'annotation.json');
          if (fallbackOk) {
            showToast(tt('annotate.export_fallback',
              'HDF5 服务暂不可用，已导出 JSON。可使用提供的转换脚本生成本地 HDF5'));
          } else {
            showToast(tt('annotate.export_fallback_failed', '导出失败：HDF5 服务不可用且 JSON 下载失败'));
          }
        } catch (e) {
          log('ERROR', 'exportHdf5: fallback downloadJson exception: ' + (e.message || e));
          showToast(tt('annotate.export_fallback_failed', '导出失败：HDF5 服务不可用且 JSON 下载失败'));
        }
      });
    } catch (e) {
      log('ERROR', 'exportHdf5 failed: ' + (e.message || e));
      showToast(tt('annotate.export_error', '导出失败: ') + (e.message || e));
    }
  }

  // ===== exportJson() - 直接导出 JSON（不调用 API） =====
  function exportJson() {
    log('EXPORT', 'exportJson: start');
    try {
      // 直接导出 JSON 不强制校验，但仍提示
      var st = getState();
      if (!st) {
        showToast(tt('annotate.export_state_error', '状态不可用，无法导出'));
        return;
      }
      var hasAny = false;
      try {
        var ann = st.annotations || {};
        if (Array.isArray(ann.hand_detection) && ann.hand_detection.length > 0) hasAny = true;
        if (Array.isArray(ann.hand_keypoints) && ann.hand_keypoints.length > 0) hasAny = true;
        if (ann.action_segmentation && Array.isArray(ann.action_segmentation.segments) && ann.action_segmentation.segments.length > 0) hasAny = true;
        if (Array.isArray(ann.hand_object) && ann.hand_object.length > 0) hasAny = true;
        if (Array.isArray(ann.objects) && ann.objects.length > 0) hasAny = true;
      } catch (e) {}
      if (!hasAny) {
        showToast(tt('annotate.export_no_data', '暂无标注数据，请先标注'));
        return;
      }

      var exportJson;
      try {
        exportJson = buildExportJson();
      } catch (e) {
        showToast(tt('annotate.export_build_failed', '构建导出数据失败: ') + (e.message || e));
        return;
      }
      var ok = downloadJson(exportJson, 'annotation.json');
      if (ok) {
        showToast(tt('annotate.export_json_success', '已导出 JSON'));
      } else {
        showToast(tt('annotate.export_download_failed', '下载 JSON 文件失败'));
      }
    } catch (e) {
      log('ERROR', 'exportJson failed: ' + (e.message || e));
      showToast(tt('annotate.export_error', '导出失败: ') + (e.message || e));
    }
  }

  // ===== 暴露 API =====
  window.AIX_ANNOTATE_EXPORT = {
    buildExportJson: buildExportJson,
    validateExport: validateExport,
    getStats: getStats,
    callExportApi: callExportApi,
    downloadBlob: downloadBlob,
    downloadJson: downloadJson,
    exportHdf5: exportHdf5,
    exportJson: exportJson,
    log: log
  };

  log('INIT', 'annotate-export.js loaded, API exposed on window.AIX_ANNOTATE_EXPORT');
})();
