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
  var PROJECTS_STORAGE_KEY = 'aix_ego_projects'; // 阶段 1：项目数据独立存储
  var TOTAL_STEPS = 5;
  var PROJECT_TOTAL_STEPS = 4; // 阶段 5：项目模式下 4 步（元信息/标注/预览/导出）
  var TAB_KEYS = ['hand_detection', 'keypoints', 'action', 'hand_object'];
  var PLAYBACK_SPEEDS = [1, 2, 0.5, 0.25];
  var SUPPORTED_VIDEO_EXTS = ['mp4', 'mov', 'avi'];
  var MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
  var DEFAULT_THUMBNAIL = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#2a2f3a"/><text x="80" y="48" font-family="sans-serif" font-size="12" fill="#849588" text-anchor="middle">No Thumbnail</text></svg>'
  );

  // ===== File System Access API 封装（视频文件句柄 / 工作目录句柄持久化） =====
  // Chrome/Edge 支持 showOpenFilePicker / showDirectoryPicker，可持久化
  // FileSystemFileHandle / FileSystemDirectoryHandle 到 IndexedDB，
  // 刷新后通过 requestPermission 恢复；Firefox/Safari 不支持，降级到 <input type="file">
  var FS_ACCESS_SUPPORTED = typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
  var DIR_PICKER_SUPPORTED = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  var FS_DB_NAME = 'aix_ego_db';
  var FS_STORE_NAME = 'file_handles';

  // 打开/创建 IndexedDB
  // 仅创建 file_handles store（用于原始视频句柄与工作目录句柄）。
  // 重构后不再使用 processed_videos store；旧 DB 中若已存在该 store 会被保留但不再读写。
  function fsOpenDB() {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB not supported'));
          return;
        }
        var req = indexedDB.open(FS_DB_NAME, 2);
        req.onupgradeneeded = function (e) {
          try {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(FS_STORE_NAME)) {
              db.createObjectStore(FS_STORE_NAME);
            }
          } catch (err) {
            log('ERROR', 'fsOpenDB onupgradeneeded failed: ' + (err.message || err));
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function (e) {
          log('ERROR', 'fsOpenDB onerror: ' + (e.target.error && e.target.error.message));
          reject(e.target.error || new Error('IndexedDB open failed'));
        };
      } catch (err) {
        log('ERROR', 'fsOpenDB exception: ' + (err.message || err));
        reject(err);
      }
    });
  }

  // 保存 handle 到 IndexedDB
  function fsSaveHandle(key, handle) {
    return fsOpenDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FS_STORE_NAME, 'readwrite');
          var store = tx.objectStore(FS_STORE_NAME);
          store.put(handle, key);
          tx.oncomplete = function () {
            db.close();
            log('FS', 'Saved handle for key=' + key);
            resolve(true);
          };
          tx.onerror = function (e) {
            db.close();
            log('ERROR', 'fsSaveHandle tx onerror: ' + (e.target.error && e.target.error.message));
            reject(e.target.error || new Error('save handle failed'));
          };
          tx.onabort = function (e) {
            db.close();
            reject((e.target && e.target.error) || new Error('save handle aborted'));
          };
        } catch (err) {
          try { db.close(); } catch (_) {}
          log('ERROR', 'fsSaveHandle exception: ' + (err.message || err));
          reject(err);
        }
      });
    });
  }

  // 从 IndexedDB 读取 handle
  function fsLoadHandle(key) {
    return fsOpenDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FS_STORE_NAME, 'readonly');
          var store = tx.objectStore(FS_STORE_NAME);
          var req = store.get(key);
          req.onsuccess = function (e) {
            resolve(e.target.result || null);
          };
          req.onerror = function (e) {
            log('ERROR', 'fsLoadHandle req onerror: ' + (e.target.error && e.target.error.message));
            reject(e.target.error || new Error('load handle failed'));
          };
          tx.oncomplete = function () { try { db.close(); } catch (_) {} };
          tx.onabort = function () { try { db.close(); } catch (_) {} };
        } catch (err) {
          try { db.close(); } catch (_) {}
          log('ERROR', 'fsLoadHandle exception: ' + (err.message || err));
          reject(err);
        }
      });
    });
  }

  // 删除 IndexedDB 中的 handle
  function fsDeleteHandle(key) {
    return fsOpenDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          var tx = db.transaction(FS_STORE_NAME, 'readwrite');
          var store = tx.objectStore(FS_STORE_NAME);
          store.delete(key);
          tx.oncomplete = function () {
            db.close();
            log('FS', 'Deleted handle for key=' + key);
            resolve(true);
          };
          tx.onerror = function (e) {
            db.close();
            log('ERROR', 'fsDeleteHandle tx onerror: ' + (e.target.error && e.target.error.message));
            reject(e.target.error || new Error('delete handle failed'));
          };
          tx.onabort = function () { db.close(); reject(new Error('delete handle aborted')); };
        } catch (err) {
          try { db.close(); } catch (_) {}
          log('ERROR', 'fsDeleteHandle exception: ' + (err.message || err));
          reject(err);
        }
      });
    });
  }

  // 验证/请求文件句柄权限
  // readWrite=true 请求读写权限，false 只读
  function fsVerifyPermission(handle, readWrite) {
    try {
      if (!handle || typeof handle.queryPermission !== 'function') {
        return Promise.resolve(false);
      }
      var opts = { mode: readWrite ? 'readwrite' : 'read' };
      return Promise.resolve(handle.queryPermission(opts)).then(function (permState) {
        if (permState === 'granted') return true;
        // 'prompt' 状态下可调用 requestPermission 触发用户授权弹窗
        if (permState === 'prompt' && typeof handle.requestPermission === 'function') {
          return Promise.resolve(handle.requestPermission(opts)).then(function (state2) {
            return state2 === 'granted';
          });
        }
        return false;
      });
    } catch (err) {
      log('ERROR', 'fsVerifyPermission exception: ' + (err.message || err));
      return Promise.resolve(false);
    }
  }

  // handle → File（含权限验证）
  // 返回 Promise<File|null>，权限拒绝或失败时返回 null
  function fsHandleToFile(handle) {
    if (!handle) return Promise.resolve(null);
    return fsVerifyPermission(handle, false).then(function (ok) {
      if (!ok) {
        log('FS', 'Permission denied for handle');
        return null;
      }
      return handle.getFile();
    }).catch(function (err) {
      log('ERROR', 'fsHandleToFile failed: ' + (err.message || err));
      return null;
    });
  }

  // ===== 工作目录管理（File System Access API） =====
  // 工作目录句柄存 IndexedDB：key = 'project_{projectId}_workdir'
  // 预处理视频写入 {工作目录}/processed/{原文件名去扩展名}_processed.webm

  // 生成预处理文件名：{原文件名去扩展名}_processed.webm
  function buildProcessedFileName(originalFileName) {
    try {
      var base = String(originalFileName || 'video');
      var dotIdx = base.lastIndexOf('.');
      if (dotIdx > 0) base = base.substring(0, dotIdx);
      // 清理文件系统非法字符
      base = base.replace(/[\\/:*?"<>|]/g, '_');
      return base + '_processed.webm';
    } catch (e) {
      return 'video_processed.webm';
    }
  }

  // 工作目录句柄的 IndexedDB key（批次级）
  function workDirKey(projectId, batchId) {
    return 'project_' + projectId + '_batch_' + batchId + '_workdir';
  }

  // 从 IndexedDB 恢复工作目录句柄（不验证权限）
  // 返回 Promise<FileSystemDirectoryHandle|null>
  function getProjectWorkDirHandle(projectId, batchId) {
    try {
      if (!projectId || !batchId) return Promise.resolve(null);
      return fsLoadHandle(workDirKey(projectId, batchId)).then(function (handle) {
        return handle || null;
      }).catch(function (err) {
        log('ERROR', 'getProjectWorkDirHandle failed: ' + (err.message || err));
        return null;
      });
    } catch (e) {
      log('ERROR', 'getProjectWorkDirHandle exception: ' + (e.message || e));
      return Promise.resolve(null);
    }
  }

  // 调用 showDirectoryPicker 选择批次工作目录，保存句柄到 IndexedDB
  function setBatchWorkDir(project, batch) {
    try {
      if (!project || !batch) {
        log('WARN', 'setBatchWorkDir: project or batch is null');
        return;
      }
      if (!DIR_PICKER_SUPPORTED) {
        log('WARN', 'setBatchWorkDir: showDirectoryPicker unsupported');
        showToast(tt('annotate.project.browser_not_support_dir',
          '当前浏览器不支持选择目录，请使用 Chrome/Edge'));
        return;
      }
      log('WORKDIR', 'setBatchWorkDir: opening directory picker for batch ' + batch.id);
      window.showDirectoryPicker({ mode: 'readwrite' }).then(function (dirHandle) {
        if (!dirHandle) {
          log('WARN', 'setBatchWorkDir: no dirHandle returned');
          return;
        }
        var key = workDirKey(project.id, batch.id);
        fsSaveHandle(key, dirHandle).then(function () {
          batch.work_dir_name = dirHandle.name;
          saveProjects();
          // 局部刷新批次面板
          if (state.currentProject && state.currentProject.id === project.id) {
            refreshBatchPanel(project);
          }
          var msg = tt('annotate.project.work_dir_saved', '工作目录已设置：{name}')
            .split('{name}').join(dirHandle.name);
          showToast(msg);
          log('WORKDIR', 'set work dir for batch ' + batch.id + ': ' + dirHandle.name);
        }).catch(function (err) {
          log('ERROR', 'setBatchWorkDir: fsSaveHandle failed: ' + (err.message || err));
          showToast(tt('annotate.project.process_save_failed',
            '保存到文件系统失败，已降级下载'));
        });
      }).catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        if (msg.indexOf('aborted') !== -1 || msg.indexOf('Abort') !== -1) {
          log('WORKDIR', 'setBatchWorkDir: user cancelled');
          return;
        }
        log('ERROR', 'setBatchWorkDir: showDirectoryPicker failed: ' + msg);
        showToast(tt('annotate.project.browser_not_support_dir',
          '当前浏览器不支持选择目录，请使用 Chrome/Edge'));
      });
    } catch (e) {
      log('ERROR', 'setBatchWorkDir exception: ' + (e.message || e));
      showToast(tt('annotate.project.process_save_failed',
        '保存到文件系统失败，已降级下载'));
    }
  }

  // 将预处理 Blob 写入批次工作目录的 processed/ 子文件夹
  // 成功 resolve({ path, filename, dirName })，失败 reject(err)
  function saveProcessedBlobToWorkDir(projectId, batchId, blob, originalFileName) {
    return new Promise(function (resolve, reject) {
      try {
        if (!projectId || !batchId) {
          reject(new Error('work_dir_not_set'));
          return;
        }
        getProjectWorkDirHandle(projectId, batchId).then(function (dirHandle) {
          if (!dirHandle) {
            reject(new Error('work_dir_not_set'));
            return;
          }
          // 请求读写权限
          fsVerifyPermission(dirHandle, true).then(function (ok) {
            if (!ok) {
              log('ERROR', 'saveProcessedBlobToWorkDir: permission denied');
              reject(new Error('permission_denied'));
              return;
            }
            var filename = buildProcessedFileName(originalFileName);
            var relPath = 'processed/' + filename;
            // 创建 processed/ 子文件夹
            dirHandle.getDirectoryHandle('processed', { create: true }).then(function (procDir) {
              procDir.getFileHandle(filename, { create: true }).then(function (fileHandle) {
                fileHandle.createWritable().then(function (writable) {
                  writable.write(blob).then(function () {
                    return writable.close();
                  }).then(function () {
                    log('WORKDIR', 'saved processed blob: ' + relPath +
                      ' size=' + (blob && blob.size || 0));
                    resolve({ path: relPath, filename: filename, dirName: dirHandle.name });
                  }).catch(function (err) {
                    log('ERROR', 'saveProcessedBlobToWorkDir write/close failed: ' + (err.message || err));
                    reject(err);
                  });
                }).catch(function (err) {
                  log('ERROR', 'saveProcessedBlobToWorkDir createWritable failed: ' + (err.message || err));
                  reject(err);
                });
              }).catch(function (err) {
                log('ERROR', 'saveProcessedBlobToWorkDir getFileHandle failed: ' + (err.message || err));
                reject(err);
              });
            }).catch(function (err) {
              log('ERROR', 'saveProcessedBlobToWorkDir getDirectoryHandle failed: ' + (err.message || err));
              reject(err);
            });
          }).catch(function (err) {
            log('ERROR', 'saveProcessedBlobToWorkDir permission check failed: ' + (err.message || err));
            reject(err);
          });
        }).catch(function (err) {
          reject(err);
        });
      } catch (e) {
        log('ERROR', 'saveProcessedBlobToWorkDir exception: ' + (e.message || e));
        reject(e);
      }
    });
  }

  // 从工作目录的 processed/ 子文件夹读取预处理文件
  // relPath 形如 'processed/xxx_processed.webm'
  // 成功 resolve(File)，失败 reject(err)
  function loadProcessedFileFromWorkDir(projectId, relPath) {
    return new Promise(function (resolve, reject) {
      try {
        if (!projectId || !relPath) {
          reject(new Error('invalid_args'));
          return;
        }
        getProjectWorkDirHandle(projectId).then(function (dirHandle) {
          if (!dirHandle) {
            reject(new Error('work_dir_not_set'));
            return;
          }
          fsVerifyPermission(dirHandle, false).then(function (ok) {
            if (!ok) {
              log('ERROR', 'loadProcessedFileFromWorkDir: permission denied');
              reject(new Error('permission_denied'));
              return;
            }
            var parts = String(relPath).split('/').filter(Boolean);
            if (parts.length < 2) {
              reject(new Error('invalid_path'));
              return;
            }
            var subDirName = parts[0];
            var fileName = parts[parts.length - 1];
            dirHandle.getDirectoryHandle(subDirName, { create: false }).then(function (subDir) {
              subDir.getFileHandle(fileName, { create: false }).then(function (fileHandle) {
                fileHandle.getFile().then(function (file) {
                  log('WORKDIR', 'loaded processed file: ' + relPath + ' size=' + (file.size || 0));
                  resolve(file);
                }).catch(function (err) {
                  log('ERROR', 'loadProcessedFileFromWorkDir getFile failed: ' + (err.message || err));
                  reject(err);
                });
              }).catch(function (err) {
                log('ERROR', 'loadProcessedFileFromWorkDir getFileHandle failed: ' + (err.message || err));
                reject(err);
              });
            }).catch(function (err) {
              log('ERROR', 'loadProcessedFileFromWorkDir getDirectoryHandle failed: ' + (err.message || err));
              reject(err);
            });
          }).catch(function (err) {
            reject(err);
          });
        }).catch(function (err) {
          reject(err);
        });
      } catch (e) {
        log('ERROR', 'loadProcessedFileFromWorkDir exception: ' + (e.message || e));
        reject(e);
      }
    });
  }

  // 删除批次工作目录中 processed/ 子文件夹下的预处理文件
  // relPath 形如 'processed/xxx_processed.webm'
  // 始终 resolve(bool)，失败/不存在返回 false（不抛错，避免阻塞删除流程）
  function deleteProcessedFileFromWorkDir(projectId, batchId, relPath) {
    return new Promise(function (resolve) {
      try {
        if (!projectId || !batchId || !relPath) {
          resolve(false);
          return;
        }
        getProjectWorkDirHandle(projectId, batchId).then(function (dirHandle) {
          if (!dirHandle) {
            resolve(false);
            return;
          }
          fsVerifyPermission(dirHandle, true).then(function (ok) {
            if (!ok) {
              resolve(false);
              return;
            }
            var parts = String(relPath).split('/').filter(Boolean);
            if (parts.length < 2) {
              resolve(false);
              return;
            }
            var subDirName = parts[0];
            var fileName = parts[parts.length - 1];
            dirHandle.getDirectoryHandle(subDirName, { create: false }).then(function (subDir) {
              subDir.removeEntry(fileName).then(function () {
                log('WORKDIR', 'deleted processed file: ' + relPath);
                resolve(true);
              }).catch(function (err) {
                // 文件不存在视为已删除
                log('WARN', 'deleteProcessedFileFromWorkDir removeEntry failed (likely not exist): ' + (err.message || err));
                resolve(false);
              });
            }).catch(function (err) {
              log('WARN', 'deleteProcessedFileFromWorkDir getDirectoryHandle failed: ' + (err.message || err));
              resolve(false);
            });
          }).catch(function () { resolve(false); });
        }).catch(function () { resolve(false); });
      } catch (e) {
        log('ERROR', 'deleteProcessedFileFromWorkDir exception: ' + (e.message || e));
        resolve(false);
      }
    });
  }

  // ===== 全局状态 =====
  // 视频多选（项目详情面板）
  var selectedVideoIds = new Set();

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
    // ===== 阶段 1/5：项目管理 + meta_info 字段 =====
    mode: 'project',           // 'project'（项目模式，4 步） | 'direct'（直接标注，5 步）
    projects: [],              // 项目列表（与 localStorage aix_ego_projects 同步）
    currentProject: null,      // 当前选中的项目对象（运行时引用，不持久化到 aix_annotate_state）
    currentVideo: null,        // 当前选中视频对象（运行时引用）
    project_id: null,          // 当前项目 ID
    video_id: null,            // 当前视频 ID
    device_config: null,       // 当前设备配置（来自项目）
    // 阶段 5：meta_info（8 个字段，按 deliverable.md 定义）
    meta_info: {
      data_source: '',
      trajectory_index: '',
      fps: 30,
      num_frames: 0,
      frame_name: [],           // string[]
      instruction_sub_camera: '',
      task_success: true,
      task_horizon: 'NA'
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
    historyIndex: -1,               // 重做栈指针（-1 表示无历史）
    // 批量标注上下文（仅批量标注模式有效）
    batchAnnotateContext: null      // { projectId, batchId, videoIds: [], currentIndex: 0 }
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
    importAnnotationsBtn: null,
    // 阶段 1：项目面板相关 DOM
    projectPanel: null,
    projectListView: null,
    projectDetailView: null,
    newProjectFormView: null,
    projectList: null,
    projectListEmpty: null,
    newProjectBtn: null,
    directAnnotateBtn: null,
    newProjectBackBtn: null,
    newProjectSubmitBtn: null,
    newProjectCancelBtn: null,
    projectNameInput: null,
    projectDataSourceInput: null,
    projectRemarkInput: null,
    projectVideoInput: null,
    projectFolderInput: null,
    projectImportProgress: null,
    projectImportProgressFill: null,
    projectImportProgressText: null,
    // 阶段 5：meta_info 表单字段
    metaDataSourceInput: null,
    metaTrajectoryIndexInput: null,
    metaFpsInput: null,
    metaNumFramesInput: null,
    metaFrameNameInput: null,
    metaInstructionSubCameraInput: null,
    metaTaskSuccessInput: null,
    metaTaskHorizonInput: null,
    // 标注模式容器（首屏外的 header / steps / step-content / step-nav）
    annotateHeader: null,
    annotateStepsEl: null,
    annotateStepContent: null,
    annotateStepNav: null,
    // 批量标注导航条
    batchNav: null,
    batchNavName: null,
    batchNavProgress: null,
    batchNavStatus: null,
    batchPrevBtn: null,
    batchNextBtn: null,
    batchExitBtn: null
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
    // 阶段 1：项目面板 DOM
    dom.projectPanel = qs('annotateProjectPanel');
    dom.projectListView = qs('annotateProjectListView');
    dom.projectDetailView = qs('annotateProjectDetailView');
    dom.newProjectFormView = qs('annotateNewProjectFormView');
    dom.projectList = qs('annotateProjectList');
    dom.projectListEmpty = qs('annotateProjectListEmpty');
    dom.newProjectBtn = qs('annotateNewProjectBtn');
    dom.directAnnotateBtn = qs('annotateDirectAnnotateBtn');
    dom.newProjectBackBtn = qs('annotateNewProjectBackBtn');
    dom.newProjectSubmitBtn = qs('annotateNewProjectSubmitBtn');
    dom.newProjectCancelBtn = qs('annotateNewProjectCancelBtn');
    dom.projectNameInput = qs('annotateProjectName');
    dom.projectDataSourceInput = qs('annotateProjectDataSource');
    dom.projectRemarkInput = qs('annotateProjectRemark');
    dom.projectVideoInput = qs('annotateProjectVideoInput');
    dom.projectFolderInput = qs('annotateProjectFolderInput');
    dom.projectImportProgress = qs('annotateProjectImportProgress');
    dom.projectImportProgressFill = qs('annotateProjectImportProgressFill');
    dom.projectImportProgressText = qs('annotateProjectImportProgressText');
    // 阶段 5：meta_info 表单字段（HTML 中待添加）
    dom.metaDataSourceInput = qs('annotateMetaDataSource');
    dom.metaTrajectoryIndexInput = qs('annotateMetaTrajectoryIndex');
    dom.metaFpsInput = qs('annotateMetaFps');
    dom.metaNumFramesInput = qs('annotateMetaNumFrames');
    dom.metaFrameNameInput = qs('annotateMetaFrameName');
    dom.metaInstructionSubCameraInput = qs('annotateMetaInstructionSubCamera');
    dom.metaTaskSuccessInput = qs('annotateMetaTaskSuccess');
    dom.metaTaskHorizonInput = qs('annotateMetaTaskHorizon');
    // 标注模式容器
    dom.annotateHeader = qs('annotateHeader') || document.querySelector('.annotate-header');
    dom.annotateStepsEl = dom.steps; // annotateSteps 已缓存
    dom.annotateStepContent = document.querySelector('.annotate-step-content');
    dom.annotateStepNav = qs('annotateStepNav');
    // 批量标注导航条
    dom.batchNav = qs('annotateBatchNav');
    dom.batchNavName = qs('annotateBatchNavName');
    dom.batchNavProgress = qs('annotateBatchNavProgress');
    dom.batchNavStatus = qs('annotateBatchNavStatus');
    dom.batchPrevBtn = qs('annotateBatchPrevBtn');
    dom.batchNextBtn = qs('annotateBatchNextBtn');
    dom.batchExitBtn = qs('annotateBatchExitBtn');
  }

  // ===== 步骤导航 =====
  function goToStep(step) {
    try {
      if (typeof step !== 'number' || step < 1 || step > TOTAL_STEPS) {
        log('WARN', 'goToStep invalid step: ' + step);
        return;
      }
      // 阶段 5：项目模式下不允许进入步骤 1（上传）
      if (state.mode === 'project' && step === 1) {
        log('WARN', 'goToStep: step 1 (upload) is not allowed in project mode');
        step = 2; // 重定向到元信息
      }
      var prevStep = state.currentStep;
      state.currentStep = step;
      log('STEP', 'goToStep: ' + prevStep + ' -> ' + step + ' (mode=' + state.mode + ')');

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

      // 更新导航信息（阶段 5：项目模式显示 N/4，直接模式显示 N/5）
      if (dom.stepNavInfo) {
        if (state.mode === 'project') {
          // 项目模式：步骤 2-5 映射为 1-4
          var displayStep = step - 1;
          dom.stepNavInfo.textContent = displayStep + ' / ' + PROJECT_TOTAL_STEPS;
        } else {
          dom.stepNavInfo.textContent = step + ' / ' + TOTAL_STEPS;
        }
      }

      // 上一步按钮禁用状态（阶段 5：项目模式下步骤 2 视为第一步）
      var minStep = (state.mode === 'project') ? 2 : 1;
      if (dom.prevBtn) {
        dom.prevBtn.disabled = (step === minStep);
        dom.prevBtn.style.opacity = (step === minStep) ? '0.5' : '1';
        dom.prevBtn.style.cursor = (step === minStep) ? 'not-allowed' : 'pointer';
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
      var lines = qsa('.annotate-step-line', dom.steps);
      for (var i = 0; i < circles.length; i++) {
        var circle = circles[i];
        var stepNum = parseInt(circle.getAttribute('data-step'), 10);
        // 阶段 5：项目模式下隐藏步骤 1（上传）及其后的连接线
        if (state.mode === 'project' && stepNum === 1) {
          circle.style.display = 'none';
          if (lines[i - 1]) lines[i - 1].style.display = 'none';
          continue;
        }
        circle.style.display = '';
        circle.classList.remove('active', 'completed');
        if (stepNum < state.currentStep) {
          circle.classList.add('completed');
        } else if (stepNum === state.currentStep) {
          circle.classList.add('active');
        }
      }
      // 还原连接线显示（直接模式下）
      if (state.mode !== 'project') {
        for (var j = 0; j < lines.length; j++) {
          lines[j].style.display = '';
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
      // 触发标注自动保存（debounce，仅项目模式）
      if (state.mode === 'project') {
        persistCurrentAnnotationsToVideo(false);
      }
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
      // undo 后触发标注自动保存（仅项目模式）
      if (state.mode === 'project') {
        persistCurrentAnnotationsToVideo(false);
      }
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
      // redo 后触发标注自动保存（仅项目模式）
      if (state.mode === 'project') {
        persistCurrentAnnotationsToVideo(false);
      }
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
        // 强制显示确认按钮（清除之前可能被隐藏的样式）
        dom.modalConfirmBtn.style.display = 'inline-block';
        dom.modalConfirmBtn.style.visibility = 'visible';
        dom.modalConfirmBtn.style.opacity = '1';
      }
      if (dom.modalCancelBtn) {
        dom.modalCancelBtn.textContent = opts.cancelText || tt('annotate.modal_cancel', '取消');
        dom.modalCancelBtn.style.display = opts.hideCancel ? 'none' : '';
      }
      dom.modalConfirmCallback = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
      dom.modalCancelCallback = typeof opts.onCancel === 'function' ? opts.onCancel : null;
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
      dom.modalCancelCallback = null;
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
        selectedIds: state.selectedIds,
        // 阶段 5：新增 mode 和 meta_info 持久化
        mode: state.mode,
        meta_info: state.meta_info,
        project_id: state.project_id,
        video_id: state.video_id,
        // 批量标注上下文持久化（刷新可恢复）
        batchAnnotateContext: state.batchAnnotateContext
      };
      var json = JSON.stringify(serializable);
      localStorage.setItem(STORAGE_KEY, json);
      log('SAVE', 'state saved, size=' + json.length + ' bytes (mode=' + state.mode + ')');
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
      } else if (k === 'meta_info' && typeof overlay[k] === 'object' && overlay[k] !== null) {
        // 阶段 5：meta_info 深合并
        result[k] = result[k] || {};
        for (var mik in overlay[k]) {
          if (Object.prototype.hasOwnProperty.call(overlay[k], mik)) {
            result[k][mik] = overlay[k][mik];
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
          openVideoPicker();
        });
      }
      if (dom.uploadZone) {
        dom.uploadZone.addEventListener('click', function (e) {
          // 避免点击内部按钮触发两次
          if (e.target === dom.fileSelectBtn || dom.fileSelectBtn && dom.fileSelectBtn.contains(e.target)) return;
          openVideoPicker();
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
      if (dom.modalCancelBtn) dom.modalCancelBtn.addEventListener('click', function() {
        try {
          if (typeof dom.modalCancelCallback === 'function') {
            dom.modalCancelCallback();
          }
          hideModal();
        } catch (e) {
          log('ERROR', 'modal cancel callback failed: ' + (e.message || e));
          hideModal();
        }
      });
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
      // 阶段 5：meta_info 表单双向绑定（项目模式专用）
      bindMetaInfoForm();

      // ===== 阶段 1-4：项目面板事件绑定 =====
      bindProjectEvents();

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

  // ===== 阶段 1-4：项目面板事件绑定 =====
  function bindProjectEvents() {
    try {
      // 新建项目按钮
      if (dom.newProjectBtn) {
        dom.newProjectBtn.addEventListener('click', function () {
          try {
            showNewProjectFormView();
          } catch (e) {
            log('ERROR', 'newProjectBtn click failed: ' + (e.message || e));
          }
        });
      }
      // 直接标注按钮（降级入口）
      if (dom.directAnnotateBtn) {
        dom.directAnnotateBtn.addEventListener('click', function () {
          try {
            enterDirectAnnotateMode();
          } catch (e) {
            log('ERROR', 'directAnnotateBtn click failed: ' + (e.message || e));
          }
        });
      }
      // 新建项目表单 - 返回按钮
      if (dom.newProjectBackBtn) {
        dom.newProjectBackBtn.addEventListener('click', function () {
          try {
            showProjectListView();
          } catch (e) {
            log('ERROR', 'newProjectBackBtn click failed: ' + (e.message || e));
          }
        });
      }
      // 新建项目表单 - 取消按钮
      if (dom.newProjectCancelBtn) {
        dom.newProjectCancelBtn.addEventListener('click', function () {
          try {
            showProjectListView();
          } catch (e) {
            log('ERROR', 'newProjectCancelBtn click failed: ' + (e.message || e));
          }
        });
      }
      // 新建项目表单 - 提交按钮
      if (dom.newProjectSubmitBtn) {
        dom.newProjectSubmitBtn.addEventListener('click', function () {
          try {
            submitNewProjectForm();
          } catch (e) {
            log('ERROR', 'newProjectSubmitBtn click failed: ' + (e.message || e));
          }
        });
      }
      // 新建项目表单 - 回车提交
      if (dom.projectRemarkInput) {
        dom.projectRemarkInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitNewProjectForm();
          }
        });
      }
      // 单视频导入文件输入
      if (dom.projectVideoInput) {
        dom.projectVideoInput.addEventListener('change', function (e) {
          try {
            var target = e.target || e.srcElement;
            var files = target && target.files;
            if (files && files.length > 0) {
              handleProjectVideoImport(files);
            }
          } catch (err) {
            log('ERROR', 'projectVideoInput change failed: ' + (err.message || err));
          }
        });
      }
      // 文件夹批量导入
      if (dom.projectFolderInput) {
        dom.projectFolderInput.addEventListener('change', function (e) {
          try {
            var target = e.target || e.srcElement;
            var files = target && target.files;
            if (files && files.length > 0) {
              handleProjectVideoImport(files);
            }
          } catch (err) {
            log('ERROR', 'projectFolderInput change failed: ' + (err.message || err));
          }
        });
      }
      log('INIT', 'Project events bound');
    } catch (e) {
      log('ERROR', 'bindProjectEvents failed: ' + (e.message || e));
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

  // ===== 触发视频文件选择（FS Access API 优先，降级到 <input type="file">） =====
  function openVideoPicker() {
    try {
      if (FS_ACCESS_SUPPORTED) {
        log('FILE', 'openVideoPicker: using showOpenFilePicker');
        window.showOpenFilePicker({
          types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.avi'] } }],
          multiple: false
        }).then(function (handles) {
          var fileHandle = handles && handles[0];
          if (!fileHandle) {
            log('WARN', 'openVideoPicker: no handle returned');
            return;
          }
          return fileHandle.getFile().then(function (file) {
            // handleKey 命名：项目模式 project_{id}_video_{id}，直接模式 direct_video
            var handleKey = state.project_id
              ? ('project_' + state.project_id + '_video_' + (state.video_id || ''))
              : 'direct_video';
            handleFileSelect(file, fileHandle, handleKey);
          });
        }).catch(function (err) {
          // 用户取消选择（AbortError）不报错
          if (err && err.name === 'AbortError') {
            log('FILE', 'openVideoPicker: user aborted selection');
            return;
          }
          log('ERROR', 'openVideoPicker: showOpenFilePicker failed: ' + (err.message || err));
          showToast(tt('annotate.err_load_failed', '选择文件失败: ' + (err.message || err)));
        });
      } else {
        // 不支持 FS Access API，走原 <input type="file"> 流程
        if (dom.fileInput) dom.fileInput.click();
      }
    } catch (e) {
      log('ERROR', 'openVideoPicker failed: ' + (e.message || e));
      // 兜底降级到 input
      try { if (dom.fileInput) dom.fileInput.click(); } catch (_) {}
    }
  }

  // ===== 文件选择处理（Task 2.1：完整实现视频加载） =====
  function handleFileSelect(file, fileHandle, handleKey) {
    try {
      if (!file) {
        log('WARN', 'handleFileSelect: no file');
        return;
      }

      // 保存文件句柄到 IndexedDB（用于刷新后恢复，仅 FS Access API 支持）
      if (fileHandle && handleKey && FS_ACCESS_SUPPORTED) {
        fsSaveHandle(handleKey, fileHandle).catch(function (err) {
          log('WARN', 'handleFileSelect: fsSaveHandle failed, key=' + handleKey + ' err=' + (err.message || err));
        });
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

            // 删除 IndexedDB 中持久化的文件句柄（与当前视频对应）
            if (FS_ACCESS_SUPPORTED) {
              var delKey = state.project_id
                ? ('project_' + state.project_id + '_video_' + (state.video_id || ''))
                : 'direct_video';
              fsDeleteHandle(delKey).catch(function (err) {
                log('WARN', 'removeFile: fsDeleteHandle failed, key=' + delKey + ' err=' + (err.message || err));
              });
            }

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

      // 文件信息回填（仅当 videoUrl 存在时才显示，避免刷新后显示旧文件但无法播放）
      if (state.videoUrl && state.videoFile && state.videoFileName && dom.fileName) {
        dom.fileName.textContent = state.videoFileName;
        updateFileInfoUI();
        if (dom.fileInfo) dom.fileInfo.removeAttribute('hidden');
        if (dom.uploadZone) dom.uploadZone.setAttribute('hidden', '');
      } else if (state.videoFileName && !state.videoUrl) {
        if (FS_ACCESS_SUPPORTED) {
          // FS Access 支持：保留 videoFileName，等待异步恢复流程加载视频文件
          log('INIT', 'videoFileName exists, videoUrl null, FS Access enabled — pending restore');
          if (dom.fileName) dom.fileName.textContent = state.videoFileName;
          updateFileInfoUI();
          if (dom.fileInfo) dom.fileInfo.removeAttribute('hidden');
          if (dom.uploadZone) dom.uploadZone.setAttribute('hidden', '');
        } else {
          // 不支持 FS Access：清空旧文件名，显示上传区（原逻辑）
          log('INIT', 'videoFileName exists but videoUrl is null (page refreshed), clearing stale state');
          state.videoFileName = '';
          state.videoFileSize = 0;
          state.videoDuration = 0;
          state.videoResolution = [0, 0];
          state.totalFrames = 0;
          if (dom.fileInfo) dom.fileInfo.setAttribute('hidden', '');
          if (dom.uploadZone) dom.uploadZone.removeAttribute('hidden');
          if (dom.fileName) dom.fileName.textContent = '';
        }
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

      // 阶段 1：加载项目列表（独立 localStorage key）
      loadProjects();
      // 恢复 currentProject 引用（如果有 project_id）
      if (state.project_id) {
        var restoredProject = findProjectById(state.project_id);
        if (restoredProject) {
          state.currentProject = restoredProject;
          // 恢复 device_config 引用
          state.device_config = restoredProject.device_config || createDefaultDeviceConfig();
          // 恢复 currentVideo 引用（如果有 video_id）
          if (state.video_id) {
            var restoredVideo = findVideoInProject(restoredProject, state.video_id);
            if (restoredVideo) {
              state.currentVideo = restoredVideo;
            }
          }
        }
      }

      // 渲染初始 UI
      renderInitial();

      // 绑定事件
      bindEvents();
      // 绑定批量标注导航条事件
      bindBatchAnnotateNavEvents();

      // 注册 Canvas 钩子（onDrawComplete / onAnnotationEdited）
      registerCanvasHooks();

      // 阶段 1：首屏显示项目面板（默认）
      // 无论 state.mode 如何，默认都显示项目面板，让用户选择项目或直接标注
      // 只有当 URL 带 project_id 参数时，才直接进入标注模式
      var urlParams = new URLSearchParams(window.location.search);
      var urlProjectId = urlParams.get('project_id');
      var urlVideoId = urlParams.get('video_id');

      if (urlProjectId && state.project_id && state.currentStep > 1) {
        // URL 指定了项目且之前在标注中：恢复标注界面
        hideProjectPanelAndShowAnnotate();
        ensureVideoReselectPrompt();
        // 若恢复了批量标注上下文，显示导航条
        if (state.batchAnnotateContext) {
          updateBatchAnnotateNav();
        }
      } else {
        // 默认显示项目面板
        showProjectPanel();
        showProjectListView();
        // 非标注模式时清理批量标注上下文（避免残留）
        if (state.batchAnnotateContext) {
          state.batchAnnotateContext = null;
          hideBatchAnnotateNav();
        }
      }

      // 尝试从 IndexedDB 恢复视频文件（File System Access API）
      // 仅当 FS Access 支持且有持久化的文件名但无运行时 URL 时触发
      if (FS_ACCESS_SUPPORTED && state.videoFileName && !state.videoUrl) {
        var restoreKey = state.project_id
          ? ('project_' + state.project_id + '_video_' + (state.video_id || ''))
          : 'direct_video';
        log('RESTORE', 'init: attempting restore, key=' + restoreKey + ' fileName=' + state.videoFileName);
        showToast(tt('annotate.restore_in_progress', '正在恢复视频文件...'));
        fsLoadHandle(restoreKey).then(function (handle) {
          if (!handle) {
            log('RESTORE', 'No saved file handle for key=' + restoreKey);
            showToast(tt('annotate.project.reselect_video_hint', '请在下方上传区重新选择该视频文件以加载播放器'));
            return;
          }
          log('RESTORE', 'Found file handle, requesting permission...');
          return fsHandleToFile(handle).then(function (file) {
            if (!file) {
              log('RESTORE', 'Permission denied or file unavailable');
              showToast(tt('annotate.restore_permission_denied', '无法恢复视频文件，请重新选择（权限被拒绝）'));
              return;
            }
            log('RESTORE', 'File restored: ' + file.name);
            handleFileSelect(file, handle, restoreKey);
            var restoredMsg = tt('annotate.video_restored', '已恢复视频文件: ' + file.name);
            restoredMsg = restoredMsg.split('{name}').join(file.name);
            showToast(restoredMsg);
          });
        }).catch(function (err) {
          log('ERROR', 'Restore video failed: ' + (err.message || err));
          showToast(tt('annotate.restore_permission_denied', '无法恢复视频文件，请重新选择'));
        });
      }

      log('INIT', 'Annotate page ready, currentStep=' + state.currentStep + ' activeTab=' + state.activeTab + ' mode=' + state.mode);
    } catch (e) {
      log('ERROR', 'init failed: ' + (e.message || e));
      // 致命错误时尝试提示用户
      try {
        showToast('标注工具初始化失败: ' + (e.message || e));
      } catch (_) {}
    }
  }

  // ==========================================================================
  // 阶段 1：项目管理（createProject / deleteProject / selectProject / 持久化 / 渲染）
  // ==========================================================================

  // ===== 工具：生成唯一 ID（时间戳 + 随机后缀） =====
  function genId(prefix) {
    try {
      var ts = Date.now().toString(36);
      var rand = Math.random().toString(36).substring(2, 8);
      return (prefix || 'id') + '_' + ts + rand;
    } catch (e) {
      log('ERROR', 'genId failed: ' + (e.message || e));
      return (prefix || 'id') + '_' + Date.now();
    }
  }

  // ===== 工具：生成有序 ID（batch_001 / traj_001） =====
  function genSequentialId(prefix, existingList) {
    try {
      var max = 0;
      var list = Array.isArray(existingList) ? existingList : [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item && typeof item.id === 'string') {
          var m = item.id.match(new RegExp('^' + prefix + '_(\\d+)$'));
          if (m && m[1]) {
            var n = parseInt(m[1], 10);
            if (n > max) max = n;
          }
        }
      }
      var next = max + 1;
      return prefix + '_' + String(next).padStart(3, '0');
    } catch (e) {
      log('ERROR', 'genSequentialId failed: ' + (e.message || e));
      return prefix + '_001';
    }
  }

  // ===== 创建默认 device_config =====
  function createDefaultDeviceConfig() {
    return {
      intrinsic: { fx: 0, fy: 0, cx: 0, cy: 0, distortion: [0, 0, 0, 0, 0] },
      extrinsic: {
        R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        T: [0, 0, 0]
      },
      frame_name: [],
      instruction_sub_camera: ''
    };
  }

  // ===== saveProjects：保存项目列表到 localStorage（独立 key） =====
  function saveProjects() {
    try {
      var json = JSON.stringify(state.projects || []);
      localStorage.setItem(PROJECTS_STORAGE_KEY, json);
      log('PROJECT', 'saveProjects: ' + (state.projects || []).length + ' projects, size=' + json.length + ' bytes');
      return true;
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      log('ERROR', 'saveProjects failed: ' + msg);
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
        showToast(tt('annotate.project.save_quota', '项目存储空间已满，请删除部分项目或导出后清理'));
      } else {
        showToast(tt('annotate.project.save_failed', '项目保存失败: ') + msg);
      }
      return false;
    }
  }

  // ===== loadProjects：从 localStorage 加载项目列表 =====
  function loadProjects() {
    try {
      var raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (!raw) {
        log('PROJECT', 'loadProjects: no saved projects');
        state.projects = [];
        return [];
      }
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log('WARN', 'loadProjects: saved data is not an array, reset to []');
        state.projects = [];
        return [];
      }
      state.projects = parsed;
      log('PROJECT', 'loadProjects: loaded ' + parsed.length + ' projects, size=' + raw.length + ' bytes');
      return parsed;
    } catch (e) {
      log('ERROR', 'loadProjects failed: ' + (e.message || e));
      state.projects = [];
      return [];
    }
  }

  // ===== createProject：创建新项目 =====
  function createProject(name, dataSource, remark) {
    try {
      var trimmedName = String(name || '').trim();
      var trimmedDs = String(dataSource || '').trim();
      if (!trimmedName) {
        log('WARN', 'createProject: name is empty');
        showToast(tt('annotate.project.err_name_required', '项目名称必填'));
        return null;
      }
      if (!trimmedDs) {
        log('WARN', 'createProject: data_source is empty');
        showToast(tt('annotate.project.err_data_source_required', '数据来源必填'));
        return null;
      }
      var now = new Date();
      var project = {
        id: genId('proj'),
        name: trimmedName,
        data_source: trimmedDs,
        remark: String(remark || '').trim(),
        created_at: now.toISOString(),
        videos: [],
        batches: [],
        device_config: createDefaultDeviceConfig(),
        work_dir_name: '' // 工作目录名称（显示用）；句柄存 IndexedDB key=project_{id}_workdir
      };
      state.projects.push(project);
      saveProjects();
      log('PROJECT', 'createProject: id=' + project.id + ' name=' + project.name + ' data_source=' + project.data_source);
      return project;
    } catch (e) {
      log('ERROR', 'createProject failed: ' + (e.message || e));
      showToast(tt('annotate.project.create_failed', '创建项目失败: ') + (e.message || e));
      return null;
    }
  }

  // ===== deleteProject：删除项目（二次确认） =====
  function deleteProject(projectId) {
    try {
      var project = findProjectById(projectId);
      if (!project) {
        log('WARN', 'deleteProject: project not found, id=' + projectId);
        return;
      }
      showModal({
        title: tt('annotate.project.delete_title', '删除项目'),
        body: '<p>' + tt('annotate.project.delete_body',
          '确认删除项目「{name}」及其所有视频、批次、设备配置？此操作不可撤销。')
          .replace('{name}', escapeHtml(project.name)) + '</p>',
        confirmText: tt('annotate.project.delete_btn', '删除'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var idx = findProjectIndexById(projectId);
            if (idx >= 0) {
              var project = state.projects[idx];
              // Bug 4 修复：清理项目中所有视频的文件句柄（IndexedDB）
              if (project && Array.isArray(project.videos) && FS_ACCESS_SUPPORTED) {
                for (var v = 0; v < project.videos.length; v++) {
                  var vid = project.videos[v];
                  if (vid && vid._restoreKey) {
                    try {
                      (function (key) {
                        fsDeleteHandle(key).catch(function (err) {
                          log('WARN', 'deleteProject: fsDeleteHandle video failed, key=' + key +
                            ' err=' + (err.message || err));
                        });
                      })(vid._restoreKey);
                    } catch (e2) {
                      log('WARN', 'deleteProject: fsDeleteHandle video exception: ' + (e2.message || e2));
                    }
                  }
                }
                log('PROJECT', 'deleteProject: cleaned ' + project.videos.length + ' video handle(s)');
              }
              state.projects.splice(idx, 1);
              saveProjects();
              renderProjectList();
              log('PROJECT', 'deleteProject: deleted id=' + projectId);
              showToast(tt('annotate.project.deleted', '项目已删除'));
              // 清理所有批次的工作目录句柄（批次级，不阻塞删除流程）
              if (project && Array.isArray(project.batches)) {
                for (var bi = 0; bi < project.batches.length; bi++) {
                  var batch = project.batches[bi];
                  if (batch && batch.id) {
                    try {
                      (function (bid) {
                        fsDeleteHandle(workDirKey(projectId, bid)).catch(function (err) {
                          log('WARN', 'deleteProject: fsDeleteHandle batch workdir failed, batch=' + bid +
                            ' err=' + (err.message || err));
                        });
                      })(batch.id);
                    } catch (e2) {
                      log('WARN', 'deleteProject: fsDeleteHandle batch workdir exception: ' + (e2.message || e2));
                    }
                  }
                }
                log('PROJECT', 'deleteProject: cleaned ' + project.batches.length + ' batch workdir handle(s)');
              }
              // 如果删除的是当前项目，返回项目列表
              if (state.currentProject && state.currentProject.id === projectId) {
                state.currentProject = null;
                showProjectListView();
              }
            }
            hideModal();
          } catch (e) {
            log('ERROR', 'deleteProject onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'deleteProject failed: ' + (e.message || e));
    }
  }

  // ===== selectProject：进入项目详情面板 =====
  function selectProject(projectId) {
    try {
      var project = findProjectById(projectId);
      if (!project) {
        log('WARN', 'selectProject: project not found, id=' + projectId);
        return;
      }
      state.currentProject = project;
      log('PROJECT', 'selectProject: id=' + project.id + ' name=' + project.name);
      renderProjectDetail(project);
      showProjectDetailView();
    } catch (e) {
      log('ERROR', 'selectProject failed: ' + (e.message || e));
      showToast(tt('annotate.project.select_failed', '进入项目失败: ') + (e.message || e));
    }
  }

  // ===== 工具：根据 ID 查找项目 =====
  function findProjectById(id) {
    try {
      var list = state.projects || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return list[i];
      }
    } catch (e) {
      log('ERROR', 'findProjectById failed: ' + (e.message || e));
    }
    return null;
  }

  function findProjectIndexById(id) {
    try {
      var list = state.projects || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) return i;
      }
    } catch (e) {
      log('ERROR', 'findProjectIndexById failed: ' + (e.message || e));
    }
    return -1;
  }

  // ===== 工具：在当前项目中查找视频 =====
  function findVideoInProject(project, videoId) {
    try {
      if (!project || !Array.isArray(project.videos)) return null;
      for (var i = 0; i < project.videos.length; i++) {
        if (project.videos[i] && project.videos[i].id === videoId) return project.videos[i];
      }
    } catch (e) {
      log('ERROR', 'findVideoInProject failed: ' + (e.message || e));
    }
    return null;
  }

  // ===== 工具：HTML 转义（防 XSS） =====
  function escapeHtml(str) {
    try {
      var s = String(str == null ? '' : str);
      return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    } catch (e) {
      return String(str || '');
    }
  }

  // ===== 工具：格式化日期时间显示 =====
  function formatDateTime(isoStr) {
    try {
      if (!isoStr) return '—';
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      var yyyy = d.getFullYear();
      var mm = String(d.getMonth() + 1).padStart(2, '0');
      var dd = String(d.getDate()).padStart(2, '0');
      var hh = String(d.getHours()).padStart(2, '0');
      var mi = String(d.getMinutes()).padStart(2, '0');
      return yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi;
    } catch (e) {
      return isoStr || '—';
    }
  }

  // ===== renderProjectList：渲染项目列表 =====
  function renderProjectList() {
    try {
      if (!dom.projectList) {
        log('WARN', 'renderProjectList: projectList element not found');
        return;
      }
      var projects = state.projects || [];
      // 清空列表
      dom.projectList.innerHTML = '';

      // 空状态
      if (projects.length === 0) {
        if (dom.projectListEmpty) dom.projectListEmpty.removeAttribute('hidden');
        log('PROJECT', 'renderProjectList: empty');
        return;
      }
      if (dom.projectListEmpty) dom.projectListEmpty.setAttribute('hidden', '');

      for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        var card = document.createElement('div');
        card.className = 'annotate-project-card';
        card.setAttribute('data-project-id', project.id);

        var videoCount = Array.isArray(project.videos) ? project.videos.length : 0;
        var batchCount = Array.isArray(project.batches) ? project.batches.length : 0;

        card.innerHTML =
          '<div class="annotate-project-card-header">' +
            '<span class="material-symbols-outlined annotate-project-card-icon">folder</span>' +
            '<div class="annotate-project-card-info">' +
              '<h3 class="annotate-project-card-name">' + escapeHtml(project.name) + '</h3>' +
              '<span class="annotate-project-card-source">' + escapeHtml(project.data_source) + '</span>' +
            '</div>' +
            '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm annotate-project-card-delete" data-action="delete" title="' +
              tt('annotate.project.delete_title', '删除项目') + '">' +
              '<span class="material-symbols-outlined">delete</span>' +
            '</button>' +
          '</div>' +
          '<div class="annotate-project-card-meta">' +
            '<span class="annotate-project-card-meta-item">' +
              '<span class="material-symbols-outlined">videocam</span>' +
              '<span>' + videoCount + ' ' + tt('annotate.project.videos_unit', '条轨迹') + '</span>' +
            '</span>' +
            '<span class="annotate-project-card-meta-item">' +
              '<span class="material-symbols-outlined">layers</span>' +
              '<span>' + batchCount + ' ' + tt('annotate.project.batches_unit', '个批次') + '</span>' +
            '</span>' +
            '<span class="annotate-project-card-meta-item">' +
              '<span class="material-symbols-outlined">schedule</span>' +
              '<span>' + formatDateTime(project.created_at) + '</span>' +
            '</span>' +
          '</div>';

        // 点击卡片进入项目详情（排除删除按钮）
        (function (pid, delBtn) {
          card.addEventListener('click', function (e) {
            try {
              if (delBtn && (e.target === delBtn || delBtn.contains(e.target))) return;
              selectProject(pid);
            } catch (err) {
              log('ERROR', 'project card click failed: ' + (err.message || err));
            }
          });
          if (delBtn) {
            delBtn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                deleteProject(pid);
              } catch (err) {
                log('ERROR', 'project delete click failed: ' + (err.message || err));
              }
            });
          }
        })(project.id, card.querySelector('.annotate-project-card-delete'));

        dom.projectList.appendChild(card);
      }
      log('PROJECT', 'renderProjectList: rendered ' + projects.length + ' projects');
    } catch (e) {
      log('ERROR', 'renderProjectList failed: ' + (e.message || e));
    }
  }

  // ===== 渲染工作目录设置区 HTML =====
  // 显示当前工作目录名称 + 设置/更改按钮；浏览器不支持时禁用按钮并提示
  function renderWorkDirSectionHtml(project) {
    try {
      var dirName = (project && project.work_dir_name) ? project.work_dir_name : '';
      var notSet = !dirName;
      var disabledAttr = DIR_PICKER_SUPPORTED ? '' : ' disabled';
      var btnIcon = notSet ? 'create_new_folder' : 'sync_alt';
      var btnI18nKey = notSet ? 'annotate.project.set_work_dir' : 'annotate.project.change_work_dir';
      var btnLabel = notSet
        ? tt('annotate.project.set_work_dir', '设置工作目录')
        : tt('annotate.project.change_work_dir', '更改');

      var html =
        '<div class="annotate-work-dir-section">' +
          '<div class="annotate-work-dir-header">' +
            '<span class="material-symbols-outlined">folder</span>' +
            '<span class="annotate-work-dir-label" data-i18n="annotate.project.work_dir">' +
              tt('annotate.project.work_dir', '工作目录') + '</span>' +
            '<span class="annotate-work-dir-name' + (notSet ? ' not-set' : '') + '"' +
              (notSet ? '' : ' title="' + escapeHtml(dirName) + '"') + '>' +
              (notSet
                ? tt('annotate.project.work_dir_not_set', '未设置')
                : escapeHtml(dirName)) +
            '</span>' +
          '</div>' +
          '<div class="annotate-work-dir-hint" data-i18n="annotate.project.work_dir_hint">' +
            tt('annotate.project.work_dir_hint',
              '预处理视频将输出到此目录的 processed/ 子文件夹') +
          '</div>' +
          '<div class="annotate-work-dir-actions">' +
            '<button type="button" class="annotate-btn ' +
              (notSet ? 'annotate-btn-primary' : 'annotate-btn-secondary') +
              ' annotate-btn-sm" id="setWorkDirBtn"' + disabledAttr + '>' +
              '<span class="material-symbols-outlined">' + btnIcon + '</span>' +
              '<span data-i18n="' + btnI18nKey + '">' + btnLabel + '</span>' +
            '</button>';
      if (!DIR_PICKER_SUPPORTED) {
        html +=
            '<span class="annotate-work-dir-warn" data-i18n="annotate.project.browser_not_support_dir">' +
              tt('annotate.project.browser_not_support_dir',
                '当前浏览器不支持选择目录，请使用 Chrome/Edge') +
            '</span>';
      }
      html +=
          '</div>' +
        '</div>';
      return html;
    } catch (e) {
      log('ERROR', 'renderWorkDirSectionHtml failed: ' + (e.message || e));
      return '';
    }
  }

  // ===== renderProjectDetail：渲染项目详情面板 =====
  function renderProjectDetail(project) {
    try {
      if (!dom.projectDetailView) {
        log('WARN', 'renderProjectDetail: detail view element not found');
        return;
      }
      if (!project) {
        log('WARN', 'renderProjectDetail: project is null');
        return;
      }

      var deviceConfigHtml = renderDeviceConfigFormHtml(project);
      var batchHtml = renderBatchPanelHtml(project);
      var wizardHtml = renderProcessWizard(project);

      dom.projectDetailView.innerHTML =
        '<div class="annotate-project-detail-header">' +
          '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" id="projectDetailBackBtn">' +
            '<span class="material-symbols-outlined">arrow_back</span>' +
            '<span data-i18n="annotate.project.back_to_list">返回项目列表</span>' +
          '</button>' +
          '<div class="annotate-project-detail-info">' +
            '<h2 class="annotate-project-detail-name">' + escapeHtml(project.name) + '</h2>' +
            '<div class="annotate-project-detail-meta">' +
              '<span class="annotate-project-detail-source">' +
                '<span class="material-symbols-outlined">database</span>' +
                escapeHtml(project.data_source) +
              '</span>' +
              (project.remark ? '<span class="annotate-project-detail-remark">' +
                '<span class="material-symbols-outlined">notes</span>' +
                escapeHtml(project.remark) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        wizardHtml +
        '<div class="annotate-accordion">' +
          // 折叠面板 1：批次管理（流程步骤 ①②③④ 都在这里完成）
          '<div class="annotate-accordion-item">' +
            '<button type="button" class="annotate-accordion-header" data-target="projectBatchPanel">' +
              '<span class="material-symbols-outlined">layers</span>' +
              '<span data-i18n="annotate.project.batch_title">批次管理</span>' +
              '<span class="annotate-accordion-count" id="projectBatchesCount">' +
                (Array.isArray(project.batches) ? project.batches.length : 0) + '</span>' +
              '<span class="material-symbols-outlined annotate-accordion-arrow">expand_more</span>' +
            '</button>' +
            '<div class="annotate-accordion-body" id="projectBatchPanel">' + batchHtml + '</div>' +
          '</div>' +
          // 折叠面板 2：设备配置（辅助配置，默认折叠）
          '<div class="annotate-accordion-item">' +
            '<button type="button" class="annotate-accordion-header collapsed" data-target="projectDevicePanel">' +
              '<span class="material-symbols-outlined">videocam</span>' +
              '<span data-i18n="annotate.project.device_config_title">采集设备参数</span>' +
              '<span class="material-symbols-outlined annotate-accordion-arrow">expand_more</span>' +
            '</button>' +
            '<div class="annotate-accordion-body collapsed" id="projectDevicePanel" style="display:none;">' + deviceConfigHtml + '</div>' +
          '</div>' +
        '</div>';

      // 绑定返回按钮
      var backBtn = qs('projectDetailBackBtn');
      if (backBtn) {
        backBtn.addEventListener('click', function () {
          showProjectListView();
        });
      }
      // 绑定折叠面板事件
      bindAccordionEvents(dom.projectDetailView);
      // 绑定视频导入按钮
      var importSingleBtn = qs('importSingleVideoBtn');
      if (importSingleBtn) {
        importSingleBtn.addEventListener('click', function () {
          try {
            // 优先用 showOpenFilePicker 保存句柄；降级到 <input> 由函数内部处理
            importSingleVideoToProject(state.currentProject);
          } catch (e) {
            log('ERROR', 'import single video click failed: ' + (e.message || e));
          }
        });
      }
      var importFolderBtn = qs('importFolderVideoBtn');
      if (importFolderBtn) {
        importFolderBtn.addEventListener('click', function () {
          try {
            // 优先用 showDirectoryPicker 保存每个视频句柄；降级到 <input webkitdirectory>
            importVideosBatch(state.currentProject);
          } catch (e) {
            log('ERROR', 'import folder click failed: ' + (e.message || e));
          }
        });
      }
      // 绑定设备配置表单事件
      bindDeviceConfigFormEvents(project);
      // 绑定批次管理事件
      bindBatchPanelEvents(project);
      // 绑定视频列表事件（删除/开始标注/加入批次）
      bindVideoListEvents(project);
      // 绑定流程向导步骤点击事件
      bindProcessWizard(project);

      // 应用 i18n 到新渲染的 DOM
      try {
        if (typeof window.AIX_I18N !== 'undefined' && typeof window.AIX_I18N.applyTo === 'function') {
          window.AIX_I18N.applyTo(dom.projectDetailView);
        } else if (typeof t === 'function') {
          // 兜底：手动遍历 data-i18n
          applyI18nToFallback(dom.projectDetailView);
        }
      } catch (eI18n) {
        log('WARN', 'renderProjectDetail: apply i18n failed: ' + (eI18n.message || eI18n));
      }

      log('PROJECT', 'renderProjectDetail: rendered for project ' + project.id);
    } catch (e) {
      log('ERROR', 'renderProjectDetail failed: ' + (e.message || e));
    }
  }

  // ===== renderProcessWizard：渲染流程向导条（5 步引导） =====
  // 步骤：1=创建批次 2=设置工作目录 3=导入轨迹 4=预处理(可选) 5=开始标注
  // 说明：工作目录为批次级，至少一个批次设置了工作目录即视为步骤 2 完成
  function renderProcessWizard(project) {
    try {
      if (!project) return '';

      var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
      var batchCount = batches.length;
      var hasBatch = batchCount > 0;
      // 工作目录为批次级：至少一个批次设置了 work_dir_name 即视为完成
      var hasWorkDir = false;
      for (var bi = 0; bi < batches.length; bi++) {
        if (batches[bi] && batches[bi].work_dir_name) {
          hasWorkDir = true;
          break;
        }
      }
      var videos = (project && Array.isArray(project.videos)) ? project.videos : [];
      var videoCount = videos.length;
      var hasVideos = videoCount > 0;
      var hasProcessed = false;
      for (var i = 0; i < videos.length; i++) {
        if (videos[i] && videos[i].processed_file) {
          hasProcessed = true;
          break;
        }
      }

      // 当前步骤：1=未创建批次，2=未设置工作目录，3=未导入轨迹，4=未预处理，5=已就绪
      var currentStep;
      if (!hasBatch) currentStep = 1;
      else if (!hasWorkDir) currentStep = 2;
      else if (!hasVideos) currentStep = 3;
      else if (!hasProcessed) currentStep = 4;
      else currentStep = 5;

      // 步骤状态：done / current / skip / pending
      var step1State = hasBatch ? 'done' : 'current';
      var step2State = hasWorkDir ? 'done' : (hasBatch ? 'current' : 'pending');
      var step3State = hasVideos ? 'done' : (hasWorkDir ? 'current' : 'pending');
      // 步骤 4 可选：未完成一律显示为 skip（灰色），已完成为 done
      var step4State = hasProcessed ? 'done' : 'skip';
      // 步骤 5：有视频即可点击（current 高亮），无视频为 pending
      var step5State = hasVideos ? 'current' : 'pending';

      // 状态文案
      var statusHasBatch = tt('annotate.project.wizard_status_has_batch', '已创建 {n} 个批次').replace('{n}', String(batchCount));
      var statusSet = tt('annotate.project.wizard_status_set', '已设置');
      var statusImported = tt('annotate.project.wizard_status_imported', '已导入 {n} 条轨迹').replace('{n}', String(videoCount));
      var statusDone = tt('annotate.project.wizard_status_done', '已完成');
      var statusSkip = tt('annotate.project.wizard_status_skip', '跳过');
      var statusClick = tt('annotate.project.wizard_status_click', '点击开始');

      function stepStatusText(stepIdx) {
        if (stepIdx === 1) return step1State === 'done' ? ('✓ ' + statusHasBatch) : statusClick;
        if (stepIdx === 2) return step2State === 'done' ? ('✓ ' + statusSet) : statusClick;
        if (stepIdx === 3) return step3State === 'done' ? ('✓ ' + statusImported) : statusClick;
        if (stepIdx === 4) return step4State === 'done' ? ('✓ ' + statusDone) : ('— ' + statusSkip);
        return statusClick; // step 5
      }

      function stateClass(state) {
        if (state === 'done') return 'annotate-wizard-step-done';
        if (state === 'current') return 'annotate-wizard-step-current';
        if (state === 'skip') return 'annotate-wizard-step-skip';
        return 'annotate-wizard-step-pending';
      }

      function buildStep(stepIdx, state, title, target) {
        var num = ['①', '②', '③', '④', '⑤'][stepIdx - 1];
        var isCta = stepIdx === 5;
        var cls = 'annotate-wizard-step ' + stateClass(state);
        if (isCta) cls += ' annotate-wizard-step-cta';
        var attrs = 'data-step="' + stepIdx + '"';
        if (target) attrs += ' data-target="' + target + '"';
        if (isCta) attrs += ' data-cta="1"';
        return '<button type="button" class="' + cls + '" ' + attrs + '>' +
          '<span class="annotate-wizard-step-num">' + num + '</span>' +
          '<span class="annotate-wizard-step-body">' +
            '<span class="annotate-wizard-step-title">' + escapeHtml(title) + '</span>' +
            '<span class="annotate-wizard-step-status">' + escapeHtml(stepStatusText(stepIdx)) + '</span>' +
          '</span>' +
        '</button>';
      }

      var arrow = '<span class="annotate-wizard-arrow" aria-hidden="true">→</span>';

      var html = '<div class="annotate-process-wizard">' +
        '<div class="annotate-process-wizard-title">' +
          '<span class="material-symbols-outlined">route</span>' +
          '<span data-i18n="annotate.project.process_wizard_title">操作流程</span>' +
        '</div>' +
        '<div class="annotate-process-wizard-steps">' +
          buildStep(1, step1State, tt('annotate.project.wizard_step_batch', '创建批次'), 'projectBatchPanel') +
          arrow +
          buildStep(2, step2State, tt('annotate.project.wizard_step_workdir', '设置工作目录'), 'projectBatchPanel') +
          arrow +
          buildStep(3, step3State, tt('annotate.project.wizard_step_import', '导入轨迹'), 'projectBatchPanel') +
          arrow +
          buildStep(4, step4State, tt('annotate.project.wizard_step_process', '预处理（可选）'), 'projectBatchPanel') +
          arrow +
          buildStep(5, step5State, tt('annotate.project.wizard_step_annotate', '开始标注'), null) +
        '</div>' +
      '</div>';

      log('PROJECT', 'renderProcessWizard: currentStep=' + currentStep +
        ' batches=' + batchCount + ' hasWorkDir=' + hasWorkDir +
        ' videos=' + videoCount + ' processed=' + hasProcessed);
      return html;
    } catch (e) {
      log('ERROR', 'renderProcessWizard failed: ' + (e.message || e));
      return '';
    }
  }

  // ===== bindProcessWizard：绑定流程向导步骤点击事件 =====
  function bindProcessWizard(project) {
    try {
      if (!project) return;
      var wizard = dom.projectDetailView ? dom.projectDetailView.querySelector('.annotate-process-wizard') : null;
      if (!wizard) {
        log('WARN', 'bindProcessWizard: wizard element not found');
        return;
      }
      var steps = wizard.querySelectorAll('.annotate-wizard-step');
      for (var i = 0; i < steps.length; i++) {
        (function (step) {
          step.addEventListener('click', function () {
            try {
              var stepIdx = parseInt(step.getAttribute('data-step'), 10) || 0;
              var target = step.getAttribute('data-target');
              var isCta = step.getAttribute('data-cta') === '1';

              log('PROJECT', 'process wizard step clicked: ' + stepIdx);

              if (isCta) {
                // 步骤 ⑤：开始标注
                var videos = (project && Array.isArray(project.videos)) ? project.videos : [];
                if (videos.length > 0) {
                  var firstVideo = videos[0];
                  if (firstVideo && firstVideo.id) {
                    log('PROJECT', 'wizard CTA: start annotate, videoId=' + firstVideo.id);
                    if (typeof startAnnotateFromProject === 'function') {
                      startAnnotateFromProject(project, firstVideo.id);
                    } else {
                      showToast(tt('annotate.project.wizard_no_video', '请先导入轨迹'));
                    }
                  } else {
                    showToast(tt('annotate.project.wizard_no_video', '请先导入轨迹'));
                  }
                } else {
                  showToast(tt('annotate.project.wizard_no_video', '请先导入轨迹'));
                }
                return;
              }

              // 步骤 ③（导入轨迹）：无批次时拦截，提示先创建批次并跳到步骤 ②
              if (stepIdx === 3) {
                var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
                if (batches.length === 0) {
                  showToast(tt('annotate.project.wizard_no_batch_first',
                    '请先创建批次，再导入轨迹'));
                  var batchPanel = document.getElementById('projectBatchPanel');
                  if (batchPanel) {
                    var batchHeader = batchPanel.previousElementSibling;
                    if (batchHeader && batchHeader.classList.contains('annotate-accordion-header') &&
                        batchHeader.classList.contains('collapsed')) {
                      try { batchHeader.click(); } catch (eClick) {}
                    }
                    try { batchPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                    catch (eScroll) { batchPanel.scrollIntoView(); }
                    try {
                      batchPanel.classList.add('annotate-wizard-highlight');
                      setTimeout(function () {
                        try { batchPanel.classList.remove('annotate-wizard-highlight'); } catch (e) {}
                      }, 1500);
                    } catch (eHl) {}
                  }
                  return;
                }
              }

              // 步骤 ①②③④：滚动到对应面板（先展开折叠面板）
              if (target) {
                var panel = document.getElementById(target);
                if (!panel) {
                  log('WARN', 'wizard: target panel not found: ' + target);
                  return;
                }
                // 如果面板是折叠的，先展开
                var accordionHeader = panel.previousElementSibling;
                if (accordionHeader && accordionHeader.classList.contains('annotate-accordion-header') &&
                    accordionHeader.classList.contains('collapsed')) {
                  try {
                    accordionHeader.click();
                  } catch (eClick) {
                    log('WARN', 'wizard: expand panel failed: ' + (eClick.message || eClick));
                  }
                }
                // 滚动到面板
                try {
                  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } catch (eScroll) {
                  panel.scrollIntoView();
                }
                // 短暂高亮面板
                try {
                  panel.classList.add('annotate-wizard-highlight');
                  setTimeout(function () {
                    try { panel.classList.remove('annotate-wizard-highlight'); } catch (e) {}
                  }, 1500);
                } catch (eHl) {}
              }
            } catch (e) {
              log('ERROR', 'wizard step click failed: ' + (e.message || e));
            }
          });
        })(steps[i]);
      }
      log('PROJECT', 'bindProcessWizard: bound ' + steps.length + ' steps');
    } catch (e) {
      log('ERROR', 'bindProcessWizard failed: ' + (e.message || e));
    }
  }

  // ===== 兜底 i18n：手动应用 data-i18n 属性（无 i18n 模块时） =====
  function applyI18nToFallback(root) {
    try {
      var els = (root || document).querySelectorAll('[data-i18n]');
      for (var i = 0; i < els.length; i++) {
        var key = els[i].getAttribute('data-i18n');
        if (key) {
          var val = tt(key, els[i].textContent || '');
          els[i].textContent = val;
        }
      }
    } catch (e) {
      log('WARN', 'applyI18nToFallback failed: ' + (e.message || e));
    }
  }

  // ===== 视图切换：项目列表 / 项目详情 / 新建项目表单 =====
  function showProjectListView() {
    try {
      if (dom.projectListView) dom.projectListView.classList.add('active');
      if (dom.projectDetailView) dom.projectDetailView.classList.remove('active');
      if (dom.newProjectFormView) dom.newProjectFormView.classList.remove('active');
      renderProjectList();
      // 返回项目列表时隐藏批量标注导航条（若存在）
      if (dom.batchNav) dom.batchNav.setAttribute('hidden', '');
      log('VIEW', 'showProjectListView');
    } catch (e) {
      log('ERROR', 'showProjectListView failed: ' + (e.message || e));
    }
  }

  function showProjectDetailView() {
    try {
      if (dom.projectListView) dom.projectListView.classList.remove('active');
      if (dom.projectDetailView) dom.projectDetailView.classList.add('active');
      if (dom.newProjectFormView) dom.newProjectFormView.classList.remove('active');
      log('VIEW', 'showProjectDetailView');
    } catch (e) {
      log('ERROR', 'showProjectDetailView failed: ' + (e.message || e));
    }
  }

  function showNewProjectFormView() {
    try {
      if (dom.projectListView) dom.projectListView.classList.remove('active');
      if (dom.projectDetailView) dom.projectDetailView.classList.remove('active');
      if (dom.newProjectFormView) dom.newProjectFormView.classList.add('active');
      // 清空表单
      if (dom.projectNameInput) dom.projectNameInput.value = '';
      if (dom.projectDataSourceInput) dom.projectDataSourceInput.value = '';
      if (dom.projectRemarkInput) dom.projectRemarkInput.value = '';
      // 聚焦项目名输入
      if (dom.projectNameInput) {
        try { dom.projectNameInput.focus(); } catch (e) {}
      }
      log('VIEW', 'showNewProjectFormView');
    } catch (e) {
      log('ERROR', 'showNewProjectFormView failed: ' + (e.message || e));
    }
  }

  // ===== 项目面板 / 标注模式容器显隐控制 =====
  function showProjectPanel() {
    try {
      // 显示项目面板，隐藏标注模式容器
      if (dom.projectPanel) dom.projectPanel.removeAttribute('hidden');
      if (dom.annotateHeader) dom.annotateHeader.style.display = 'none';
      if (dom.annotateStepsEl) dom.annotateStepsEl.style.display = 'none';
      if (dom.annotateStepContent) dom.annotateStepContent.style.display = 'none';
      if (dom.annotateStepNav) dom.annotateStepNav.style.display = 'none';
      log('VIEW', 'showProjectPanel');
    } catch (e) {
      log('ERROR', 'showProjectPanel failed: ' + (e.message || e));
    }
  }

  function hideProjectPanelAndShowAnnotate() {
    try {
      if (dom.projectPanel) dom.projectPanel.setAttribute('hidden', '');
      if (dom.annotateHeader) dom.annotateHeader.style.display = '';
      if (dom.annotateStepsEl) dom.annotateStepsEl.style.display = '';
      if (dom.annotateStepContent) dom.annotateStepContent.style.display = '';
      if (dom.annotateStepNav) dom.annotateStepNav.style.display = '';
      log('VIEW', 'hideProjectPanelAndShowAnnotate');
    } catch (e) {
      log('ERROR', 'hideProjectPanelAndShowAnnotate failed: ' + (e.message || e));
    }
  }

  // ===== 新建项目表单提交 =====
  function submitNewProjectForm() {
    try {
      var name = dom.projectNameInput ? dom.projectNameInput.value : '';
      var ds = dom.projectDataSourceInput ? dom.projectDataSourceInput.value : '';
      var remark = dom.projectRemarkInput ? dom.projectRemarkInput.value : '';
      log('PROJECT', 'submitNewProjectForm: name="' + name + '" data_source="' + ds + '"');
      var project = createProject(name, ds, remark);
      if (project) {
        showToast(tt('annotate.project.created', '项目创建成功'));
        // 进入项目详情
        selectProject(project.id);
      }
    } catch (e) {
      log('ERROR', 'submitNewProjectForm failed: ' + (e.message || e));
    }
  }

  // ==========================================================================
  // 阶段 2：视频导入与缩略图
  // ==========================================================================

  // ===== 渲染视频列表 HTML（项目详情面板内） =====
  function renderVideoListHtml(project) {
    try {
      var videos = (project && Array.isArray(project.videos)) ? project.videos : [];
      if (videos.length === 0) {
        return '<div class="annotate-project-empty-mini">' +
          '<span class="material-symbols-outlined">videocam_off</span>' +
          '<p data-i18n="annotate.project.no_videos">' + tt('annotate.project.no_videos', '暂无轨迹，点击上方按钮导入') + '</p>' +
        '</div>';
      }
      var html = '<div class="annotate-video-grid">';
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        var thumb = v.thumbnail || DEFAULT_THUMBNAIL;
        var resolution = (v.resolution && v.resolution.length === 2)
          ? (v.resolution[0] + '×' + v.resolution[1]) : '—';
        var duration = v.duration ? formatTime(v.duration) : '—';
        var traj = v.trajectory_index || '';
        var batchInfo = v.batch_id ? ('<span class="annotate-video-tag">' + escapeHtml(v.batch_id) + '</span>') : '';
        var trajInfo = traj ? ('<span class="annotate-video-tag annotate-video-tag-traj">' + escapeHtml(traj) + '</span>') : '';
        // 已预处理标签 + 相对路径（鼠标悬停显示完整路径提示）
        var processedInfo = '';
        if (v.processed_file) {
          var relPath = String(v.processed_file);
          var fullHint = (project && project.work_dir_name ? project.work_dir_name + '/' : '') + relPath;
          processedInfo =
            '<span class="annotate-video-tag annotate-video-tag-processed"' +
              ' title="' + escapeHtml(fullHint) + '">' +
              tt('annotate.project.processed_badge', '已预处理') +
              '<span class="annotate-video-tag-path">' + escapeHtml(relPath) + '</span>' +
            '</span>';
        }
        // 自定义标签
        var customTagsHtml = '';
        if (v.tags && typeof v.tags === 'object') {
          var tagKeys = Object.keys(v.tags);
          for (var tk = 0; tk < tagKeys.length; tk++) {
            var k = tagKeys[tk];
            var val = v.tags[k];
            customTagsHtml += '<span class="annotate-video-tag annotate-video-tag-label">' +
              escapeHtml(k) + ':' + escapeHtml(String(val)) + '</span>';
          }
        }
        var isSelected = selectedVideoIds && selectedVideoIds.has(v.id);

        html +=
          '<div class="annotate-video-card' + (isSelected ? ' selected' : '') + '" data-video-id="' + escapeHtml(v.id) + '">' +
            '<div class="annotate-video-checkbox">' +
              '<input type="checkbox" class="annotate-video-select-cb" data-video-id="' + escapeHtml(v.id) + '"' + (isSelected ? ' checked' : '') + '>' +
            '</div>' +
            '<div class="annotate-video-thumb">' +
              '<img src="' + thumb + '" alt="thumbnail" loading="lazy">' +
              '<div class="annotate-video-duration">' + duration + '</div>' +
              '<div class="annotate-video-overlay">' +
                '<button type="button" class="annotate-btn annotate-btn-primary annotate-btn-sm annotate-video-annotate-btn" data-action="annotate">' +
                  '<span class="material-symbols-outlined">edit_note</span>' +
                  '<span data-i18n="annotate.project.start_annotate">开始标注</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div class="annotate-video-info">' +
              '<h4 class="annotate-video-name" title="' + escapeHtml(v.file_name) + '">' + escapeHtml(v.file_name) + '</h4>' +
              '<div class="annotate-video-meta">' +
                '<span>' + formatFileSize(v.file_size || 0) + '</span>' +
                '<span>·</span>' +
                '<span>' + resolution + '</span>' +
                '<span>·</span>' +
                '<span>' + (v.fps || 30) + ' fps</span>' +
              '</div>' +
              '<div class="annotate-video-tags">' + batchInfo + trajInfo + processedInfo + customTagsHtml + '</div>' +
              '<div class="annotate-video-actions">' +
                '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" data-action="tags">' +
                  '<span class="material-symbols-outlined">label</span>' +
                  '<span>' + tt('annotate.project.tags', '标签') + '</span>' +
                '</button>' +
                '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" data-action="process">' +
                  '<span class="material-symbols-outlined">auto_fix_high</span>' +
                  '<span data-i18n="annotate.project.process">' + tt('annotate.project.process', '预处理') + '</span>' +
                '</button>' +
                '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" data-action="batch">' +
                  '<span class="material-symbols-outlined">add_to_photos</span>' +
                  '<span data-i18n="annotate.project.add_to_batch">' + tt('annotate.project.add_to_batch', '加入批次') + '</span>' +
                '</button>' +
                '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm" data-action="delete" data-i18n-title="annotate.delete">' +
                  '<span class="material-symbols-outlined">delete</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>';
      }
      html += '</div>';
      return html;
    } catch (e) {
      log('ERROR', 'renderVideoListHtml failed: ' + (e.message || e));
      return '<p class="annotate-project-empty-mini">' + escapeHtml('轨迹列表渲染失败: ' + (e.message || e)) + '</p>';
    }
  }

  // ===== 处理单视频导入（来自 dom.projectVideoInput） =====
  // 改造：文件已选好之后，再弹批次选择对话框，选完批次后才真正写入
  function handleProjectVideoImport(fileList) {
    try {
      if (!fileList || fileList.length === 0) {
        log('WARN', 'handleProjectVideoImport: no files');
        return;
      }
      var files = Array.prototype.slice.call(fileList);
      // 过滤视频文件
      var videoFiles = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (isVideoFile(f)) {
          videoFiles.push(f);
        } else {
          log('WARN', 'handleProjectVideoImport: skip non-video: ' + (f.name || 'unknown'));
        }
      }
      if (videoFiles.length === 0) {
        showToast(tt('annotate.err_unsupported_format', '不支持的格式，仅支持 MP4/MOV/AVI'));
        return;
      }
      log('IMPORT', 'handleProjectVideoImport: ' + videoFiles.length + ' video files');

      var project = state.currentProject;
      if (!project) {
        log('ERROR', 'handleProjectVideoImport: no current project');
        showToast(tt('annotate.project.no_current_project', '请先选择项目'));
        return;
      }
      var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
      if (batches.length === 0) {
        showToast(tt('annotate.project.wizard_no_batch_first',
          '请先创建批次，再导入轨迹'));
        return;
      }
      // 弹出批次选择对话框
      promptSelectBatchForImport(project, batches, function (selectedBatchId) {
        try {
          processBatchVideoFiles(project, videoFiles, null, selectedBatchId);
        } catch (e) {
          log('ERROR', 'handleProjectVideoImport processBatchVideoFiles failed: ' + (e.message || e));
          showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
        }
      });
    } catch (e) {
      log('ERROR', 'handleProjectVideoImport failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
    }
  }

  // ===== 判断是否为受支持的视频文件 =====
  function isVideoFile(file) {
    try {
      if (!file || !file.name) return false;
      var name = file.name;
      var dotIdx = name.lastIndexOf('.');
      var ext = dotIdx >= 0 ? name.substring(dotIdx + 1).toLowerCase() : '';
      if (SUPPORTED_VIDEO_EXTS.indexOf(ext) >= 0) return true;
      // 兼容 webm 等浏览器支持的格式（仅导入，不强制 mp4/mov/avi）
      if (file.type && file.type.indexOf('video/') === 0) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  // ===== 批量导入视频（用 showDirectoryPicker 优先，降级到 <input webkitdirectory>）=====
  // 改动：用 File System Access API 的 showDirectoryPicker 代替 <input webkitdirectory>，
  // 为每个视频文件保存 FileSystemFileHandle 到 IndexedDB，
  // 批量预处理时通过 video._restoreKey 恢复句柄，无需重新选文件。
  // 流程改造：导入前必须先选择目标批次，导入的视频自动归属该批次。
  function importVideosBatch(project) {
    try {
      if (!project) {
        log('WARN', 'importVideosBatch: no project');
        showToast(tt('annotate.project.no_current_project', '请先选择项目'));
        return;
      }
      // 校验：必须先创建至少一个批次
      var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
      if (batches.length === 0) {
        showToast(tt('annotate.project.wizard_no_batch_first',
          '请先创建批次，再导入轨迹'));
        log('IMPORT', 'importVideosBatch: no batch, abort');
        // 跳转到批次面板
        var batchPanel = document.getElementById('projectBatchPanel');
        if (batchPanel) {
          var batchHeader = batchPanel.previousElementSibling;
          if (batchHeader && batchHeader.classList.contains('annotate-accordion-header') &&
              batchHeader.classList.contains('collapsed')) {
            try { batchHeader.click(); } catch (eClick) {}
          }
          try { batchPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          catch (eScroll) { batchPanel.scrollIntoView(); }
          try {
            batchPanel.classList.add('annotate-wizard-highlight');
            setTimeout(function () {
              try { batchPanel.classList.remove('annotate-wizard-highlight'); } catch (e) {}
            }, 1500);
          } catch (eHl) {}
        }
        return;
      }

      // 工作目录未设置时，提示用户（不阻塞导入）
      if (!project.work_dir_name) {
        showToast(tt('annotate.project.work_dir_hint_on_import',
          '建议先设置工作目录，以便后续预处理输出到本地文件'));
        log('IMPORT', 'importVideosBatch: work_dir not set, showing hint');
      }

      // 弹出批次选择对话框（默认选最近创建的批次）
      promptSelectBatchForImport(project, batches, function (selectedBatchId) {
        try {
          startImportWithBatch(project, selectedBatchId);
        } catch (e) {
          log('ERROR', 'importVideosBatch startImportWithBatch failed: ' + (e.message || e));
          showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
        }
      });
    } catch (e) {
      log('ERROR', 'importVideosBatch failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
    }
  }

  // ===== 弹出批次选择对话框（导入轨迹前） =====
  // 按创建时间倒序，默认选最近创建的批次
  function promptSelectBatchForImport(project, batches, onConfirm) {
    try {
      // 按 created_at 倒序（最近创建在前）
      var sorted = batches.slice().sort(function (a, b) {
        var ta = a && a.created_at ? new Date(a.created_at).getTime() : 0;
        var tb = b && b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      });
      var defaultId = sorted[0] && sorted[0].id ? sorted[0].id : '';

      // 构造下拉选项
      var optionsHtml = '';
      for (var i = 0; i < sorted.length; i++) {
        var b = sorted[i];
        var bid = escapeHtml(b.id || '');
        var bname = escapeHtml(b.name || b.id || '');
        var bcount = 0;
        if (Array.isArray(b.video_ids)) bcount = b.video_ids.length;
        var label = bname + ' (' + bcount + ' ' + tt('annotate.project.batch_unit_short', '条') + ')';
        var sel = (b.id === defaultId) ? ' selected' : '';
        optionsHtml += '<option value="' + bid + '"' + sel + '>' + escapeHtml(label) + '</option>';
      }

      var body =
        '<div class="annotate-modal-form">' +
          '<p class="annotate-modal-hint" data-i18n="annotate.project.import_batch_hint">' +
            tt('annotate.project.import_batch_hint',
              '请选择本次导入轨迹归属的批次，导入后可在批次管理中调整') +
          '</p>' +
          '<div class="annotate-modal-field">' +
            '<label data-i18n="annotate.project.select_batch">' +
              tt('annotate.project.select_batch', '选择批次') +
            '</label>' +
            '<select id="importBatchSelect" class="annotate-modal-select">' + optionsHtml + '</select>' +
          '</div>' +
        '</div>';

      showModal({
        title: tt('annotate.project.import_select_batch_title', '选择导入批次'),
        body: body,
        confirmText: tt('annotate.project.btn_continue_import', '继续导入'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var sel = document.getElementById('importBatchSelect');
            var bid = sel ? sel.value : '';
            if (!bid) {
              showToast(tt('annotate.project.select_batch_first', '请选择批次'));
              return;
            }
            hideModal();
            if (typeof onConfirm === 'function') onConfirm(bid);
          } catch (e) {
            log('ERROR', 'promptSelectBatchForImport onConfirm failed: ' + (e.message || e));
          }
        },
        onCancel: function () {
          try { hideModal(); } catch (e) {}
        }
      });
    } catch (e) {
      log('ERROR', 'promptSelectBatchForImport failed: ' + (e.message || e));
      // 失败时降级：直接用第一个批次
      if (batches[0] && batches[0].id && typeof onConfirm === 'function') {
        onConfirm(batches[0].id);
      }
    }
  }

  // ===== 实际开始文件选择与导入流程（已选定批次） =====
  function startImportWithBatch(project, batchId) {
    try {
      var videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];

      if (FS_ACCESS_SUPPORTED && typeof window.showDirectoryPicker === 'function') {
        // Chrome/Edge：用 showDirectoryPicker，保存句柄到 IndexedDB
        log('IMPORT', 'startImportWithBatch: using showDirectoryPicker, batchId=' + batchId);
        window.showDirectoryPicker().then(function (dirHandle) {
          // 遍历文件夹
          var videoHandles = [];
          var entries = dirHandle.values();
          var collectNext = function () {
            try {
              entries.next().then(function (result) {
                try {
                  if (result.done) {
                    log('IMPORT', 'startImportWithBatch: collected ' + videoHandles.length + ' video handles');
                    processBatchVideoFiles(project, videoHandles, dirHandle, batchId);
                    return;
                  }
                  var entry = result.value;
                  if (entry && entry.kind === 'file') {
                    var extMatch = entry.name.toLowerCase().match(/\.[^.]+$/);
                    if (extMatch && videoExtensions.indexOf(extMatch[0]) !== -1) {
                      videoHandles.push(entry); // entry 是 FileSystemFileHandle
                    }
                  }
                  collectNext();
                } catch (e) {
                  log('ERROR', 'startImportWithBatch iterate step failed: ' + (e && e.message || e));
                  collectNext();
                }
              }).catch(function (err) {
                log('ERROR', 'startImportWithBatch iterate dir failed: ' + (err && err.message || err));
                processBatchVideoFiles(project, videoHandles, dirHandle, batchId);
              });
            } catch (e) {
              log('ERROR', 'startImportWithBatch collectNext exception: ' + (e && e.message || e));
              processBatchVideoFiles(project, videoHandles, dirHandle, batchId);
            }
          };
          collectNext();
        }).catch(function (err) {
          if (err && err.name === 'AbortError') {
            log('IMPORT', 'startImportWithBatch: user aborted directory picker');
            return;
          }
          log('ERROR', 'startImportWithBatch: showDirectoryPicker failed: ' + (err && err.message || err));
          showToast(tt('annotate.err_load_failed', '选择文件夹失败: ' + (err && err.message || err)));
        });
      } else {
        // 降级：<input webkitdirectory>（Firefox/Safari），不保存句柄
        log('IMPORT', 'startImportWithBatch: fallback to <input webkitdirectory>');
        var input = document.createElement('input');
        input.type = 'file';
        try { input.webkitdirectory = true; } catch (_) {}
        input.multiple = true;
        input.accept = 'video/*';
        input.onchange = function () {
          try {
            var files = Array.prototype.slice.call(input.files || []);
            var videoFiles = files.filter(function (f) {
              var extMatch = f.name.toLowerCase().match(/\.[^.]+$/);
              return extMatch && videoExtensions.indexOf(extMatch[0]) !== -1;
            });
            processBatchVideoFiles(project, videoFiles, null, batchId);
          } catch (e) {
            log('ERROR', 'startImportWithBatch fallback onchange failed: ' + (e.message || e));
            showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
          }
        };
        input.click();
      }
    } catch (e) {
      log('ERROR', 'startImportWithBatch failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
    }
  }

  // ===== 处理批量导入的视频文件列表 =====
  // fileHandles: FileSystemFileHandle[]（showDirectoryPicker 路径）或 File[]（降级路径）
  // dirHandle: 文件夹句柄（保留参数，目前未使用），可为 null
  // batchId: 导入时归属的批次 ID（必传），导入的视频自动加入该批次
  // 为每个视频保存 FileSystemFileHandle 到 IndexedDB，并记录 video._restoreKey
  function processBatchVideoFiles(project, fileHandles, dirHandle, batchId) {
    try {
      if (!fileHandles || fileHandles.length === 0) {
        showToast(tt('annotate.project.no_video_in_folder', '文件夹中未找到视频文件'));
        log('WARN', 'processBatchVideoFiles: no video files');
        return;
      }
      if (!project) {
        log('ERROR', 'processBatchVideoFiles: no project');
        return;
      }
      if (!batchId) {
        log('ERROR', 'processBatchVideoFiles: no batchId');
        showToast(tt('annotate.project.wizard_no_batch_first',
          '请先创建批次，再导入轨迹'));
        return;
      }

      var total = fileHandles.length;
      var completed = 0;
      log('IMPORT', 'processBatchVideoFiles: start, total=' + total + ' batchId=' + batchId);

      // 显示进度条
      if (dom.projectImportProgress) dom.projectImportProgress.removeAttribute('hidden');
      updateImportProgress(0, total);

      var idx = 0;
      function next() {
        try {
          if (idx >= total) {
            // 全部完成
            log('IMPORT', 'processBatchVideoFiles: done, completed=' + completed);
            if (dom.projectImportProgress) {
              setTimeout(function () {
                if (dom.projectImportProgress) dom.projectImportProgress.setAttribute('hidden', '');
              }, 1000);
            }
            saveProjects();
            // 重新渲染视频列表（项目详情面板内）
            if (state.currentProject && state.currentProject.id === project.id) {
              renderProjectDetail(project);
            }
            var doneMsg = tt('annotate.project.batch_import_done', '成功导入 {n} 条轨迹').replace('{n}', String(completed));
            showToast(doneMsg);
            return;
          }
          var item = fileHandles[idx];
          idx++;
          var fileHandle = null;
          // 判断是 FileSystemFileHandle 还是 File
          if (item && typeof item.getFile === 'function') {
            fileHandle = item;
          }
          // 获取 File 对象（FileSystemFileHandle.getFile() 或 File 本身）
          var getFilePromise = fileHandle ? fileHandle.getFile() : Promise.resolve(item);
          getFilePromise.then(function (file) {
            try {
              if (!file) {
                log('WARN', 'processBatchVideoFiles: null file at idx=' + (idx - 1));
                updateImportProgress(completed, total);
                next();
                return;
              }
              var videoId = genId('vid');
              var restoreKey = 'project_' + project.id + '_video_' + videoId;
              // 保存文件句柄到 IndexedDB（仅 FS Access 支持）；失败不阻塞导入
              var saveHandlePromise = (fileHandle && FS_ACCESS_SUPPORTED)
                ? fsSaveHandle(restoreKey, fileHandle).catch(function (err) {
                    log('WARN', 'processBatchVideoFiles: fsSaveHandle failed for ' + file.name + ': ' + (err && err.message || err));
                  })
                : Promise.resolve();
              saveHandlePromise.then(function () {
                try {
                  // 创建视频对象
                  var video = {
                    id: videoId,
                    file_name: file.name,
                    file_size: file.size,
                    thumbnail: DEFAULT_THUMBNAIL,
                    duration: 0,
                    resolution: [0, 0],
                    fps: 30,
                    num_frames: 0,
                    trajectory_index: '',
                    batch_id: batchId,    // 导入时自动归属选定批次
                    tags: {}
                  };
                  // 有句柄则记录 _restoreKey，预处理时可直接恢复
                  if (fileHandle) {
                    video._restoreKey = restoreKey;
                  }
                  project.videos.push(video);
                  // 同步把视频 ID 加入到批次的 video_ids 列表（去重）
                  addVideoIdToBatch(project, batchId, videoId);
                  completed++;
                  updateImportProgress(completed, total, file.name);
                  saveProjects();

                  log('IMPORT', 'imported: ' + file.name + ' batchId=' + batchId +
                    (fileHandle ? ' (with handle)' : ' (no handle)'));

                  // 异步检测视频元信息 + 生成缩略图
                  detectVideoMetaAndThumbnail(file, video, project, function () {
                    next();
                  });
                } catch (e) {
                  log('ERROR', 'processBatchVideoFiles inner failed: ' + (e.message || e));
                  updateImportProgress(completed, total);
                  next();
                }
              }).catch(function (err) {
                log('ERROR', 'processBatchVideoFiles saveHandle then failed: ' + (err && err.message || err));
                updateImportProgress(completed, total);
                next();
              });
            } catch (e) {
              log('ERROR', 'processBatchVideoFiles getFile callback failed: ' + (e.message || e));
              updateImportProgress(completed, total);
              next();
            }
          }).catch(function (err) {
            log('ERROR', 'processBatchVideoFiles getFile failed: ' + (err && err.message || err));
            updateImportProgress(completed, total);
            next();
          });
        } catch (e) {
          log('ERROR', 'processBatchVideoFiles next failed: ' + (e.message || e));
          updateImportProgress(completed, total);
          next();
        }
      }
      next();
    } catch (e) {
      log('ERROR', 'processBatchVideoFiles failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
    }
  }

  // ===== 单视频导入到项目（优先 showOpenFilePicker 保存句柄，降级到 input）=====
  // 用 showOpenFilePicker 代替 click(dom.projectVideoInput)，以便保存 FileSystemFileHandle
  // 流程改造：先选批次，再选文件
  function importSingleVideoToProject(project) {
    try {
      if (!project) {
        log('WARN', 'importSingleVideoToProject: no project');
        showToast(tt('annotate.project.no_current_project', '请先选择项目'));
        return;
      }
      // 校验批次
      var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
      if (batches.length === 0) {
        showToast(tt('annotate.project.wizard_no_batch_first',
          '请先创建批次，再导入轨迹'));
        // 跳转到批次面板
        var batchPanel = document.getElementById('projectBatchPanel');
        if (batchPanel) {
          var batchHeader = batchPanel.previousElementSibling;
          if (batchHeader && batchHeader.classList.contains('annotate-accordion-header') &&
              batchHeader.classList.contains('collapsed')) {
            try { batchHeader.click(); } catch (eClick) {}
          }
          try { batchPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          catch (eScroll) { batchPanel.scrollIntoView(); }
        }
        return;
      }
      // 弹批次选择
      promptSelectBatchForImport(project, batches, function (batchId) {
        try {
          startImportSingleWithBatch(project, batchId);
        } catch (e) {
          log('ERROR', 'importSingleVideoToProject startImportSingleWithBatch failed: ' + (e.message || e));
          showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
        }
      });
    } catch (e) {
      log('ERROR', 'importSingleVideoToProject failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
    }
  }

  // ===== 已选定批次的单视频导入流程 =====
  function startImportSingleWithBatch(project, batchId) {
    try {
      if (FS_ACCESS_SUPPORTED && typeof window.showOpenFilePicker === 'function') {
        log('IMPORT', 'startImportSingleWithBatch: using showOpenFilePicker, batchId=' + batchId);
        window.showOpenFilePicker({
          types: [{
            description: 'Video',
            accept: { 'video/*': ['.mp4', '.mov', '.avi', '.webm', '.mkv'] }
          }],
          multiple: false
        }).then(function (handles) {
          try {
            var handle = handles && handles[0];
            if (!handle) {
              log('WARN', 'startImportSingleWithBatch: no handle returned');
              return;
            }
            // 复用批量处理逻辑（单文件也是数组）
            processBatchVideoFiles(project, [handle], null, batchId);
          } catch (e) {
            log('ERROR', 'startImportSingleWithBatch handles callback failed: ' + (e.message || e));
          }
        }).catch(function (err) {
          if (err && err.name === 'AbortError') {
            log('IMPORT', 'startImportSingleWithBatch: user aborted');
            return;
          }
          log('ERROR', 'startImportSingleWithBatch: showOpenFilePicker failed: ' + (err && err.message || err));
          showToast(tt('annotate.err_load_failed', '选择文件失败: ' + (err && err.message || err)));
        });
      } else {
        // 降级到 <input type="file">（Firefox/Safari）
        // 注意：降级路径下，input 的 change 会走 handleProjectVideoImport，
        // 该函数本身已实现批次选择，但会丢失当前 batchId。
        // 为保证体验，这里使用一个临时 input 直接走 processBatchVideoFiles
        log('IMPORT', 'startImportSingleWithBatch: fallback to <input>, batchId=' + batchId);
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = false;
        input.accept = 'video/*';
        input.onchange = function () {
          try {
            var files = Array.prototype.slice.call(input.files || []);
            var videoFiles = files.filter(function (f) { return isVideoFile(f); });
            if (videoFiles.length === 0) {
              showToast(tt('annotate.err_unsupported_format', '不支持的格式，仅支持 MP4/MOV/AVI'));
              return;
            }
            processBatchVideoFiles(project, videoFiles, null, batchId);
          } catch (e) {
            log('ERROR', 'startImportSingleWithBatch fallback onchange failed: ' + (e.message || e));
            showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
          }
        };
        input.click();
      }
    } catch (e) {
      log('ERROR', 'startImportSingleWithBatch failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '导入视频失败: ') + (e.message || e));
    }
  }

  // ===== 更新导入进度条 =====
  function updateImportProgress(done, total, fileName) {
    try {
      if (dom.projectImportProgressFill) {
        var pct = total > 0 ? (done / total * 100) : 0;
        dom.projectImportProgressFill.style.width = pct + '%';
      }
      if (dom.projectImportProgressText) {
        var text = done + ' / ' + total;
        if (fileName) {
          text += ': ' + fileName;
        }
        dom.projectImportProgressText.textContent = text;
      }
    } catch (e) {
      log('WARN', 'updateImportProgress failed: ' + (e.message || e));
    }
  }

  // ===== 检测视频元信息 + 生成缩略图 =====
  // 通过临时 <video> 元素加载 ObjectURL，loadedmetadata 后取帧
  function detectVideoMetaAndThumbnail(file, videoObj, project, callback) {
    try {
      var url;
      try {
        url = URL.createObjectURL(file);
      } catch (e) {
        log('ERROR', 'detectVideoMetaAndThumbnail: createObjectURL failed: ' + (e.message || e));
        if (typeof callback === 'function') callback();
        return;
      }
      var v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.src = url;

      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch (e) {}
        if (typeof callback === 'function') callback();
      }

      var timeoutId = setTimeout(function () {
        log('WARN', 'detectVideoMetaAndThumbnail: timeout for ' + (file.name || 'unknown'));
        finish();
      }, 15000);

      v.addEventListener('loadedmetadata', function () {
        try {
          var w = v.videoWidth || 0;
          var h = v.videoHeight || 0;
          var dur = v.duration || 0;
          if (!isFinite(dur) || dur <= 0) dur = 0;
          videoObj.resolution = [w, h];
          videoObj.duration = dur;
          // fps 默认 30（无法可靠获取），num_frames = round(dur * fps)
          var fps = 30;
          videoObj.fps = fps;
          videoObj.num_frames = dur > 0 ? Math.round(dur * fps) : 0;
          log('VIDEO', 'metadata: ' + file.name + ' ' + w + 'x' + h + ' dur=' + dur + 's fps=' + fps + ' frames=' + videoObj.num_frames);
          saveProjects();

          // 生成缩略图：seek 到 1 秒或 duration/2
          var seekTime = dur > 1 ? 1 : (dur > 0 ? dur / 2 : 0);
          if (seekTime > 0 && w > 0 && h > 0) {
            try {
              v.currentTime = seekTime;
            } catch (eSeek) {
              log('WARN', 'detectVideoMetaAndThumbnail: seek failed: ' + (eSeek.message || eSeek));
              clearTimeout(timeoutId);
              finish();
              return;
            }
            v.addEventListener('seeked', function () {
              try {
                var canvas = document.createElement('canvas');
                // 限制缩略图最大宽度为 320
                var maxW = 320;
                var cw = w, ch = h;
                if (cw > maxW) {
                  ch = Math.round(h * (maxW / cw));
                  cw = maxW;
                }
                canvas.width = cw;
                canvas.height = ch;
                var ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(v, 0, 0, cw, ch);
                  try {
                    videoObj.thumbnail = canvas.toDataURL('image/jpeg', 0.7);
                  } catch (eData) {
                    log('WARN', 'detectVideoMetaAndThumbnail: toDataURL failed: ' + (eData.message || eData));
                    videoObj.thumbnail = DEFAULT_THUMBNAIL;
                  }
                }
                saveProjects();
                // 更新当前项目详情面板的视频列表（仅当此项目仍为当前项目时）
                if (state.currentProject && state.currentProject.id === project.id) {
                  // 不重新渲染整个面板，避免重置表单输入。仅更新视频列表区域
                  updateVideoListOnly(project);
                }
                clearTimeout(timeoutId);
                finish();
              } catch (e) {
                log('ERROR', 'detectVideoMetaAndThumbnail seeked handler failed: ' + (e.message || e));
                clearTimeout(timeoutId);
                finish();
              }
            }, { once: true });
          } else {
            // 时长太短或尺寸无效，用默认占位图
            videoObj.thumbnail = DEFAULT_THUMBNAIL;
            saveProjects();
            clearTimeout(timeoutId);
            finish();
          }
        } catch (e) {
          log('ERROR', 'detectVideoMetaAndThumbnail loadedmetadata failed: ' + (e.message || e));
          clearTimeout(timeoutId);
          finish();
        }
      });

      v.addEventListener('error', function () {
        log('WARN', 'detectVideoMetaAndThumbnail: video error event for ' + (file.name || 'unknown') + ', using defaults');
        // 失败时使用默认占位图，不阻断流程
        videoObj.thumbnail = DEFAULT_THUMBNAIL;
        saveProjects();
        clearTimeout(timeoutId);
        finish();
      });

      // 触发加载
      try { v.load(); } catch (e) {}
    } catch (e) {
      log('ERROR', 'detectVideoMetaAndThumbnail failed: ' + (e.message || e));
      if (typeof callback === 'function') callback();
    }
  }

  // ===== 仅更新视频列表区域（不重置表单） =====
  function updateVideoListOnly(project) {
    try {
      var panel = qs('projectVideosPanel');
      if (!panel) return;
      // 保留 actions 区，仅替换视频网格
      var grid = panel.querySelector('.annotate-video-grid');
      var empty = panel.querySelector('.annotate-project-empty-mini');
      if (grid) {
        var newHtml = renderVideoListHtml(project);
        // renderVideoListHtml 可能返回 empty 提示或 grid
        var tmp = document.createElement('div');
        tmp.innerHTML = newHtml;
        var newGrid = tmp.querySelector('.annotate-video-grid');
        var newEmpty = tmp.querySelector('.annotate-project-empty-mini');
        if (newGrid) {
          grid.parentNode.replaceChild(newGrid, grid);
        } else if (newEmpty && grid) {
          grid.parentNode.replaceChild(newEmpty, grid);
        }
      } else if (empty) {
        var newHtml2 = renderVideoListHtml(project);
        var tmp2 = document.createElement('div');
        tmp2.innerHTML = newHtml2;
        var newGrid2 = tmp2.querySelector('.annotate-video-grid');
        var newEmpty2 = tmp2.querySelector('.annotate-project-empty-mini');
        if (newGrid2) {
          empty.parentNode.replaceChild(newGrid2, empty);
        } else if (newEmpty2) {
          empty.parentNode.replaceChild(newEmpty2, empty);
        }
      }
      // 重新绑定视频列表事件
      bindVideoListEvents(project);
      // 更新计数
      var countEl = qs('projectVideosCount');
      if (countEl) {
        countEl.textContent = (Array.isArray(project.videos) ? project.videos.length : 0);
      }
    } catch (e) {
      log('ERROR', 'updateVideoListOnly failed: ' + (e.message || e));
    }
  }

  // ===== 绑定视频列表事件（删除/开始标注/加入批次） =====
  function bindVideoListEvents(project) {
    try {
      var panel = qs('projectVideosPanel');
      if (!panel) return;
      var cards = panel.querySelectorAll('.annotate-video-card');
      for (var i = 0; i < cards.length; i++) {
        (function (card) {
          var videoId = card.getAttribute('data-video-id');
          if (!videoId) return;
          // 开始标注按钮
          var annotateBtn = card.querySelector('[data-action="annotate"]');
          if (annotateBtn) {
            annotateBtn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                startAnnotateFromProject(project, videoId);
              } catch (err) {
                log('ERROR', 'annotate btn click failed: ' + (err.message || err));
              }
            });
          }
          // 删除按钮
          var deleteBtn = card.querySelector('[data-action="delete"]');
          if (deleteBtn) {
            deleteBtn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                deleteVideoFromProject(project, videoId);
              } catch (err) {
                log('ERROR', 'delete video btn click failed: ' + (err.message || err));
              }
            });
          }
          // 加入批次按钮
          var batchBtn = card.querySelector('[data-action="batch"]');
          if (batchBtn) {
            batchBtn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                showAddVideoToBatchModal(project, videoId);
              } catch (err) {
                log('ERROR', 'add to batch btn click failed: ' + (err.message || err));
              }
            });
          }
          // 标签编辑按钮
          var tagsBtn = card.querySelector('[data-action="tags"]');
          if (tagsBtn) {
            tagsBtn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                showTagsEditorModal(project, videoId);
              } catch (err) {
                log('ERROR', 'tags btn click failed: ' + (err.message || err));
              }
            });
          }
          // 预处理按钮
          var processBtn = card.querySelector('[data-action="process"]');
          if (processBtn) {
            processBtn.addEventListener('click', function (e) {
              try {
                e.stopPropagation();
                showProcessConfigModal(project, videoId, false);
              } catch (err) {
                log('ERROR', 'process btn click failed: ' + (err.message || err));
              }
            });
          }
          // checkbox 选中事件
          var cb = card.querySelector('.annotate-video-select-cb');
          if (cb) {
            cb.addEventListener('change', function (e) {
              try {
                if (cb.checked) {
                  selectedVideoIds.add(videoId);
                  card.classList.add('selected');
                } else {
                  selectedVideoIds.delete(videoId);
                  card.classList.remove('selected');
                }
                updateBatchToolbar();
              } catch (err) {
                log('ERROR', 'video checkbox change failed: ' + (err.message || err));
              }
            });
            cb.addEventListener('click', function (e) {
              e.stopPropagation();
            });
          }
        })(cards[i]);
      }

      // 全选按钮
      var selectAllBtn = qs('selectAllVideosBtn');
      if (selectAllBtn) {
        selectAllBtn.addEventListener('click', function () {
          try {
            var videos = (project && Array.isArray(project.videos)) ? project.videos : [];
            var allSelected = videos.length > 0 && videos.every(function (v) { return selectedVideoIds.has(v.id); });
            if (allSelected) {
              selectedVideoIds.clear();
            } else {
              for (var i = 0; i < videos.length; i++) {
                selectedVideoIds.add(videos[i].id);
              }
            }
            renderProjectDetail(project);
          } catch (e) {
            log('ERROR', 'select all failed: ' + (e.message || e));
          }
        });
      }

      // 批量加入批次按钮
      var batchAddBtn = qs('batchAddToBatchBtn');
      if (batchAddBtn) {
        batchAddBtn.addEventListener('click', function () {
          try {
            if (selectedVideoIds.size === 0) {
              showToast(tt('annotate.project.select_first', '请先选择视频'));
              return;
            }
            showBatchAddToBatchModal(project);
          } catch (e) {
            log('ERROR', 'batch add to batch failed: ' + (e.message || e));
          }
        });
      }

      // 批量预处理按钮
      var batchProcessBtn = qs('batchProcessBtn');
      if (batchProcessBtn) {
        batchProcessBtn.addEventListener('click', function () {
          try {
            if (selectedVideoIds.size === 0) {
              showToast(tt('annotate.project.select_first', '请先选择轨迹'));
              return;
            }
            showProcessConfigModal(project, null, true);
          } catch (e) {
            log('ERROR', 'batch process click failed: ' + (e.message || e));
          }
        });
      }

      // 批量删除按钮
      var batchDelBtn = qs('batchDeleteVideosBtn');
      if (batchDelBtn) {
        batchDelBtn.addEventListener('click', function () {
          try {
            if (selectedVideoIds.size === 0) {
              showToast(tt('annotate.project.select_first', '请先选择视频'));
              return;
            }
            showModal({
              title: tt('annotate.project.batch_delete', '删除选中'),
              body: '<p style="text-align:center;padding:var(--spacing-lg);">' +
                escapeHtml(tt('annotate.project.batch_delete_confirm', '确定删除选中的 {n} 条轨迹？').replace('{n}', selectedVideoIds.size)) +
                '</p>',
              confirmText: tt('annotate.modal_confirm', '确认'),
              cancelText: tt('annotate.modal_cancel', '取消'),
              onConfirm: function () {
                try {
                  var ids = Array.from(selectedVideoIds);
                  // Bug 3 修复：传 skipConfirm=true，避免循环时每个视频都弹一次确认
                  for (var i = 0; i < ids.length; i++) {
                    deleteVideoFromProject(project, ids[i], true);
                  }
                  selectedVideoIds.clear();
                  hideModal();
                  renderProjectDetail(project);
                  showToast(tt('annotate.project.batch_delete_done', '已删除 {n} 条轨迹').replace('{n}', ids.length), 'success');
                } catch (e) {
                  log('ERROR', 'batch delete confirm failed: ' + (e.message || e));
                  hideModal();
                }
                return true;
              }
            });
          } catch (e) {
            log('ERROR', 'batch delete failed: ' + (e.message || e));
          }
        });
      }

      // 取消选择按钮
      var clearSelBtn = qs('clearVideoSelectionBtn');
      if (clearSelBtn) {
        clearSelBtn.addEventListener('click', function () {
          selectedVideoIds.clear();
          renderProjectDetail(project);
        });
      }

      updateBatchToolbar();
    } catch (e) {
      log('ERROR', 'bindVideoListEvents failed: ' + (e.message || e));
    }
  }

  // ===== 更新批量操作栏 =====
  function updateBatchToolbar() {
    try {
      var toolbar = qs('videoBatchToolbar');
      var countEl = qs('selectedVideoCount');
      if (toolbar) {
        toolbar.style.display = selectedVideoIds.size > 0 ? '' : 'none';
      }
      if (countEl) {
        countEl.textContent = selectedVideoIds.size;
      }
    } catch (e) {
      log('ERROR', 'updateBatchToolbar failed: ' + (e.message || e));
    }
  }

  // ===== 批量加入批次弹窗 =====
  function showBatchAddToBatchModal(project) {
    try {
      var batches = project.batches || [];
      if (batches.length === 0) {
        showToast(tt('annotate.project.no_batch_first', '请先创建批次'));
        return;
      }
      var optionsHtml = '';
      for (var i = 0; i < batches.length; i++) {
        var b = batches[i];
        optionsHtml += '<option value="' + escapeHtml(b.id) + '">' +
          escapeHtml(b.id) + (b.name ? ' (' + escapeHtml(b.name) + ')' : '') +
          '</option>';
      }
      var body =
        '<div class="annotate-modal-form">' +
          '<p class="annotate-modal-form-hint">' +
            tt('annotate.project.batch_add_hint', '将选中的 {n} 个视频加入指定批次，系统自动分配轨迹编号（同批次内不重复）').replace('{n}', selectedVideoIds.size) +
          '</p>' +
          '<div class="annotate-form-field">' +
            '<label data-i18n="annotate.project.select_batch">选择批次</label>' +
            '<select id="batchAddToBatchSelect" class="annotate-input">' +
              '<option value="">-- ' + tt('annotate.project.select_batch_placeholder', '选择批次') + ' --</option>' +
              optionsHtml +
            '</select>' +
          '</div>' +
        '</div>';

      showModal({
        title: tt('annotate.project.batch_add_to_batch', '批量加入批次'),
        body: body,
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var select = qs('batchAddToBatchSelect');
            var batchId = select ? select.value : '';
            if (!batchId) {
              showToast(tt('annotate.project.select_batch_first', '请选择批次'));
              return false;
            }
            var ids = Array.from(selectedVideoIds);
            var successCount = 0;
            for (var i = 0; i < ids.length; i++) {
              try {
                addVideoToBatch(project, ids[i], batchId);
                successCount++;
              } catch (e) {
                log('ERROR', 'batch add video ' + ids[i] + ' failed: ' + (e.message || e));
              }
            }
            showToast(tt('annotate.project.batch_add_success', '成功加入 {n} 个视频到批次').replace('{n}', successCount), 'success');
            selectedVideoIds.clear();
            hideModal();
            renderProjectDetail(project);
          } catch (e) {
            log('ERROR', 'batch add confirm failed: ' + (e.message || e));
            hideModal();
          }
          return true;
        }
      });
    } catch (e) {
      log('ERROR', 'showBatchAddToBatchModal failed: ' + (e.message || e));
    }
  }

  // ===== 标签编辑弹窗（单条轨迹的自定义键值对标签） =====
  function showTagsEditorModal(project, videoId) {
    try {
      var video = findVideoInProject(project, videoId);
      if (!video) {
        log('WARN', 'showTagsEditorModal: video not found, id=' + videoId);
        showToast(tt('annotate.project.video_not_found', '视频未找到'));
        return;
      }
      if (!video.tags || typeof video.tags !== 'object') {
        video.tags = {};
      }
      var tags = video.tags;
      var bodyHtml = '<div class="annotate-tag-editor" id="tagEditor">' +
        '<div id="tagEditorRows"></div>' +
        '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm annotate-tag-add-btn" id="tagAddBtn">' +
          '<span class="material-symbols-outlined">add</span>' +
          '<span>' + tt('annotate.project.add_tag', '添加标签') + '</span>' +
        '</button>' +
      '</div>';

      showModal({
        title: tt('annotate.project.edit_tags', '编辑标签'),
        body: bodyHtml,
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var rows = qsa('#tagEditorRows .annotate-tag-row');
            var newTags = {};
            for (var i = 0; i < rows.length; i++) {
              var kInput = rows[i].querySelector('.annotate-tag-key');
              var vInput = rows[i].querySelector('.annotate-tag-value');
              var k = kInput ? kInput.value.trim() : '';
              var val = vInput ? vInput.value : '';
              if (k) {
                newTags[k] = val;
              }
            }
            video.tags = newTags;
            saveProjects();
            renderProjectDetail(project);
            hideModal();
            log('TAGS', 'tags saved for video ' + videoId + ', count=' + Object.keys(newTags).length);
          } catch (e) {
            log('ERROR', 'tags editor onConfirm failed: ' + (e.message || e));
            hideModal();
          }
          return true;
        }
      });

      // 渲染单行标签（key + value + 删除按钮）
      var rowsContainer = qs('tagEditorRows');
      function renderRow(k, v) {
        try {
          var row = document.createElement('div');
          row.className = 'annotate-tag-row';
          row.innerHTML =
            '<input type="text" class="annotate-input annotate-tag-key" placeholder="' +
              escapeHtml(tt('annotate.project.tag_key', '键')) + '" value="' + escapeHtml(k || '') + '">' +
            '<input type="text" class="annotate-input annotate-tag-value" placeholder="' +
              escapeHtml(tt('annotate.project.tag_value', '值')) + '" value="' + escapeHtml(v == null ? '' : String(v)) + '">' +
            '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm annotate-tag-del-btn">' +
              '<span class="material-symbols-outlined">delete</span>' +
            '</button>';
          var delBtn = row.querySelector('.annotate-tag-del-btn');
          if (delBtn) {
            delBtn.addEventListener('click', function () {
              try {
                row.remove();
              } catch (err) {
                log('ERROR', 'tag row delete failed: ' + (err.message || err));
              }
            });
          }
          if (rowsContainer) rowsContainer.appendChild(row);
        } catch (e) {
          log('ERROR', 'renderRow failed: ' + (e.message || e));
        }
      }

      // 渲染初始标签行
      if (rowsContainer) {
        var keys = Object.keys(tags);
        if (keys.length === 0) {
          renderRow('', '');
        } else {
          for (var i = 0; i < keys.length; i++) {
            renderRow(keys[i], tags[keys[i]]);
          }
        }
      }

      // 添加标签按钮
      var addBtn = qs('tagAddBtn');
      if (addBtn) {
        addBtn.addEventListener('click', function () {
          try {
            renderRow('', '');
          } catch (e) {
            log('ERROR', 'tag add btn failed: ' + (e.message || e));
          }
        });
      }
    } catch (e) {
      log('ERROR', 'showTagsEditorModal failed: ' + (e.message || e));
    }
  }

  // ===== 删除视频（二次确认） =====
  function deleteVideoFromProject(project, videoId, skipConfirm) {
    try {
      var video = findVideoInProject(project, videoId);
      if (!video) {
        log('WARN', 'deleteVideoFromProject: video not found, id=' + videoId);
        return;
      }

      // 实际执行删除的内部函数（复用，避免重复代码）
      function doDelete() {
        try {
          var idx = -1;
          for (var i = 0; i < project.videos.length; i++) {
            if (project.videos[i] && project.videos[i].id === videoId) {
              idx = i; break;
            }
          }
          if (idx < 0) {
            log('WARN', 'deleteVideoFromProject: video already removed, id=' + videoId);
            return;
          }

          // Bug 1 修复：从所有批次的 video_ids 中移除该视频
          var removedFromBatches = removeVideoIdFromAllBatches(project, videoId);
          if (removedFromBatches > 0) {
            log('VIDEO', 'deleteVideoFromProject: removed from ' + removedFromBatches + ' batch(es)');
          }

          // Bug 2 修复：清理视频的文件句柄（IndexedDB）
          if (video._restoreKey && FS_ACCESS_SUPPORTED) {
            try {
              fsDeleteHandle(video._restoreKey).catch(function (err) {
                log('WARN', 'deleteVideoFromProject: fsDeleteHandle failed, key=' + video._restoreKey +
                  ' err=' + (err.message || err));
              });
            } catch (e2) {
              log('WARN', 'deleteVideoFromProject: fsDeleteHandle exception: ' + (e2.message || e2));
            }
          }

          // 删除批次工作目录中的预处理文件（如果存在），不阻塞删除流程
          if (video.processed_file && video.batch_id) {
            try {
              deleteProcessedFileFromWorkDir(project.id, video.batch_id, video.processed_file)
                .catch(function (err) {
                  log('WARN', 'deleteProcessedFileFromWorkDir failed: ' + (err.message || err));
                });
            } catch (e) {
              log('WARN', 'deleteProcessedFileFromWorkDir exception: ' + (e.message || e));
            }
          }

          project.videos.splice(idx, 1);
          saveProjects();
          updateVideoListOnly(project);
          // 刷新批次面板（批次卡片内的视频列表也需要更新）
          if (state.currentProject && state.currentProject.id === project.id) {
            refreshBatchPanel(project);
          }
          showToast(tt('annotate.project.video_deleted', '视频已删除'));
          log('VIDEO', 'deleteVideoFromProject: deleted id=' + videoId);
        } catch (e) {
          log('ERROR', 'deleteVideoFromProject doDelete failed: ' + (e.message || e));
        }
      }

      // 批量删除场景跳过二次确认（已由调用方确认过）
      if (skipConfirm) {
        doDelete();
        return;
      }

      // 单个删除：弹二次确认
      showModal({
        title: tt('annotate.project.delete_video_title', '删除视频'),
        body: '<p>' + tt('annotate.project.delete_video_body',
          '确认删除视频「{name}」？此操作不可撤销。').replace('{name}', escapeHtml(video.file_name)) + '</p>',
        confirmText: tt('annotate.project.delete_btn', '删除'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            doDelete();
            hideModal();
          } catch (e) {
            log('ERROR', 'deleteVideoFromProject onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'deleteVideoFromProject failed: ' + (e.message || e));
    }
  }

  // ==========================================================================
  // 视频预处理（去畸变 / 画质统一 / 分辨率对齐 / 帧率标准化）
  // ==========================================================================

  // 预处理进度浮层句柄
  var processProgressOverlay = null;
  var processCancelFn = null;

  // ===== 预处理配置弹窗 =====
  // project: 当前项目；videoId: 单个视频 ID（批量时为 null）；isBatch: 是否批量
  function showProcessConfigModal(project, videoId, isBatch) {
    try {
      if (!project) {
        showToast(tt('annotate.project.no_current_project', '请先选择项目'));
        return;
      }
      // 预处理前检查：必须先设置工作目录
      if (!project.work_dir_name) {
        log('WARN', 'showProcessConfigModal: work_dir not set, project=' + project.id);
        showToast(tt('annotate.project.work_dir_required', '请先设置工作目录'));
        return;
      }
      var dc = project.device_config || createDefaultDeviceConfig();
      var intrinsic = dc.intrinsic || { fx: 0, fy: 0, cx: 0, cy: 0, distortion: [0, 0, 0, 0, 0] };
      var distArr = Array.isArray(intrinsic.distortion) ? intrinsic.distortion.slice() : [0, 0, 0, 0, 0];
      while (distArr.length < 5) distArr.push(0);
      // distortion 数组顺序: [k1, k2, p1, p2, k3]
      var hasIntrinsic = (intrinsic.fx || intrinsic.fy || intrinsic.cx || intrinsic.cy);

      // 推断目标分辨率：从内参 cx,cy 推断（2*cx x 2*cy）
      var autoW = (intrinsic.cx && intrinsic.cx > 0) ? Math.round(intrinsic.cx * 2) : 0;
      var autoH = (intrinsic.cy && intrinsic.cy > 0) ? Math.round(intrinsic.cy * 2) : 0;

      var html =
        '<div class="annotate-process-config">' +
          // 去畸变
          '<div class="annotate-process-item">' +
            '<div class="annotate-process-item-header">' +
              '<label class="annotate-switch">' +
                '<input type="checkbox" id="procUndistort" checked>' +
                '<span class="annotate-switch-slider"></span>' +
              '</label>' +
              '<span class="material-symbols-outlined">lens_blur</span>' +
              '<strong data-i18n="annotate.project.process_undistort">' + tt('annotate.project.process_undistort', '去畸变') + '</strong>' +
            '</div>' +
            '<div class="annotate-process-item-body">' +
              (hasIntrinsic
                ? '<span class="annotate-process-hint">fx=' + escapeHtml(String(intrinsic.fx)) +
                  ' fy=' + escapeHtml(String(intrinsic.fy)) +
                  ' cx=' + escapeHtml(String(intrinsic.cx)) +
                  ' cy=' + escapeHtml(String(intrinsic.cy)) + '</span>'
                : '<span class="annotate-process-hint annotate-process-warn">' +
                    tt('annotate.project.process_no_intrinsic', '未配置内参，去畸变将跳过') + '</span>') +
              '<span class="annotate-process-hint">k1=' + escapeHtml(String(distArr[0])) +
              ' k2=' + escapeHtml(String(distArr[1])) +
              ' p1=' + escapeHtml(String(distArr[2])) +
              ' p2=' + escapeHtml(String(distArr[3])) +
              ' k3=' + escapeHtml(String(distArr[4])) + '</span>' +
            '</div>' +
          '</div>' +
          // 画质统一
          '<div class="annotate-process-item">' +
            '<div class="annotate-process-item-header">' +
              '<label class="annotate-switch">' +
                '<input type="checkbox" id="procQuality" checked>' +
                '<span class="annotate-switch-slider"></span>' +
              '</label>' +
              '<span class="material-symbols-outlined">tune</span>' +
              '<strong data-i18n="annotate.project.process_quality">' + tt('annotate.project.process_quality', '画质统一') + '</strong>' +
            '</div>' +
            '<div class="annotate-process-item-body">' +
              '<label class="annotate-process-inline-label">' +
                tt('annotate.project.process_quality_label', 'JPEG 质量') +
                ' <input type="range" id="procQualityVal" min="85" max="100" value="92" class="annotate-process-range">' +
                ' <span id="procQualityDisplay">92</span>' +
              '</label>' +
            '</div>' +
          '</div>' +
          // 分辨率对齐
          '<div class="annotate-process-item">' +
            '<div class="annotate-process-item-header">' +
              '<label class="annotate-switch">' +
                '<input type="checkbox" id="procResize"' + (autoW && autoH ? ' checked' : '') + '>' +
                '<span class="annotate-switch-slider"></span>' +
              '</label>' +
              '<span class="material-symbols-outlined">aspect_ratio</span>' +
              '<strong data-i18n="annotate.project.process_resize">' + tt('annotate.project.process_resize', '分辨率对齐') + '</strong>' +
            '</div>' +
            '<div class="annotate-process-item-body">' +
              '<label class="annotate-process-inline-label">' +
                tt('annotate.project.process_target_res', '目标分辨率') +
                ' <input type="number" id="procResW" class="annotate-input annotate-input-sm" style="width:80px;" value="' + (autoW || 1280) + '" min="1"> ' +
                ' × <input type="number" id="procResH" class="annotate-input annotate-input-sm" style="width:80px;" value="' + (autoH || 720) + '" min="1">' +
              '</label>' +
            '</div>' +
          '</div>' +
          // 帧率标准化
          '<div class="annotate-process-item">' +
            '<div class="annotate-process-item-header">' +
              '<label class="annotate-switch">' +
                '<input type="checkbox" id="procFps" checked>' +
                '<span class="annotate-switch-slider"></span>' +
              '</label>' +
              '<span class="material-symbols-outlined">onset_video</span>' +
              '<strong data-i18n="annotate.project.process_fps">' + tt('annotate.project.process_fps', '帧率标准化') + '</strong>' +
            '</div>' +
            '<div class="annotate-process-item-body">' +
              '<label class="annotate-process-inline-label">' +
                tt('annotate.project.process_target_fps', '目标 FPS') +
                ' <input type="number" id="procFpsVal" class="annotate-input annotate-input-sm" style="width:80px;" value="30" min="1" max="120">' +
              '</label>' +
              '<label class="annotate-process-inline-label">' +
                tt('annotate.project.process_resample_mode', '重采样') +
                ' <select id="procResampleMode" class="annotate-input annotate-input-sm">' +
                  '<option value="drop" data-i18n="annotate.project.process_resample_drop">' + tt('annotate.project.process_resample_drop', '丢弃') + '</option>' +
                  '<option value="interpolate" data-i18n="annotate.project.process_resample_interp">' + tt('annotate.project.process_resample_interp', '插帧') + '</option>' +
                '</select>' +
              '</label>' +
            '</div>' +
          '</div>' +
          (isBatch
            ? '<p class="annotate-process-hint">' +
                tt('annotate.project.batch_process_hint', '将对选中的 {n} 条轨迹依次执行预处理').replace('{n}', String(selectedVideoIds.size)) +
              '</p>'
            : '') +
        '</div>';

      showModal({
        title: isBatch
          ? tt('annotate.project.batch_process', '批量预处理')
          : tt('annotate.project.process', '预处理'),
        body: html,
        confirmText: tt('annotate.project.process_start', '开始预处理'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            // 收集配置
            var procUndistort = !!document.getElementById('procUndistort').checked;
            var procQuality = !!document.getElementById('procQuality').checked;
            var procQualityVal = parseInt(document.getElementById('procQualityVal').value, 10) || 92;
            var procResize = !!document.getElementById('procResize').checked;
            var procResW = parseInt(document.getElementById('procResW').value, 10) || 0;
            var procResH = parseInt(document.getElementById('procResH').value, 10) || 0;
            var procFps = !!document.getElementById('procFps').checked;
            var procFpsVal = parseInt(document.getElementById('procFpsVal').value, 10) || 30;
            var procResampleMode = document.getElementById('procResampleMode').value || 'drop';

            // 构造 intrinsic / distortion（仅当 undistort 开启且有内参时）
            var procIntrinsic = null;
            var procDistortion = null;
            if (procUndistort && hasIntrinsic) {
              procIntrinsic = { fx: intrinsic.fx, fy: intrinsic.fy, cx: intrinsic.cx, cy: intrinsic.cy };
              procDistortion = {
                k1: distArr[0] || 0,
                k2: distArr[1] || 0,
                p1: distArr[2] || 0,
                p2: distArr[3] || 0,
                k3: distArr[4] || 0
              };
            }

            var config = {
              undistort: procUndistort,
              intrinsic: procIntrinsic,
              distortion: procDistortion,
              quality: procQuality ? procQualityVal : null,
              resolution: procResize ? [procResW, procResH] : null,
              fps: procFps ? procFpsVal : 30,
              resample_mode: procResampleMode
            };

            log('PROCESS', 'config: ' + JSON.stringify({
              undistort: config.undistort, quality: config.quality,
              resolution: config.resolution, fps: config.fps, resample_mode: config.resample_mode
            }));

            hideModal();

            // 启动处理
            if (isBatch) {
              var ids = Array.from(selectedVideoIds);
              runBatchProcess(project, ids, config);
            } else {
              var video = findVideoInProject(project, videoId);
              if (!video) {
                showToast(tt('annotate.project.video_not_found', '视频未找到'));
                return;
              }
              runProcessForVideo(project, video, config);
            }
          } catch (e) {
            log('ERROR', 'process config confirm failed: ' + (e.message || e));
            hideModal();
            showToast(tt('annotate.project.process_start_failed', '启动预处理失败: ') + (e.message || e));
          }
        }
      });

      // 质量滑块实时显示
      setTimeout(function () {
        try {
          var qv = document.getElementById('procQualityVal');
          var qd = document.getElementById('procQualityDisplay');
          if (qv && qd) {
            qv.addEventListener('input', function () { qd.textContent = qv.value; });
          }
        } catch (e) {}
      }, 50);
    } catch (e) {
      log('ERROR', 'showProcessConfigModal failed: ' + (e.message || e));
      showToast(tt('annotate.project.process_config_failed', '打开预处理配置失败: ') + (e.message || e));
    }
  }

  // ===== 预处理进度浮层 =====
  function showProcessProgressModal(title, current, total) {
    try {
      hideProcessProgressModal();
      var overlay = document.createElement('div');
      overlay.className = 'annotate-process-overlay';
      overlay.innerHTML =
        '<div class="annotate-process-progress-card">' +
          '<div class="annotate-process-progress-header">' +
            '<span class="material-symbols-outlined">auto_fix_high</span>' +
            '<span class="annotate-process-progress-title">' + escapeHtml(title || tt('annotate.project.process', '预处理')) + '</span>' +
          '</div>' +
          '<div class="annotate-progress-bar">' +
            '<div class="annotate-progress-bar-fill" id="procProgressFill" style="width:0%"></div>' +
          '</div>' +
          '<div class="annotate-progress-info" id="procProgressInfo">' +
            (current || 0) + ' / ' + (total || 0) +
          '</div>' +
          '<div class="annotate-process-progress-status" id="procProgressStatus"></div>' +
          '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm" id="procCancelBtn">' +
            '<span class="material-symbols-outlined">cancel</span>' +
            '<span data-i18n="annotate.project.process_cancel">' + tt('annotate.project.process_cancel', '取消') + '</span>' +
          '</button>' +
        '</div>';
      document.body.appendChild(overlay);
      processProgressOverlay = overlay;

      var cancelBtn = overlay.querySelector('#procCancelBtn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', function () {
          try {
            if (typeof processCancelFn === 'function') {
              processCancelFn();
            }
            hideProcessProgressModal();
            showToast(tt('annotate.project.process_cancelled', '已取消预处理'));
          } catch (e) {
            log('ERROR', 'process cancel click failed: ' + (e.message || e));
          }
        });
      }
      log('PROCESS', 'progress modal shown: ' + title);
    } catch (e) {
      log('ERROR', 'showProcessProgressModal failed: ' + (e.message || e));
    }
  }

  function updateProcessProgress(current, total, statusText) {
    try {
      if (!processProgressOverlay) return;
      var fill = processProgressOverlay.querySelector('#procProgressFill');
      var info = processProgressOverlay.querySelector('#procProgressInfo');
      var status = processProgressOverlay.querySelector('#procProgressStatus');
      if (fill) {
        var pct = total > 0 ? (current / total * 100) : 0;
        fill.style.width = pct + '%';
      }
      if (info) {
        info.textContent = current + ' / ' + total;
      }
      if (status && statusText) {
        status.textContent = statusText;
      }
    } catch (e) {
      log('WARN', 'updateProcessProgress failed: ' + (e.message || e));
    }
  }

  function hideProcessProgressModal() {
    try {
      if (processProgressOverlay && processProgressOverlay.parentNode) {
        processProgressOverlay.parentNode.removeChild(processProgressOverlay);
      }
      processProgressOverlay = null;
      processCancelFn = null;
    } catch (e) {
      log('WARN', 'hideProcessProgressModal failed: ' + (e.message || e));
    }
  }

  // ===== 获取视频 File（用于预处理）=====
  // 优先从 FS Access 恢复；失败则提示用户重新选择
  function getVideoFileForProcessing(project, video) {
    return new Promise(function (resolve, reject) {
      try {
        if (!project || !video) {
          reject(new Error('invalid project/video'));
          return;
        }
        var restoreKey = video._restoreKey || ('project_' + project.id + '_video_' + video.id);
        if (FS_ACCESS_SUPPORTED) {
          log('PROCESS', 'getVideoFile: restoring handle, key=' + restoreKey);
          fsLoadHandle(restoreKey).then(function (handle) {
            if (!handle) {
              // 恢复失败，弹文件选择器让用户重新选择
              log('PROCESS', 'no file handle, fallback to file picker');
              promptSelectVideoFile(video, resolve, reject);
              return;
            }
            return fsHandleToFile(handle).then(function (file) {
              if (!file) {
                // 权限失败，弹文件选择器
                log('PROCESS', 'handle to file failed, fallback to file picker');
                promptSelectVideoFile(video, resolve, reject);
                return;
              }
              log('PROCESS', 'getVideoFile: restored ' + file.name);
              resolve(file);
            });
          }).catch(function (err) {
            // 恢复异常，弹文件选择器
            log('PROCESS', 'restore failed: ' + (err.message || err) + ', fallback to file picker');
            promptSelectVideoFile(video, resolve, reject);
          });
        } else {
          // 不支持 FS Access：直接弹文件选择器
          log('PROCESS', 'FS Access unsupported, fallback to file picker');
          promptSelectVideoFile(video, resolve, reject);
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  // 弹文件选择器让用户重新选择视频文件（用于预处理）
  function promptSelectVideoFile(video, resolve, reject) {
    try {
      // 先弹提示，告诉用户为什么需要选择文件
      var tipHtml =
        '<div style="text-align:center;padding:16px 8px;">' +
          '<div style="font-size:48px;margin-bottom:8px;">📁</div>' +
          '<p style="font-size:14px;color:var(--color-on-surface);margin:8px 0;">' +
            tt('annotate.project.process_select_tip',
              '预处理需要读取原始视频文件。<br>请选择你之前导入的视频文件（{name}）').replace('{name}', video.file_name || '') +
          '</p>' +
          '<p style="font-size:12px;color:var(--color-on-surface-variant);margin:8px 0;">' +
            tt('annotate.project.process_select_sub',
              '原始视频不会被修改，预处理后会生成新的视频文件') +
          '</p>' +
        '</div>';
      showModal({
        title: tt('annotate.project.process_select_title', '请选择视频文件'),
        body: tipHtml,
        confirmText: tt('annotate.project.process_select_btn', '选择文件'),
        cancelText: tt('common.cancel', '取消'),
        onConfirm: function () {
          hideModal();
          // 关闭提示弹窗后，再弹文件选择器
          setTimeout(function () {
            doSelectFile(video, resolve, reject);
          }, 100);
        },
        onCancel: function () {
          reject(new Error('user_cancelled'));
        }
      });
    } catch (e) {
      reject(e);
    }
  }

  // 实际弹文件选择器
  function doSelectFile(video, resolve, reject) {
    try {
      // 优先使用 FS Access API（Chrome/Edge），选择后保存句柄，下次不需要重新选
      if (FS_ACCESS_SUPPORTED && typeof window.showOpenFilePicker === 'function') {
        window.showOpenFilePicker({
          types: [{
            description: 'Video',
            accept: { 'video/*': ['.mp4', '.mov', '.avi', '.webm', '.mkv'] }
          }],
          multiple: false
        }).then(function (handles) {
          var handle = handles && handles[0];
          if (!handle) {
            reject(new Error('user_cancelled'));
            return;
          }
          // 保存句柄到 IndexedDB，下次预处理可以直接恢复
          var restoreKey = video._restoreKey || ('project_' + (state.currentProject && state.currentProject.id) + '_video_' + video.id);
          fsSaveHandle(restoreKey, handle).then(function () {
            log('PROCESS', 'file handle saved for key=' + restoreKey);
            return handle.getFile();
          }).then(function (file) {
            log('PROCESS', 'user selected file (FS Access): ' + file.name);
            resolve(file);
          }).catch(function (err) {
            reject(err);
          });
        }).catch(function (err) {
          // 用户取消或权限拒绝
          var msg = err && err.message ? err.message : String(err);
          if (msg.indexOf('aborted') !== -1 || msg.indexOf('Abort') !== -1) {
            reject(new Error('user_cancelled'));
          } else {
            reject(err);
          }
        });
      } else {
        // 降级到普通 <input type="file">（Firefox/Safari）
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/*,.mp4,.mov,.avi,.webm';
        input.style.display = 'none';
        input.onchange = function (e) {
          try {
            var file = e.target.files && e.target.files[0];
            document.body.removeChild(input);
            if (!file) {
              reject(new Error('user_cancelled'));
              return;
            }
            log('PROCESS', 'user selected file (input): ' + file.name);
            resolve(file);
          } catch (err) {
            try { document.body.removeChild(input); } catch (_) {}
            reject(err);
          }
        };
        document.body.appendChild(input);
        input.click();
      }
    } catch (e) {
      reject(e);
    }
  }

  // ===== 创建隐藏 video 元素并加载 File =====
  function createHiddenVideoElement(file, onReady, onError) {
    try {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      // 注意：不能用 display:none，某些浏览器对不可见元素不触发 seeked
      v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = url;
      document.body.appendChild(v);

      var cleanup = function () {
        try { URL.revokeObjectURL(url); } catch (_) {}
        try { if (v.parentNode) v.parentNode.removeChild(v); } catch (_) {}
      };

      var ready = false;
      // 等 canplay（readyState >= 2），确保可以 seek
      v.oncanplay = function () {
        if (ready) return;
        ready = true;
        log('PROCESS', 'hidden video canplay: ' + v.videoWidth + 'x' + v.videoHeight + ' dur=' + v.duration + ' readyState=' + v.readyState);
        // 确保可以 seek
        try {
          v.currentTime = 0.001;
          v.onseeked = function () {
            v.onseeked = null;
            onReady(v, url, cleanup);
          };
          // 超时兜底
          setTimeout(function () {
            if (!v.onseeked) return;
            v.onseeked = null;
            log('WARN', 'initial seek timeout, proceeding anyway');
            onReady(v, url, cleanup);
          }, 1000);
        } catch (e) {
          log('WARN', 'initial seek failed, proceeding anyway: ' + (e.message || e));
          onReady(v, url, cleanup);
        }
      };
      v.onerror = function () {
        cleanup();
        if (typeof onError === 'function') onError(new Error('hidden video load error'));
      };
      // 如果 readyState 已经 >= 2，直接触发
      if (v.readyState >= 2) {
        v.oncanplay();
      }
      // 超时兜底：5 秒后如果还没 canplay，强制开始
      setTimeout(function () {
        if (ready) return;
        ready = true;
        log('WARN', 'canplay timeout, proceeding anyway. readyState=' + v.readyState);
        onReady(v, url, cleanup);
      }, 5000);
      v.load();
    } catch (e) {
      if (typeof onError === 'function') onError(e);
    }
  }

  // ===== 执行单个视频预处理 =====
  function runProcessForVideo(project, video, config) {
    try {
      // 先获取文件，再显示进度弹窗（避免先显示进度又弹文件选择）
      log('PROCESS', 'getting video file for processing...');
      getVideoFileForProcessing(project, video).then(function (file) {
        try {
          // 文件获取成功，显示进度弹窗
          showProcessProgressModal(
            tt('annotate.project.process_progress_title', '预处理: {name}').replace('{name}', video.file_name || ''),
            0, 0
          );
          createHiddenVideoElement(file, function (vEl, url, cleanup) {
            try {
              // 设置取消函数
              processCancelFn = function () {
                cleanup();
                log('PROCESS', 'cancelled by user');
              };

              var callbacks = {
                onProgress: function (frame, total) {
                  updateProcessProgress(frame, total, video.file_name || '');
                },
                onComplete: function (result) {
                  try {
                    cleanup();
                    hideProcessProgressModal();
                    onProcessComplete(video.id, result, config);
                  } catch (e) {
                    log('ERROR', 'processVideo onComplete wrapper failed: ' + (e.message || e));
                    hideProcessProgressModal();
                    showToast(tt('annotate.project.process_failed', '预处理失败: ') + (e.message || e));
                  }
                },
                onError: function (err) {
                  try {
                    cleanup();
                    hideProcessProgressModal();
                    log('ERROR', 'processVideo onError: ' + (err.message || err));
                    showToast(tt('annotate.project.process_failed', '预处理失败: ') + (err.message || err));
                  } catch (e) {}
                }
              };

              // 检查 MediaRecorder 支持（提前给出友好提示）
              if (typeof MediaRecorder === 'undefined') {
                cleanup();
                hideProcessProgressModal();
                showToast(tt('annotate.project.process_no_recorder',
                  '浏览器不支持视频录制，请使用 Chrome/Edge'));
                return;
              }

              var cancelFn = window.AIX_ANNOTATE_PROCESS.processVideo(vEl, config, callbacks);
              processCancelFn = function () {
                cleanup();
                if (typeof cancelFn === 'function') cancelFn();
                log('PROCESS', 'cancelled by user (recorder)');
              };
            } catch (e) {
              cleanup();
              hideProcessProgressModal();
              showToast(tt('annotate.project.process_failed', '预处理失败: ') + (e.message || e));
            }
          }, function (err) {
            hideProcessProgressModal();
            showToast(tt('annotate.project.process_load_failed', '加载视频文件失败，请重新选择文件: ') + (err.message || err));
            log('ERROR', 'createHiddenVideoElement failed: ' + (err.message || err));
          });
        } catch (e) {
          hideProcessProgressModal();
          showToast(tt('annotate.project.process_failed', '预处理失败: ') + (e.message || e));
        }
      }).catch(function (err) {
        hideProcessProgressModal();
        var msg = err && err.message ? err.message : String(err);
        if (msg === 'user_cancelled') {
          // 用户取消选择，不显示错误
          log('PROCESS', 'user cancelled file selection');
        } else if (msg === 'no_file_handle' || msg === 'fs_access_unsupported' || msg === 'permission_denied_or_unavailable') {
          showToast(tt('annotate.project.process_reselect',
            '无法恢复视频文件，请先进入该视频标注并重新选择文件后再预处理'));
        } else {
          showToast(tt('annotate.project.process_failed', '预处理失败: ') + msg);
        }
        log('ERROR', 'getVideoFileForProcessing failed: ' + msg);
      });
    } catch (e) {
      hideProcessProgressModal();
      log('ERROR', 'runProcessForVideo failed: ' + (e.message || e));
      showToast(tt('annotate.project.process_failed', '预处理失败: ') + (e.message || e));
    }
  }

  // ===== 批量预处理 =====
  function runBatchProcess(project, videoIds, config) {
    try {
      if (!videoIds || videoIds.length === 0) {
        showToast(tt('annotate.project.select_first', '请先选择轨迹'));
        return;
      }
      var idx = 0;
      var failed = 0;
      var total = videoIds.length;

      function processNext() {
        try {
          if (idx >= total) {
            hideProcessProgressModal();
            var doneMsg = tt('annotate.project.batch_process_done', '批量预处理完成：成功 {ok}，失败 {fail}')
              .replace('{ok}', String(total - failed)).replace('{fail}', String(failed));
            showToast(doneMsg);
            log('PROCESS', 'batch done: ok=' + (total - failed) + ' fail=' + failed);
            return;
          }
          var vid = videoIds[idx];
          var video = findVideoInProject(project, vid);
          if (!video) {
            log('WARN', 'batch: video not found, skip id=' + vid);
            failed++;
            idx++;
            processNext();
            return;
          }
          log('PROCESS', 'batch: processing ' + (idx + 1) + '/' + total + ' id=' + vid);

          // 先获取文件，再显示进度弹窗（避免先弹进度再弹文件选择）
          getVideoFileForProcessing(project, video).then(function (file) {
            // 文件就绪后再显示进度弹窗
            showProcessProgressModal(
              tt('annotate.project.batch_progress_title', '批量预处理 ({i}/{n}): {name}')
                .replace('{i}', String(idx + 1)).replace('{n}', String(total))
                .replace('{name}', video.file_name || ''),
              0, 0
            );
            createHiddenVideoElement(file, function (vEl, url, cleanup) {
              try {
                processCancelFn = function () { cleanup(); };
                var callbacks = {
                  onProgress: function (frame, ftotal) {
                    updateProcessProgress(frame, ftotal,
                      (idx + 1) + '/' + total + ' - ' + (video.file_name || ''));
                  },
                  onComplete: function (result) {
                    try {
                      cleanup();
                      // 必须等待 onProcessComplete 完成（写入 processed_file + 重新渲染）后
                      // 再处理下一个视频，否则会出现"只标记了一个已预处理"的问题
                      Promise.resolve(onProcessComplete(video.id, result, config)).then(function () {
                        idx++;
                        processNext();
                      }).catch(function (e) {
                        log('ERROR', 'batch onComplete async failed: ' + (e.message || e));
                        failed++;
                        idx++;
                        processNext();
                      });
                    } catch (e) {
                      log('ERROR', 'batch onComplete failed: ' + (e.message || e));
                      failed++;
                      idx++;
                      processNext();
                    }
                  },
                  onError: function (err) {
                    cleanup();
                    log('ERROR', 'batch processVideo error: ' + (err.message || err));
                    failed++;
                    idx++;
                    processNext();
                  }
                };
                if (typeof MediaRecorder === 'undefined') {
                  cleanup();
                  hideProcessProgressModal();
                  showToast(tt('annotate.project.process_no_recorder',
                    '浏览器不支持视频录制，请使用 Chrome/Edge'));
                  return;
                }
                var cancelFn = window.AIX_ANNOTATE_PROCESS.processVideo(vEl, config, callbacks);
                processCancelFn = function () {
                  cleanup();
                  if (typeof cancelFn === 'function') cancelFn();
                };
              } catch (e) {
                cleanup();
                failed++;
                idx++;
                processNext();
              }
            }, function (err) {
              log('ERROR', 'batch load video failed: ' + (err.message || err));
              failed++;
              idx++;
              processNext();
            });
          }).catch(function (err) {
            log('ERROR', 'batch getVideoFile failed: ' + (err.message || err));
            failed++;
            idx++;
            processNext();
          });
        } catch (e) {
          log('ERROR', 'batch processNext failed: ' + (e.message || e));
          failed++;
          idx++;
          processNext();
        }
      }

      processNext();
    } catch (e) {
      hideProcessProgressModal();
      log('ERROR', 'runBatchProcess failed: ' + (e.message || e));
      showToast(tt('annotate.project.process_failed', '预处理失败: ') + (e.message || e));
    }
  }

  // ===== 预处理完成回调 =====
  // 重构后：将 Blob 写入工作目录的 processed/ 子文件夹，不再存 IndexedDB
  function onProcessComplete(videoId, result, config) {
    return new Promise(function (resolve) {
    try {
      var project = state.currentProject;
      if (!project) {
        log('ERROR', 'onProcessComplete: no current project');
        showToast(tt('annotate.project.process_save_failed',
          '保存到文件系统失败，已降级下载'));
        fallbackDownloadProcessedBlob(result, videoId);
        resolve();
        return;
      }
      var video = findVideoInProject(project, videoId);
      if (!video) {
        log('WARN', 'onProcessComplete: video not found, id=' + videoId);
        resolve();
        return;
      }
      // 记录处理配置/日志（用于导出与回显）
      video.process_config = config;
      video.process_log = result.log;
      saveProjects();
      log('PROCESS', 'onProcessComplete: video=' + videoId +
        ' blob_size=' + (result.blob && result.blob.size || 0));

      // 写入批次工作目录 processed/ 子文件夹
      saveProcessedBlobToWorkDir(project.id, video.batch_id, result.blob, video.file_name).then(function (info) {
        try {
          video.processed_file = info.path;
          // 兼容清理：移除可能存在的旧 IndexedDB ID 标记
          if (video.processed_blob_id) delete video.processed_blob_id;
          saveProjects();
          var fullDisplayPath = info.dirName + '/' + info.path;
          log('PROCESS', 'saved processed file: ' + fullDisplayPath);
          var msg = tt('annotate.project.process_saved_to', '已保存到：{path}')
            .split('{path}').join(fullDisplayPath);
          showToast(msg);
          // 重新渲染项目详情（更新轨迹卡片"已预处理"标签与路径）
          if (state.currentProject) {
            renderProjectDetail(state.currentProject);
          }
          resolve();
        } catch (e) {
          log('ERROR', 'onProcessComplete post-save failed: ' + (e.message || e));
          resolve();
        }
      }).catch(function (err) {
        log('ERROR', 'saveProcessedBlobToWorkDir failed: ' + (err.message || err) +
          ', fallback to download');
        // 降级：下载 WebM 文件
        showToast(tt('annotate.project.process_save_failed',
          '保存到文件系统失败，已降级下载'));
        fallbackDownloadProcessedBlob(result, videoId);
        resolve();
      });
    } catch (e) {
      log('ERROR', 'onProcessComplete failed: ' + (e.message || e));
      showToast(tt('annotate.project.process_failed', '预处理失败: ') + (e.message || e));
      fallbackDownloadProcessedBlob(result, videoId);
      resolve();
    }
    });
  }

  // ===== 降级：下载预处理 Blob（浏览器不支持 FS Access 或写入失败时） =====
  function fallbackDownloadProcessedBlob(result, videoId) {
    try {
      if (!result || !result.blob) {
        log('WARN', 'fallbackDownloadProcessedBlob: no blob');
        return;
      }
      var exportApi = window.AIX_ANNOTATE_EXPORT;
      if (exportApi && typeof exportApi.downloadBlob === 'function') {
        var fname = buildProcessedFileName(videoId ? ('video_' + videoId) : 'video');
        exportApi.downloadBlob(result.blob, fname);
        log('PROCESS', 'fallback download: ' + fname);
      } else {
        log('WARN', 'fallbackDownloadProcessedBlob: downloadBlob unavailable');
      }
    } catch (e) {
      log('ERROR', 'fallbackDownloadProcessedBlob failed: ' + (e.message || e));
    }
  }

  // ===== 从预处理 Blob 加载视频到播放器 =====
  function loadProcessedVideoIntoPlayer(blob, fileName) {
    try {
      if (!blob) {
        log('WARN', 'loadProcessedVideoIntoPlayer: blob is null');
        return false;
      }
      // 清理旧 URL
      if (state.videoUrl) {
        try { URL.revokeObjectURL(state.videoUrl); } catch (e) {}
        state.videoUrl = null;
      }
      var url;
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        log('ERROR', 'loadProcessedVideoIntoPlayer: createObjectURL failed: ' + (e.message || e));
        return false;
      }
      state.videoFile = { name: fileName || 'processed.webm', size: blob.size, type: blob.type };
      state.videoFileName = fileName || 'processed.webm';
      state.videoFileSize = blob.size;
      state.videoUrl = url;
      state.videoDuration = 0;
      state.videoResolution = [0, 0];
      state.fps = 30;
      state.totalFrames = 0;
      state.currentFrame = 0;

      if (dom.fileName) dom.fileName.textContent = state.videoFileName;
      if (dom.fileInfo) dom.fileInfo.removeAttribute('hidden');
      if (dom.emptyHint) dom.emptyHint.setAttribute('hidden', '');

      if (!dom.video) {
        log('ERROR', 'loadProcessedVideoIntoPlayer: video element not found');
        return false;
      }
      try {
        dom.video.src = url;
        dom.video.load();
      } catch (e) {
        log('ERROR', 'loadProcessedVideoIntoPlayer: set video.src failed: ' + (e.message || e));
        return false;
      }

      // 检测元数据
      detectVideoMetadata(function () {
        try {
          log('FILE', 'Processed video ready, duration=' + state.videoDuration + 's fps=' + state.fps);
          showToast(tt('annotate.file_loaded', '视频加载完成: ') + state.videoFileName);
          updateFrameDisplay();
          updateFileInfoUI();
        } catch (e) {
          log('ERROR', 'loadProcessedVideoIntoPlayer detect callback failed: ' + (e.message || e));
        }
      });
      return true;
    } catch (e) {
      log('ERROR', 'loadProcessedVideoIntoPlayer failed: ' + (e.message || e));
      return false;
    }
  }

  // ==========================================================================
  // 阶段 5：从项目进入标注流程
  // ==========================================================================

  function startAnnotateFromProject(project, videoId) {
    try {
      var video = findVideoInProject(project, videoId);
      if (!video) {
        log('WARN', 'startAnnotateFromProject: video not found, id=' + videoId);
        showToast(tt('annotate.project.video_not_found', '视频未找到'));
        return;
      }
      log('PROJECT', 'startAnnotateFromProject: project=' + project.id + ' video=' + video.id);

      // 设置 state
      state.mode = 'project';
      state.currentProject = project;
      state.currentVideo = video;
      state.project_id = project.id;
      state.video_id = video.id;
      state.device_config = project.device_config || createDefaultDeviceConfig();

      // 视频元信息
      state.videoFileName = video.file_name;
      state.videoFileSize = video.file_size || 0;
      state.videoDuration = video.duration || 0;
      state.videoResolution = (video.resolution && video.resolution.length === 2)
        ? [video.resolution[0] || 0, video.resolution[1] || 0] : [0, 0];
      state.fps = video.fps || 30;
      state.totalFrames = video.num_frames || 0;
      state.currentFrame = 0;

      // meta_info 自动带入：优先从批次继承，降级从项目/设备配置取
      // 批次级字段：data_source / frame_name / instruction_sub_camera / task_success / task_horizon
      // 视频级字段：trajectory_index / fps / num_frames
      var batchMeta = null;
      if (video.batch_id) {
        var metaBatch = findBatchById(project, video.batch_id);
        if (metaBatch && metaBatch.meta_info) {
          batchMeta = metaBatch.meta_info;
          log('ANNOTATE', 'startAnnotateFromProject: inheriting meta_info from batch ' + video.batch_id);
        }
      }
      state.meta_info = {
        data_source: (batchMeta && batchMeta.data_source) || project.data_source || '',
        trajectory_index: video.trajectory_index || '',
        fps: video.fps || 30,
        num_frames: video.num_frames || 0,
        frame_name: (batchMeta && Array.isArray(batchMeta.frame_name))
          ? batchMeta.frame_name.slice()
          : ((project.device_config && Array.isArray(project.device_config.frame_name))
            ? project.device_config.frame_name.slice() : []),
        instruction_sub_camera: (batchMeta && batchMeta.instruction_sub_camera) ||
          (project.device_config && project.device_config.instruction_sub_camera) || '',
        task_success: batchMeta ? !!batchMeta.task_success : true,
        task_horizon: (batchMeta && batchMeta.task_horizon) || 'NA'
      };

      // 加载已有标注（若 video.annotations 存在），否则初始化空结构
      if (video.annotations && typeof video.annotations === 'object' &&
        Array.isArray(video.annotations.hand_detection)) {
        // 深拷贝，避免修改 state 时直接改到 video.annotations
        state.annotations = JSON.parse(JSON.stringify(video.annotations));
        log('ANNOTATE', 'startAnnotateFromProject: loaded existing annotations, ' +
          'hand_det=' + (video.annotations.hand_detection || []).length +
          ' keypoints=' + (video.annotations.hand_keypoints || []).length);
      } else {
        state.annotations = {
          hand_detection: [],
          hand_keypoints: [],
          action_segmentation: { labels: [], segments: [] },
          hand_object: [],
          objects: []
        };
        log('ANNOTATE', 'startAnnotateFromProject: no existing annotations, init empty');
      }
      state.selectedIds = { hand: null, keypoint: null, segment: null, relation: null, object: null };
      state.history = [];
      state.historyIndex = -1;

      // 标记标注状态为进行中（仅在未完成时）
      if (video.annotation_status !== 'completed') {
        video.annotation_status = 'in_progress';
        saveProjects();
      }

      // 切换到标注模式 UI（隐藏项目面板，显示标注容器）
      hideProjectPanelAndShowAnnotate();

      // 元信息已从批次继承 + 视频级字段已填，一律跳过步骤 2，直接进入步骤 3（标注）
      // 步骤 2 仍保留在步骤条，采集人可主动点击回去查看/修改元信息
      state.currentStep = 3;
      goToStep(3);
      updateStepsIndicator();

      // 回填 meta_info 表单（供采集人点回步骤 2 时查看）
      fillMetaInfoForm();

      // 加载原始视频文件（File System Access API 恢复 或 提示重新选择）
      function loadOriginalVideo() {
        var restoreKey = video._restoreKey || ('project_' + project.id + '_video_' + video.id);
        if (FS_ACCESS_SUPPORTED) {
          log('RESTORE', 'startAnnotateFromProject: attempting restore, key=' + restoreKey);
          showToast(tt('annotate.restore_in_progress', '正在恢复视频文件...'));
          fsLoadHandle(restoreKey).then(function (handle) {
            if (!handle) {
              // 无 handle，提示重新选择
              log('RESTORE', 'No saved file handle for key=' + restoreKey);
              showToast(tt('annotate.project.reselect_video_hint', '请在下方上传区重新选择该视频文件以加载播放器'));
              ensureVideoReselectPrompt();
              return;
            }
            log('RESTORE', 'Found file handle, requesting permission...');
            return fsHandleToFile(handle).then(function (file) {
              if (!file) {
                log('RESTORE', 'Permission denied or file unavailable');
                showToast(tt('annotate.restore_permission_denied', '无法恢复视频文件，请重新选择（权限被拒绝）'));
                ensureVideoReselectPrompt();
                return;
              }
              log('RESTORE', 'File restored: ' + file.name);
              // 恢复成功，加载视频
              handleFileSelect(file, handle, restoreKey);
              var restoredMsg = tt('annotate.video_restored', '已恢复视频文件: ' + file.name);
              restoredMsg = restoredMsg.split('{name}').join(file.name);
              showToast(restoredMsg);
            });
          }).catch(function (err) {
            log('ERROR', 'startAnnotateFromProject restore failed: ' + (err.message || err));
            showToast(tt('annotate.project.reselect_video_hint', '请在下方上传区重新选择该视频文件以加载播放器'));
            ensureVideoReselectPrompt();
          });
        } else {
          // 不支持 FS Access，走原提示流程
          showToast(tt('annotate.project.reselect_video_hint', '请在下方上传区重新选择该视频文件以加载播放器'));
          ensureVideoReselectPrompt();
        }
      }

      // 优先加载预处理视频（从工作目录 processed/ 子文件夹读取）；失败则降级到原始视频
      if (video.processed_file) {
        log('RESTORE', 'startAnnotateFromProject: loading processed video, path=' + video.processed_file);
        showToast(tt('annotate.project.process_restore_in_progress', '正在加载预处理视频...'));
        loadProcessedFileFromWorkDir(project.id, video.processed_file).then(function (file) {
          try {
            log('RESTORE', 'Processed video loaded, size=' + (file && file.size || 0));
            var ok = loadProcessedVideoIntoPlayer(file, video.file_name);
            if (!ok) {
              log('WARN', 'loadProcessedVideoIntoPlayer failed, fallback to original');
              loadOriginalVideo();
            } else {
              showToast(tt('annotate.project.process_restored', '已加载预处理视频'));
            }
          } catch (e) {
            log('ERROR', 'loadProcessedVideoIntoPlayer wrapper failed: ' + (e.message || e));
            loadOriginalVideo();
          }
        }).catch(function (err) {
          log('WARN', 'loadProcessedFileFromWorkDir failed, fallback to original: ' + (err.message || err));
          loadOriginalVideo();
        });
      } else {
        loadOriginalVideo();
      }

      saveToLocalStorage();
      log('PROJECT', 'startAnnotateFromProject: entered annotation mode');
    } catch (e) {
      log('ERROR', 'startAnnotateFromProject failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '进入标注失败: ') + (e.message || e));
    }
  }

  // ==========================================================================
  // 阶段 5.5：批量标注（连续标注批次内多个视频）
  // ==========================================================================

  // debounce 定时器（自动保存标注到 video）
  var _persistAnnotationsTimer = null;

  // ===== 把当前 state.annotations 持久化到 currentVideo.annotations =====
  // debounce 1 秒，避免高频修改时频繁写入
  function persistCurrentAnnotationsToVideo(immediate) {
    try {
      if (!state.currentVideo || !state.currentProject) {
        return;
      }
      function doPersist() {
        try {
          if (!state.currentVideo) return;
          // 深拷贝 state.annotations 到 video.annotations
          state.currentVideo.annotations = JSON.parse(JSON.stringify(state.annotations));
          // 同步 meta_info 到 video（便于导出时取用）
          state.currentVideo.meta_info = JSON.parse(JSON.stringify(state.meta_info));
          saveProjects();
          log('ANNOTATE', 'persistCurrentAnnotationsToVideo: saved, video=' + state.currentVideo.id);
        } catch (e) {
          log('ERROR', 'persistCurrentAnnotationsToVideo doPersist failed: ' + (e.message || e));
        }
      }
      if (_persistAnnotationsTimer) {
        clearTimeout(_persistAnnotationsTimer);
        _persistAnnotationsTimer = null;
      }
      if (immediate) {
        doPersist();
      } else {
        _persistAnnotationsTimer = setTimeout(doPersist, 1000);
      }
    } catch (e) {
      log('ERROR', 'persistCurrentAnnotationsToVideo failed: ' + (e.message || e));
    }
  }

  // ===== 启动批量标注（从批次内第一个未标注视频开始） =====
  function startBatchAnnotate(project, batchId) {
    try {
      if (!project || !batchId) {
        log('WARN', 'startBatchAnnotate: no project or batchId');
        return;
      }
      var batch = findBatchById(project, batchId);
      if (!batch || !Array.isArray(batch.video_ids) || batch.video_ids.length === 0) {
        showToast(tt('annotate.project.no_videos_in_batch', '该批次暂无轨迹'));
        return;
      }
      // 收集批次内视频 ID 顺序
      var videoIds = batch.video_ids.slice();
      // 找第一个未标注（annotation_status !== 'completed'）的视频
      var startIndex = -1;
      for (var i = 0; i < videoIds.length; i++) {
        var v = findVideoInProject(project, videoIds[i]);
        if (v && v.annotation_status !== 'completed') {
          startIndex = i;
          break;
        }
      }
      if (startIndex < 0) {
        // 全部已完成，从第一个开始（允许复检）
        startIndex = 0;
        showToast(tt('annotate.batch_all_completed',
          '该批次所有视频已标注完成，从第一个开始复检'));
      }
      // 初始化批次标注上下文
      state.batchAnnotateContext = {
        projectId: project.id,
        batchId: batchId,
        videoIds: videoIds,
        currentIndex: startIndex
      };
      log('BATCH', 'startBatchAnnotate: batch=' + batchId +
        ' total=' + videoIds.length + ' start=' + startIndex);
      // 加载起始视频
      loadVideoForBatchAnnotate(project, videoIds[startIndex]);
    } catch (e) {
      log('ERROR', 'startBatchAnnotate failed: ' + (e.message || e));
      showToast(tt('annotate.err_load_failed', '启动批量标注失败: ') + (e.message || e));
    }
  }

  // ===== 加载批次内指定视频进入标注 =====
  function loadVideoForBatchAnnotate(project, videoId) {
    try {
      if (!project || !videoId) return;
      // 先持久化当前视频的标注（若有）
      persistCurrentAnnotationsToVideo(true);
      // 显示导航条
      showBatchAnnotateNav();
      // 复用现有 startAnnotateFromProject 进入标注
      startAnnotateFromProject(project, videoId);
      // 更新导航条状态
      updateBatchAnnotateNav();
    } catch (e) {
      log('ERROR', 'loadVideoForBatchAnnotate failed: ' + (e.message || e));
    }
  }

  // ===== 切换到下一个批次视频 =====
  function goToNextBatchVideo() {
    try {
      var ctx = state.batchAnnotateContext;
      if (!ctx) {
        log('WARN', 'goToNextBatchVideo: no batch context');
        return;
      }
      var project = state.currentProject || findProjectById(ctx.projectId);
      if (!project) {
        log('WARN', 'goToNextBatchVideo: project not found');
        return;
      }
      // 先标记当前视频为已完成
      if (state.currentVideo) {
        state.currentVideo.annotation_status = 'completed';
        persistCurrentAnnotationsToVideo(true);
      }
      // 找下一个未标注视频（从 currentIndex+1 开始）
      var nextIdx = -1;
      for (var i = ctx.currentIndex + 1; i < ctx.videoIds.length; i++) {
        var v = findVideoInProject(project, ctx.videoIds[i]);
        if (v && v.annotation_status !== 'completed') {
          nextIdx = i;
          break;
        }
      }
      if (nextIdx < 0) {
        // 后面没有了，提示全部完成
        showToast(tt('annotate.batch_complete',
          '该批次已全部标注完成！可继续从第一个复检或退出批量标注'));
        // 从第一个开始复检
        nextIdx = 0;
      }
      ctx.currentIndex = nextIdx;
      log('BATCH', 'goToNextBatchVideo: index=' + nextIdx + ' total=' + ctx.videoIds.length);
      loadVideoForBatchAnnotate(project, ctx.videoIds[nextIdx]);
    } catch (e) {
      log('ERROR', 'goToNextBatchVideo failed: ' + (e.message || e));
    }
  }

  // ===== 切换到上一个批次视频 =====
  function goToPrevBatchVideo() {
    try {
      var ctx = state.batchAnnotateContext;
      if (!ctx) {
        log('WARN', 'goToPrevBatchVideo: no batch context');
        return;
      }
      var project = state.currentProject || findProjectById(ctx.projectId);
      if (!project) return;
      // 持久化当前标注
      persistCurrentAnnotationsToVideo(true);
      if (ctx.currentIndex <= 0) {
        showToast(tt('annotate.batch_first_video', '已是第一个视频'));
        return;
      }
      ctx.currentIndex--;
      log('BATCH', 'goToPrevBatchVideo: index=' + ctx.currentIndex);
      loadVideoForBatchAnnotate(project, ctx.videoIds[ctx.currentIndex]);
    } catch (e) {
      log('ERROR', 'goToPrevBatchVideo failed: ' + (e.message || e));
    }
  }

  // ===== 退出批量标注模式 =====
  function exitBatchAnnotate() {
    try {
      if (!state.batchAnnotateContext) {
        hideBatchAnnotateNav();
        return;
      }
      showModal({
        title: tt('annotate.batch_exit_title', '退出批量标注'),
        body: '<p>' + tt('annotate.batch_exit_body',
          '确认退出批量标注？当前视频的标注已自动保存，可随时从批次卡片重新进入。') + '</p>',
        confirmText: tt('annotate.batch_exit_confirm', '退出'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            persistCurrentAnnotationsToVideo(true);
            state.batchAnnotateContext = null;
            hideBatchAnnotateNav();
            // 返回项目列表视图
            showProjectListView();
            hideModal();
            log('BATCH', 'exitBatchAnnotate: exited');
          } catch (e) {
            log('ERROR', 'exitBatchAnnotate onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'exitBatchAnnotate failed: ' + (e.message || e));
    }
  }

  // ===== 显示/隐藏批量标注导航条 =====
  function showBatchAnnotateNav() {
    try {
      if (dom.batchNav) {
        dom.batchNav.removeAttribute('hidden');
      }
    } catch (e) {
      log('ERROR', 'showBatchAnnotateNav failed: ' + (e.message || e));
    }
  }

  function hideBatchAnnotateNav() {
    try {
      if (dom.batchNav) {
        dom.batchNav.setAttribute('hidden', '');
      }
    } catch (e) {
      log('ERROR', 'hideBatchAnnotateNav failed: ' + (e.message || e));
    }
  }

  // ===== 更新导航条 UI（视频名/进度/状态/按钮启用） =====
  function updateBatchAnnotateNav() {
    try {
      var ctx = state.batchAnnotateContext;
      if (!ctx) {
        hideBatchAnnotateNav();
        return;
      }
      showBatchAnnotateNav();
      var project = state.currentProject || findProjectById(ctx.projectId);
      var currentVideo = state.currentVideo;
      var total = ctx.videoIds.length;
      var idx = ctx.currentIndex + 1; // 1-based 显示

      // 视频名
      if (dom.batchNavName) {
        dom.batchNavName.textContent = currentVideo
          ? (currentVideo.file_name || currentVideo.id)
          : '—';
      }
      // 进度
      if (dom.batchNavProgress) {
        dom.batchNavProgress.textContent = idx + ' / ' + total;
      }
      // 状态
      if (dom.batchNavStatus) {
        var statusKey = 'annotate.batch_status_';
        var status = currentVideo ? currentVideo.annotation_status : 'unannotated';
        var statusText;
        if (status === 'completed') {
          statusText = tt('annotate.batch_status_completed', '已完成');
        } else if (status === 'in_progress') {
          statusText = tt('annotate.batch_status_in_progress', '进行中');
        } else {
          statusText = tt('annotate.batch_status_unannotated', '未标注');
        }
        dom.batchNavStatus.textContent = statusText;
        dom.batchNavStatus.setAttribute('data-status', status || 'unannotated');
      }
      // 上一个按钮
      if (dom.batchPrevBtn) {
        dom.batchPrevBtn.disabled = (ctx.currentIndex <= 0);
      }
      // 下一个按钮（最后一个时文案改为"完成"）
      if (dom.batchNextBtn) {
        var isLast = (ctx.currentIndex >= total - 1);
        var nextLabel = dom.batchNextBtn.querySelector('span:first-child');
        if (nextLabel) {
          nextLabel.textContent = isLast
            ? tt('annotate.batch_nav_finish', '完成')
            : tt('annotate.batch_nav_next', '下一个');
        }
      }
      log('BATCH', 'updateBatchAnnotateNav: ' + idx + '/' + total +
        ' status=' + (currentVideo ? currentVideo.annotation_status : 'null'));
    } catch (e) {
      log('ERROR', 'updateBatchAnnotateNav failed: ' + (e.message || e));
    }
  }

  // ===== 绑定批量标注导航条事件 =====
  function bindBatchAnnotateNavEvents() {
    try {
      if (dom.batchPrevBtn) {
        dom.batchPrevBtn.addEventListener('click', function () {
          goToPrevBatchVideo();
        });
      }
      if (dom.batchNextBtn) {
        dom.batchNextBtn.addEventListener('click', function () {
          goToNextBatchVideo();
        });
      }
      if (dom.batchExitBtn) {
        dom.batchExitBtn.addEventListener('click', function () {
          exitBatchAnnotate();
        });
      }
      log('BATCH', 'bindBatchAnnotateNavEvents: bound');
    } catch (e) {
      log('ERROR', 'bindBatchAnnotateNavEvents failed: ' + (e.message || e));
    }
  }

  // ===== 在标注模式顶部显示"重新选择视频文件"提示 =====
  function ensureVideoReselectPrompt() {
    try {
      var step2 = qs('annotateStep2');
      if (!step2) return;
      var existingPrompt = step2.querySelector('.annotate-reselect-prompt');
      if (existingPrompt) return; // 已存在
      var prompt = document.createElement('div');
      prompt.className = 'annotate-reselect-prompt';
      prompt.innerHTML =
        '<div class="annotate-reselect-prompt-inner">' +
          '<span class="material-symbols-outlined">info</span>' +
          '<span data-i18n="annotate.project.reselect_prompt">' +
            tt('annotate.project.reselect_prompt', '项目模式下需重新选择视频文件以加载播放器（浏览器安全限制，无法持久化 File 对象）') +
          '</span>' +
          '<button type="button" class="annotate-btn annotate-btn-primary annotate-btn-sm" id="reselectVideoBtn">' +
            '<span class="material-symbols-outlined">folder_open</span>' +
            '<span data-i18n="annotate.select_file">选择文件</span>' +
          '</button>' +
        '</div>';
      step2.insertBefore(prompt, step2.firstChild);
      var btn = prompt.querySelector('#reselectVideoBtn');
      if (btn) {
        btn.addEventListener('click', function () {
          try {
            // 复用统一的文件选择入口（FS Access 优先，降级到 fileInput）
            openVideoPicker();
          } catch (e) {
            log('ERROR', 'reselect video click failed: ' + (e.message || e));
          }
        });
      }
    } catch (e) {
      log('ERROR', 'ensureVideoReselectPrompt failed: ' + (e.message || e));
    }
  }

  // ==========================================================================
  // 阶段 3：采集设备参数配置
  // ==========================================================================

  // ===== 渲染设备配置表单 HTML =====
  function renderDeviceConfigFormHtml(project) {
    try {
      var dc = project.device_config || createDefaultDeviceConfig();
      project.device_config = dc; // 确保项目上有 device_config

      var intrinsic = dc.intrinsic || { fx: 0, fy: 0, cx: 0, cy: 0, distortion: [0, 0, 0, 0, 0] };
      var distortion = Array.isArray(intrinsic.distortion) ? intrinsic.distortion : [0, 0, 0, 0, 0];
      while (distortion.length < 5) distortion.push(0);
      var extrinsic = dc.extrinsic || { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], T: [0, 0, 0] };
      var R = Array.isArray(extrinsic.R) ? extrinsic.R : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      while (R.length < 3) R.push([0, 0, 0]);
      for (var i = 0; i < 3; i++) {
        if (!Array.isArray(R[i])) R[i] = [0, 0, 0];
        while (R[i].length < 3) R[i].push(0);
      }
      var T = Array.isArray(extrinsic.T) ? extrinsic.T : [0, 0, 0];
      while (T.length < 3) T.push(0);
      var frameNames = Array.isArray(dc.frame_name) ? dc.frame_name : [];
      var mainCam = dc.instruction_sub_camera || '';

      var html =
        '<div class="annotate-device-config">' +
          // 导入按钮（假按钮，功能待开发）
          '<div class="annotate-device-actions" style="margin-bottom: 12px;">' +
            '<button type="button" class="annotate-btn annotate-btn-secondary" id="importDeviceConfigBtn">' +
              '<span class="material-symbols-outlined">file_upload</span>' +
              '<span data-i18n="annotate.project.import_device_config">导入标定文件</span>' +
            '</button>' +
            '<span class="annotate-device-hint-inline" data-i18n="annotate.project.import_device_hint">' +
              tt('annotate.project.import_device_hint_text', '支持 JSON/YAML 格式，功能开发中') +
            '</span>' +
          '</div>' +
          // 说明提示
          '<div class="annotate-device-hint">' +
            tt('annotate.project.device_hint',
              '相机标定参数，来自相机标定流程（如 OpenCV calibrateCamera）。' +
              '如果没有标定数据可留空（默认 0），不影响标注流程，仅用于导出 HDF5 时附带。') +
          '</div>' +
          // 内参
          '<div class="annotate-device-section">' +
            '<h4 class="annotate-device-section-title">' +
              '<span class="material-symbols-outlined">tune</span>' +
              '<span data-i18n="annotate.project.intrinsic">内参 (Intrinsic)</span>' +
            '</h4>' +
            '<div class="annotate-device-hint" style="margin-bottom: 8px;">' +
              tt('annotate.project.intrinsic_hint',
                '描述相机光学特性：<code>fx/fy</code> 焦距（像素），<code>cx/cy</code> 主点，' +
                '<code>k1/k2/k3</code> 径向畸变，<code>p1/p2</code> 切向畸变。') +
            '</div>' +
            '<div class="annotate-device-form-grid">' +
              renderNumberField('dc_fx', tt('annotate.project.fx', 'fx'), intrinsic.fx || 0) +
              renderNumberField('dc_fy', tt('annotate.project.fy', 'fy'), intrinsic.fy || 0) +
              renderNumberField('dc_cx', tt('annotate.project.cx', 'cx'), intrinsic.cx || 0) +
              renderNumberField('dc_cy', tt('annotate.project.cy', 'cy'), intrinsic.cy || 0) +
              renderNumberField('dc_k1', tt('annotate.project.k1', 'k1'), distortion[0] || 0) +
              renderNumberField('dc_k2', tt('annotate.project.k2', 'k2'), distortion[1] || 0) +
              renderNumberField('dc_p1', tt('annotate.project.p1', 'p1'), distortion[2] || 0) +
              renderNumberField('dc_p2', tt('annotate.project.p2', 'p2'), distortion[3] || 0) +
              renderNumberField('dc_k3', tt('annotate.project.k3', 'k3'), distortion[4] || 0) +
            '</div>' +
          '</div>' +
          // 外参
          '<div class="annotate-device-section">' +
            '<h4 class="annotate-device-section-title">' +
              '<span class="material-symbols-outlined">rotate_90_degrees_ccw</span>' +
              '<span data-i18n="annotate.project.extrinsic">外参 (Extrinsic)</span>' +
            '</h4>' +
            '<div class="annotate-device-hint" style="margin-bottom: 8px;">' +
              tt('annotate.project.extrinsic_hint',
                '描述相机在世界坐标系中的位姿：<code>R</code> 旋转矩阵 3×3，<code>T</code> 平移向量 3。' +
                '多相机系统需要每个相机的外参。') +
            '</div>' +
            '<div class="annotate-device-extrinsic">' +
              '<div class="annotate-device-extrinsic-block">' +
                '<label class="annotate-device-extrinsic-label">R (3×3)</label>' +
                '<div class="annotate-device-matrix3">' +
                  renderNumberField('dc_r00', 'R[0][0]', R[0][0] || 0, true) +
                  renderNumberField('dc_r01', 'R[0][1]', R[0][1] || 0, true) +
                  renderNumberField('dc_r02', 'R[0][2]', R[0][2] || 0, true) +
                  renderNumberField('dc_r10', 'R[1][0]', R[1][0] || 0, true) +
                  renderNumberField('dc_r11', 'R[1][1]', R[1][1] || 0, true) +
                  renderNumberField('dc_r12', 'R[1][2]', R[1][2] || 0, true) +
                  renderNumberField('dc_r20', 'R[2][0]', R[2][0] || 0, true) +
                  renderNumberField('dc_r21', 'R[2][1]', R[2][1] || 0, true) +
                  renderNumberField('dc_r22', 'R[2][2]', R[2][2] || 0, true) +
                '</div>' +
              '</div>' +
              '<div class="annotate-device-extrinsic-block">' +
                '<label class="annotate-device-extrinsic-label">T (3)</label>' +
                '<div class="annotate-device-vector3">' +
                  renderNumberField('dc_t0', 'T[0]', T[0] || 0, true) +
                  renderNumberField('dc_t1', 'T[1]', T[1] || 0, true) +
                  renderNumberField('dc_t2', 'T[2]', T[2] || 0, true) +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          // 相机名称映射
          '<div class="annotate-device-section">' +
            '<h4 class="annotate-device-section-title">' +
              '<span class="material-symbols-outlined">camera</span>' +
              '<span data-i18n="annotate.project.camera_mapping">相机名称映射</span>' +
            '</h4>' +
            '<div class="annotate-device-hint" style="margin-bottom: 8px;">' +
              tt('annotate.project.camera_mapping_hint',
                '<code>frame_name</code> 是多相机系统中所有相机名称列表（如 head_cam、left_cam）。' +
                '<code>instruction_sub_camera</code> 是当前标注视频对应的相机名称（必须存在于 frame_name 中）。' +
                '单相机系统填一个名称即可。') +
            '</div>' +
            '<div class="annotate-device-frame-name">' +
              '<label class="annotate-device-label" data-i18n="annotate.project.frame_name">frame_name (相机名称列表)</label>' +
              '<div class="annotate-device-frame-name-list" id="dcFrameNameList"></div>' +
              '<div class="annotate-device-frame-name-add">' +
                '<input type="text" id="dcFrameNameInput" class="annotate-input annotate-input-sm" placeholder="' +
                  tt('annotate.project.frame_name_placeholder', '输入相机名称，如 cam_0') + '">' +
                '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" id="dcAddFrameNameBtn" data-i18n="annotate.project.add_frame_name">添加</button>' +
              '</div>' +
            '</div>' +
            '<div class="annotate-device-main-cam">' +
              '<label class="annotate-device-label" for="dcMainCamSelect" data-i18n="annotate.project.instruction_sub_camera">instruction_sub_camera (主相机)</label>' +
              '<select id="dcMainCamSelect" class="annotate-input">' +
                '<option value="">' + tt('annotate.project.select_main_cam', '-- 选择主相机 --') + '</option>' +
                renderFrameNameOptions(frameNames, mainCam) +
              '</select>' +
              '<p class="annotate-device-hint" id="dcMainCamHint"></p>' +
            '</div>' +
          '</div>' +
        '</div>';
      return html;
    } catch (e) {
      log('ERROR', 'renderDeviceConfigFormHtml failed: ' + (e.message || e));
      return '<p>' + escapeHtml('设备配置渲染失败: ' + (e.message || e)) + '</p>';
    }
  }

  function renderNumberField(id, label, value, compact) {
    try {
      var v = (typeof value === 'number' && !isNaN(value)) ? value : 0;
      return '<div class="annotate-form-field' + (compact ? ' annotate-form-field-compact' : '') + '">' +
        '<label for="' + id + '" class="annotate-device-field-label">' + escapeHtml(label) + '</label>' +
        '<input type="number" id="' + id + '" class="annotate-input annotate-input-sm" step="any" value="' + v + '">' +
      '</div>';
    } catch (e) {
      return '';
    }
  }

  function renderFrameNameOptions(frameNames, selected) {
    try {
      var html = '';
      for (var i = 0; i < frameNames.length; i++) {
        var fn = frameNames[i];
        var isSel = (fn === selected) ? ' selected' : '';
        html += '<option value="' + escapeHtml(fn) + '"' + isSel + '>' + escapeHtml(fn) + '</option>';
      }
      return html;
    } catch (e) {
      return '';
    }
  }

  // ===== 渲染 frame_name 列表 =====
  function renderFrameNameList(project) {
    try {
      var listEl = qs('dcFrameNameList');
      if (!listEl) return;
      var dc = project.device_config || createDefaultDeviceConfig();
      var names = Array.isArray(dc.frame_name) ? dc.frame_name : [];
      listEl.innerHTML = '';
      if (names.length === 0) {
        listEl.innerHTML = '<p class="annotate-device-empty-hint">' +
          tt('annotate.project.no_frame_names', '暂无相机名称') + '</p>';
        return;
      }
      for (var i = 0; i < names.length; i++) {
        (function (name, idx) {
          var item = document.createElement('div');
          item.className = 'annotate-frame-name-item';
          item.innerHTML =
            '<span class="annotate-frame-name-text">' + escapeHtml(name) + '</span>' +
            '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm annotate-frame-name-del" data-idx="' + idx + '">' +
              '<span class="material-symbols-outlined">delete</span>' +
            '</button>';
          var delBtn = item.querySelector('.annotate-frame-name-del');
          if (delBtn) {
            delBtn.addEventListener('click', function () {
              try {
                // 删除 frame_name
                dc.frame_name.splice(idx, 1);
                // 如果删除的是主相机，清空主相机
                if (dc.instruction_sub_camera === name) {
                  dc.instruction_sub_camera = '';
                }
                saveProjects();
                renderFrameNameList(project);
                refreshMainCamOptions(project);
                log('DEVICE', 'frame_name deleted: ' + name);
              } catch (e) {
                log('ERROR', 'frame_name delete failed: ' + (e.message || e));
              }
            });
          }
          listEl.appendChild(item);
        })(names[i], i);
      }
    } catch (e) {
      log('ERROR', 'renderFrameNameList failed: ' + (e.message || e));
    }
  }

  function refreshMainCamOptions(project) {
    try {
      var select = qs('dcMainCamSelect');
      if (!select) return;
      var dc = project.device_config || createDefaultDeviceConfig();
      var names = Array.isArray(dc.frame_name) ? dc.frame_name : [];
      var current = dc.instruction_sub_camera || '';
      var html = '<option value="">' + tt('annotate.project.select_main_cam', '-- 选择主相机 --') + '</option>';
      html += renderFrameNameOptions(names, current);
      select.innerHTML = html;
      select.value = current;
    } catch (e) {
      log('ERROR', 'refreshMainCamOptions failed: ' + (e.message || e));
    }
  }

  // ===== 绑定设备配置表单事件 =====
  function bindDeviceConfigFormEvents(project) {
    try {
      var dc = project.device_config || createDefaultDeviceConfig();
      project.device_config = dc;

      // 内参 + 外参输入字段
      var numberFields = [
        { id: 'dc_fx', path: ['intrinsic', 'fx'] },
        { id: 'dc_fy', path: ['intrinsic', 'fy'] },
        { id: 'dc_cx', path: ['intrinsic', 'cx'] },
        { id: 'dc_cy', path: ['intrinsic', 'cy'] },
        { id: 'dc_k1', path: ['intrinsic', 'distortion', 0] },
        { id: 'dc_k2', path: ['intrinsic', 'distortion', 1] },
        { id: 'dc_p1', path: ['intrinsic', 'distortion', 2] },
        { id: 'dc_p2', path: ['intrinsic', 'distortion', 3] },
        { id: 'dc_k3', path: ['intrinsic', 'distortion', 4] },
        { id: 'dc_r00', path: ['extrinsic', 'R', 0, 0] },
        { id: 'dc_r01', path: ['extrinsic', 'R', 0, 1] },
        { id: 'dc_r02', path: ['extrinsic', 'R', 0, 2] },
        { id: 'dc_r10', path: ['extrinsic', 'R', 1, 0] },
        { id: 'dc_r11', path: ['extrinsic', 'R', 1, 1] },
        { id: 'dc_r12', path: ['extrinsic', 'R', 1, 2] },
        { id: 'dc_r20', path: ['extrinsic', 'R', 2, 0] },
        { id: 'dc_r21', path: ['extrinsic', 'R', 2, 1] },
        { id: 'dc_r22', path: ['extrinsic', 'R', 2, 2] },
        { id: 'dc_t0', path: ['extrinsic', 'T', 0] },
        { id: 'dc_t1', path: ['extrinsic', 'T', 1] },
        { id: 'dc_t2', path: ['extrinsic', 'T', 2] }
      ];

      // 导入标定文件按钮（假按钮，功能待开发）
      var importBtn = qs('importDeviceConfigBtn');
      if (importBtn) {
        importBtn.addEventListener('click', function () {
          showToast(
            tt('annotate.project.import_device_todo', '导入标定文件功能开发中，后续支持 JSON/YAML 格式'),
            'info'
          );
        });
      }

      for (var i = 0; i < numberFields.length; i++) {
        (function (field) {
          var el = qs(field.id);
          if (!el) return;
          el.addEventListener('input', function () {
            try {
              var val = parseFloat(el.value);
              if (isNaN(val)) val = 0;
              // 按路径写入 dc
              var obj = dc;
              for (var p = 0; p < field.path.length - 1; p++) {
                var key = field.path[p];
                if (obj[key] == null || typeof obj[key] !== 'object') {
                  obj[key] = (typeof field.path[p + 1] === 'number') ? [] : {};
                }
                obj = obj[key];
              }
              var lastKey = field.path[field.path.length - 1];
              obj[lastKey] = val;
              saveProjects();
            } catch (e) {
              log('ERROR', 'device field input failed for ' + field.id + ': ' + (e.message || e));
            }
          });
        })(numberFields[i]);
      }

      // 渲染 frame_name 列表
      renderFrameNameList(project);

      // 添加 frame_name 按钮
      var addBtn = qs('dcAddFrameNameBtn');
      var input = qs('dcFrameNameInput');
      if (addBtn && input) {
        addBtn.addEventListener('click', function () {
          try {
            var name = (input.value || '').trim();
            if (!name) {
              showToast(tt('annotate.project.frame_name_empty', '相机名称不能为空'));
              return;
            }
            if (!Array.isArray(dc.frame_name)) dc.frame_name = [];
            // 重复校验
            if (dc.frame_name.indexOf(name) >= 0) {
              showToast(tt('annotate.project.frame_name_duplicate', '相机名称已存在'));
              return;
            }
            dc.frame_name.push(name);
            input.value = '';
            saveProjects();
            renderFrameNameList(project);
            refreshMainCamOptions(project);
            log('DEVICE', 'frame_name added: ' + name);
          } catch (e) {
            log('ERROR', 'add frame_name failed: ' + (e.message || e));
          }
        });
        // 回车提交
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            if (addBtn) addBtn.click();
          }
        });
      }

      // 主相机选择
      var mainCamSelect = qs('dcMainCamSelect');
      var hintEl = qs('dcMainCamHint');
      if (mainCamSelect) {
        mainCamSelect.addEventListener('change', function () {
          try {
            var val = mainCamSelect.value || '';
            // 校验：必须存在于 frame_name 中
            if (val && Array.isArray(dc.frame_name) && dc.frame_name.indexOf(val) < 0) {
              if (hintEl) {
                hintEl.textContent = tt('annotate.project.main_cam_not_in_frame_name', '主相机必须在 frame_name 列表中');
                hintEl.style.color = '#ef4444';
              }
              dc.instruction_sub_camera = '';
            } else {
              dc.instruction_sub_camera = val;
              if (hintEl) {
                hintEl.textContent = val ? tt('annotate.project.main_cam_set', '主相机已设置: ') + val : '';
                hintEl.style.color = '';
              }
              saveProjects();
            }
            log('DEVICE', 'instruction_sub_camera = ' + val);
          } catch (e) {
            log('ERROR', 'main cam select failed: ' + (e.message || e));
          }
        });
      }
    } catch (e) {
      log('ERROR', 'bindDeviceConfigFormEvents failed: ' + (e.message || e));
    }
  }

  // ==========================================================================
  // 阶段 4：批次和轨迹编号管理
  // ==========================================================================

  // ===== 渲染批次管理面板 HTML =====
  function renderBatchPanelHtml(project) {
    try {
      var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
      var html = '<div class="annotate-batch-panel">';
      html += '<div class="annotate-batch-actions">';
      html += '<button type="button" class="annotate-btn annotate-btn-primary annotate-btn-sm" id="createBatchBtn">' +
        '<span class="material-symbols-outlined">add</span>' +
        '<span data-i18n="annotate.project.create_batch">新建批次</span>' +
      '</button>';
      html += '</div>';

      // 批次级统计：总轨迹 / 已标注 / 通过
      var statsVideos = (project && Array.isArray(project.videos)) ? project.videos : [];
      var statsTotal = statsVideos.length;
      var statsAnnotated = 0;
      var statsPassed = 0;
      for (var si = 0; si < statsVideos.length; si++) {
        var sv = statsVideos[si];
        if (sv && sv.annotations && typeof sv.annotations === 'object' &&
          Object.keys(sv.annotations).length > 0) {
          statsAnnotated++;
        }
        if (sv && sv.annotation_status === 'passed') {
          statsPassed++;
        }
      }
      html += '<div class="annotate-batch-stats">' +
        '<div class="annotate-batch-stat">' +
          '<span class="annotate-batch-stat-label">' + tt('annotate.project.batch_stats_total', '总轨迹') + '</span>' +
          '<span class="annotate-batch-stat-value">' + statsTotal + '</span>' +
        '</div>' +
        '<div class="annotate-batch-stat">' +
          '<span class="annotate-batch-stat-label">' + tt('annotate.project.batch_stats_annotated', '已标注') + '</span>' +
          '<span class="annotate-batch-stat-value">' + statsAnnotated + '</span>' +
        '</div>' +
        '<div class="annotate-batch-stat">' +
          '<span class="annotate-batch-stat-label">' + tt('annotate.project.batch_stats_passed', '通过') + '</span>' +
          '<span class="annotate-batch-stat-value">' + statsPassed + '</span>' +
        '</div>' +
      '</div>';

      if (batches.length === 0) {
        html += '<div class="annotate-project-empty-mini">' +
          '<span class="material-symbols-outlined">layers_clear</span>' +
          '<p data-i18n="annotate.project.no_batches">' + tt('annotate.project.no_batches', '暂无批次') + '</p>' +
        '</div>';
      } else {
        html += '<div class="annotate-batch-list">';
        for (var i = 0; i < batches.length; i++) {
          html += renderBatchCardHtml(project, batches[i]);
        }
        html += '</div>';
      }
      html += '</div>';
      return html;
    } catch (e) {
      log('ERROR', 'renderBatchPanelHtml failed: ' + (e.message || e));
      return '<p>' + escapeHtml('批次面板渲染失败: ' + (e.message || e)) + '</p>';
    }
  }

  // ===== 渲染单个批次卡片（含工作目录、操作按钮、视频列表） =====
  function renderBatchCardHtml(project, batch) {
    try {
      if (!project || !batch) return '';
      var videoCount = Array.isArray(batch.video_ids) ? batch.video_ids.length : 0;
      var hasWorkDir = !!batch.work_dir_name;
      var isExpanded = !!(state.expandedBatchIds && state.expandedBatchIds[batch.id]);
      var isNewBatch = !!(state.highlightBatchId && state.highlightBatchId === batch.id);

      // 收集该批次的视频
      var batchVideos = [];
      if (Array.isArray(batch.video_ids) && Array.isArray(project.videos)) {
        for (var vi = 0; vi < batch.video_ids.length; vi++) {
          var v = findVideoInProject(project, batch.video_ids[vi]);
          if (v) batchVideos.push(v);
        }
      }

      var html = '<div class="annotate-batch-card' + (isExpanded ? ' expanded' : '') +
        (isNewBatch ? ' highlight' : '') + '" data-batch-id="' + escapeHtml(batch.id) + '">';

      // 卡片头部
      html += '<div class="annotate-batch-card-header">' +
        '<button type="button" class="annotate-batch-card-toggle" data-action="toggle-batch" data-batch-id="' + escapeHtml(batch.id) + '">' +
          '<span class="material-symbols-outlined annotate-batch-card-arrow">' + (isExpanded ? 'expand_more' : 'chevron_right') + '</span>' +
          '<span class="annotate-batch-card-id">' + escapeHtml(batch.id) + '</span>' +
          '<span class="annotate-batch-card-name">' + escapeHtml(batch.name || '') + '</span>' +
          '<span class="annotate-batch-card-meta">' +
            '<span class="material-symbols-outlined">videocam</span>' +
            '<span>' + videoCount + '</span>' +
          '</span>' +
          '<span class="annotate-batch-card-meta">' +
            '<span class="material-symbols-outlined">schedule</span>' +
            '<span>' + formatDateTime(batch.created_at) + '</span>' +
          '</span>' +
        '</button>' +
        '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm annotate-batch-card-delete" data-action="delete-batch" data-batch-id="' + escapeHtml(batch.id) + '" title="' + escapeHtml(tt('annotate.delete', '删除')) + '">' +
          '<span class="material-symbols-outlined">delete</span>' +
        '</button>' +
      '</div>';

      // 卡片内容（展开时显示）
      if (isExpanded) {
        html += '<div class="annotate-batch-card-body">';

        // 工作目录行
        html += '<div class="annotate-batch-workdir">' +
          '<span class="material-symbols-outlined">folder</span>' +
          '<span class="annotate-batch-workdir-label" data-i18n="annotate.project.work_dir">' +
            tt('annotate.project.work_dir', '工作目录') + ':' +
          '</span>' +
          '<span class="annotate-batch-workdir-value' + (hasWorkDir ? '' : ' not-set') + '">' +
            (hasWorkDir ? escapeHtml(batch.work_dir_name) :
              tt('annotate.project.work_dir_not_set', '未设置')) +
          '</span>' +
          '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" data-action="set-batch-workdir" data-batch-id="' + escapeHtml(batch.id) + '">' +
            '<span class="material-symbols-outlined">' + (hasWorkDir ? 'edit' : 'folder_open') + '</span>' +
            '<span>' + (hasWorkDir ? tt('annotate.project.change', '更改') :
              tt('annotate.project.set_work_dir', '设置工作目录')) + '</span>' +
          '</button>' +
        '</div>';

        // 批次元信息摘要（只读，创建批次时填写）
        var bMeta = batch.meta_info;
        var hasMeta = bMeta && (bMeta.data_source || (Array.isArray(bMeta.frame_name) && bMeta.frame_name.length) || bMeta.instruction_sub_camera);
        html += '<div class="annotate-batch-meta-summary' + (hasMeta ? '' : ' empty') + '">';
        html += '<span class="material-symbols-outlined">info</span>';
        html += '<span class="annotate-batch-meta-label">' +
          tt('annotate.project.batch_meta_info', '批次元信息') + ':</span>';
        if (hasMeta) {
          var metaParts = [];
          if (bMeta.data_source) {
            metaParts.push('data_source=' + escapeHtml(bMeta.data_source));
          }
          if (Array.isArray(bMeta.frame_name) && bMeta.frame_name.length) {
            metaParts.push('frame_name=[' + escapeHtml(bMeta.frame_name.join(', ')) + ']');
          }
          if (bMeta.instruction_sub_camera) {
            metaParts.push('sub_cam=' + escapeHtml(bMeta.instruction_sub_camera));
          }
          metaParts.push('task_success=' + (bMeta.task_success ? 'true' : 'false'));
          metaParts.push('task_horizon=' + escapeHtml(bMeta.task_horizon || 'NA'));
          html += '<span class="annotate-batch-meta-value">' + metaParts.join(' · ') + '</span>';
        } else {
          html += '<span class="annotate-batch-meta-value not-set">' +
            tt('annotate.project.batch_meta_not_set', '未填写（进入标注时将从项目继承）') + '</span>';
        }
        html += '</div>';

        // 操作按钮行
        // 预处理拦截条件：未设置工作目录或无视频，按钮禁用
        var processDisabled = (videoCount === 0 || !hasWorkDir);
        var processTitle = !hasWorkDir
          ? tt('annotate.project.work_dir_required_for_process', '请先设置该批次的工作目录，再进行预处理')
          : (videoCount === 0 ? tt('annotate.project.no_videos_in_batch', '该批次暂无轨迹') : '');
        html += '<div class="annotate-batch-card-actions">';
        // 导入轨迹按钮（新建批次高亮）
        html += '<button type="button" class="annotate-btn annotate-btn-primary annotate-btn-sm' +
          (isNewBatch ? ' highlight-pulse' : '') + '" data-action="import-to-batch" data-batch-id="' + escapeHtml(batch.id) + '"' +
          (isNewBatch ? ' id="highlightImportBtn"' : '') + '>' +
          '<span class="material-symbols-outlined">video_file</span>' +
          '<span data-i18n="annotate.project.import_to_batch">' + tt('annotate.project.import_to_batch', '导入轨迹') + '</span>' +
        '</button>';
        // 批量预处理按钮（未设置工作目录时禁用 + 提示）
        html += '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" data-action="batch-process" data-batch-id="' + escapeHtml(batch.id) + '"' +
          (processDisabled ? ' disabled' : '') +
          (processTitle ? ' title="' + escapeHtml(processTitle) + '"' : '') + '>' +
          '<span class="material-symbols-outlined">auto_fix_high</span>' +
          '<span data-i18n="annotate.project.batch_process">' + tt('annotate.project.batch_process', '批量预处理') + '</span>' +
        '</button>';
        // 批量标注按钮（原"开始标注"，现改为批量标注入口）
        html += '<button type="button" class="annotate-btn annotate-btn-primary annotate-btn-sm" data-action="start-annotate-batch" data-batch-id="' + escapeHtml(batch.id) + '" ' +
          (videoCount === 0 ? 'disabled' : '') + '>' +
          '<span class="material-symbols-outlined">playlist_play</span>' +
          '<span data-i18n="annotate.project.batch_annotate">' + tt('annotate.project.batch_annotate', '批量标注') + '</span>' +
        '</button>';
        html += '</div>';

        // 视频列表
        if (batchVideos.length === 0) {
          html += '<div class="annotate-batch-empty">' +
            '<span class="material-symbols-outlined">videocam_off</span>' +
            '<p data-i18n="annotate.project.no_videos_in_batch">' +
              tt('annotate.project.no_videos_in_batch', '该批次暂无轨迹，点击「导入轨迹」添加') +
            '</p>' +
          '</div>';
        } else {
          html += '<div class="annotate-batch-video-list">';
          for (var vj = 0; vj < batchVideos.length; vj++) {
            var vid = batchVideos[vj];
            var isProcessed = !!(vid.processed_file);
            // 单视频预处理按钮禁用条件：已预处理 或 批次未设置工作目录
            var vidProcessDisabled = isProcessed || !hasWorkDir;
            var vidProcessTitle = !hasWorkDir
              ? tt('annotate.project.work_dir_required_for_process', '请先设置该批次的工作目录，再进行预处理')
              : (isProcessed ? tt('annotate.project.already_processed', '该视频已预处理') : '');
            // 标注状态标签
            var annStatus = vid.annotation_status || 'unannotated';
            var annStatusTag = '';
            if (annStatus === 'completed') {
              annStatusTag = '<span class="annotate-tag annotate-tag-success" data-i18n="annotate.batch_status_completed">' +
                tt('annotate.batch_status_completed', '已标注') + '</span>';
            } else if (annStatus === 'in_progress') {
              annStatusTag = '<span class="annotate-tag annotate-tag-warning" data-i18n="annotate.batch_status_in_progress">' +
                tt('annotate.batch_status_in_progress', '标注中') + '</span>';
            } else {
              annStatusTag = '<span class="annotate-tag annotate-tag-muted" data-i18n="annotate.batch_status_unannotated">' +
                tt('annotate.batch_status_unannotated', '未标注') + '</span>';
            }
            html += '<div class="annotate-batch-video-item" data-video-id="' + escapeHtml(vid.id) + '">' +
              '<span class="annotate-batch-video-name" title="' + escapeHtml(vid.file_name || '') + '">' +
                escapeHtml(vid.file_name || '') +
              '</span>' +
              annStatusTag +
              (isProcessed ?
                '<span class="annotate-tag annotate-tag-success" data-i18n="annotate.project.processed">' +
                  tt('annotate.project.processed', '已预处理') + '</span>' :
                '<span class="annotate-tag annotate-tag-muted" data-i18n="annotate.project.unprocessed">' +
                  tt('annotate.project.unprocessed', '未处理') + '</span>') +
              '<div class="annotate-batch-video-actions">' +
                '<button type="button" class="annotate-btn annotate-btn-secondary annotate-btn-sm" data-action="process-video" data-video-id="' + escapeHtml(vid.id) + '"' +
                  (vidProcessDisabled ? ' disabled' : '') +
                  (vidProcessTitle ? ' title="' + escapeHtml(vidProcessTitle) + '"' : '') + '>' +
                  '<span class="material-symbols-outlined">auto_fix_high</span>' +
                  '<span data-i18n="annotate.project.process">' + tt('annotate.project.process', '预处理') + '</span>' +
                '</button>' +
                '<button type="button" class="annotate-btn annotate-btn-primary annotate-btn-sm" data-action="annotate-video" data-video-id="' + escapeHtml(vid.id) + '">' +
                  '<span class="material-symbols-outlined">edit</span>' +
                  '<span data-i18n="annotate.project.annotate">' + tt('annotate.project.annotate', '标注') + '</span>' +
                '</button>' +
                '<button type="button" class="annotate-btn annotate-btn-danger annotate-btn-sm" data-action="delete-video" data-video-id="' + escapeHtml(vid.id) + '">' +
                  '<span class="material-symbols-outlined">delete</span>' +
                '</button>' +
              '</div>' +
            '</div>';
          }
          html += '</div>';
        }

        html += '</div>'; // annotate-batch-card-body
      }

      html += '</div>'; // annotate-batch-card
      return html;
    } catch (e) {
      log('ERROR', 'renderBatchCardHtml failed: ' + (e.message || e));
      return '';
    }
  }

  // ===== 绑定批次管理面板事件 =====
  function bindBatchPanelEvents(project) {
    try {
      // 新建批次按钮
      var createBtn = qs('createBatchBtn');
      if (createBtn) {
        createBtn.addEventListener('click', function () {
          try {
            createBatch(project);
          } catch (e) {
            log('ERROR', 'create batch btn failed: ' + (e.message || e));
          }
        });
      }

      var panel = qs('projectBatchPanel');
      if (!panel) return;

      // 折叠/展开批次卡片
      var toggleBtns = panel.querySelectorAll('[data-action="toggle-batch"]');
      for (var ti = 0; ti < toggleBtns.length; ti++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var batchId = btn.getAttribute('data-batch-id');
              toggleBatchExpand(batchId);
              refreshBatchPanel(project);
            } catch (err) {
              log('ERROR', 'toggle batch failed: ' + (err.message || err));
            }
          });
        })(toggleBtns[ti]);
      }

      // 删除批次
      var delBtns = panel.querySelectorAll('[data-action="delete-batch"]');
      for (var i = 0; i < delBtns.length; i++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var batchId = btn.getAttribute('data-batch-id');
              if (batchId) deleteBatch(project, batchId);
            } catch (err) {
              log('ERROR', 'delete batch btn failed: ' + (err.message || err));
            }
          });
        })(delBtns[i]);
      }

      // 设置批次工作目录
      var workDirBtns = panel.querySelectorAll('[data-action="set-batch-workdir"]');
      for (var wi = 0; wi < workDirBtns.length; wi++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var batchId = btn.getAttribute('data-batch-id');
              var batch = findBatchById(project, batchId);
              if (batch) setBatchWorkDir(project, batch);
            } catch (err) {
              log('ERROR', 'set batch workdir failed: ' + (err.message || err));
            }
          });
        })(workDirBtns[wi]);
      }

      // 导入轨迹到批次
      var importBtns = panel.querySelectorAll('[data-action="import-to-batch"]');
      for (var ii = 0; ii < importBtns.length; ii++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var batchId = btn.getAttribute('data-batch-id');
              // 清除高亮标记
              if (state.highlightBatchId) {
                delete state.highlightBatchId;
              }
              importVideosToBatch(project, batchId);
            } catch (err) {
              log('ERROR', 'import to batch failed: ' + (err.message || err));
            }
          });
        })(importBtns[ii]);
      }

      // 批量预处理（当前批次所有视频）
      var batchProcessBtns = panel.querySelectorAll('[data-action="batch-process"]');
      for (var bi = 0; bi < batchProcessBtns.length; bi++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var batchId = btn.getAttribute('data-batch-id');
              runBatchProcessForBatch(project, batchId);
            } catch (err) {
              log('ERROR', 'batch process failed: ' + (err.message || err));
            }
          });
        })(batchProcessBtns[bi]);
      }

      // 批量标注（启动批次连续标注模式）
      var annotateBatchBtns = panel.querySelectorAll('[data-action="start-annotate-batch"]');
      for (var ai = 0; ai < annotateBatchBtns.length; ai++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var batchId = btn.getAttribute('data-batch-id');
              startBatchAnnotate(project, batchId);
            } catch (err) {
              log('ERROR', 'start batch annotate failed: ' + (err.message || err));
            }
          });
        })(annotateBatchBtns[ai]);
      }

      // 单个视频操作：预处理 / 标注 / 删除
      var videoActionBtns = panel.querySelectorAll('[data-action="process-video"], [data-action="annotate-video"], [data-action="delete-video"]');
      for (var va = 0; va < videoActionBtns.length; va++) {
        (function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
              var action = btn.getAttribute('data-action');
              var videoId = btn.getAttribute('data-video-id');
              var video = findVideoInProject(project, videoId);
              if (!video) return;
              if (action === 'process-video') {
                processSingleVideo(project, videoId);
              } else if (action === 'annotate-video') {
                startAnnotateFromProject(project, videoId);
              } else if (action === 'delete-video') {
                deleteVideoFromProject(project, videoId);
              }
            } catch (err) {
              log('ERROR', 'video action failed: ' + (err.message || err));
            }
          });
        })(videoActionBtns[va]);
      }
    } catch (e) {
      log('ERROR', 'bindBatchPanelEvents failed: ' + (e.message || e));
    }
  }

  // ===== 切换批次展开状态 =====
  function toggleBatchExpand(batchId) {
    try {
      if (!state.expandedBatchIds) state.expandedBatchIds = {};
      if (state.expandedBatchIds[batchId]) {
        delete state.expandedBatchIds[batchId];
      } else {
        state.expandedBatchIds[batchId] = true;
      }
    } catch (e) {
      log('ERROR', 'toggleBatchExpand failed: ' + (e.message || e));
    }
  }

  // ===== 按 ID 查找批次 =====
  function findBatchById(project, batchId) {
    try {
      if (!project || !Array.isArray(project.batches) || !batchId) return null;
      for (var i = 0; i < project.batches.length; i++) {
        if (project.batches[i] && project.batches[i].id === batchId) {
          return project.batches[i];
        }
      }
      return null;
    } catch (e) {
      log('ERROR', 'findBatchById failed: ' + (e.message || e));
      return null;
    }
  }

  // ===== 导入轨迹到指定批次 =====
  function importVideosToBatch(project, batchId) {
    try {
      if (!project || !batchId) {
        log('WARN', 'importVideosToBatch: no project or batchId');
        return;
      }
      var batch = findBatchById(project, batchId);
      if (!batch) {
        log('WARN', 'importVideosToBatch: batch not found: ' + batchId);
        return;
      }
      log('IMPORT', 'importVideosToBatch: batchId=' + batchId);
      // 复用 startImportWithBatch（已选定批次的导入流程）
      startImportWithBatch(project, batchId);
    } catch (e) {
      log('ERROR', 'importVideosToBatch failed: ' + (e.message || e));
    }
  }

  // ===== 对指定批次的所有视频进行批量预处理 =====
  function runBatchProcessForBatch(project, batchId) {
    try {
      if (!project || !batchId) return;
      var batch = findBatchById(project, batchId);
      if (!batch || !Array.isArray(batch.video_ids) || batch.video_ids.length === 0) {
        showToast(tt('annotate.project.no_videos_in_batch', '该批次暂无轨迹'));
        return;
      }
      // 拦截：工作目录必须设置后才可以预处理
      if (!batch.work_dir_name) {
        log('WARN', 'runBatchProcessForBatch: work_dir not set, batch=' + batchId);
        showToast(tt('annotate.project.work_dir_required_for_process',
          '请先设置该批次的工作目录，再进行预处理'));
        return;
      }
      // 收集该批次的视频 ID
      var videoIds = batch.video_ids.slice();
      log('PROCESS', 'runBatchProcessForBatch: batch=' + batchId + ' videos=' + videoIds.length);
      runBatchProcess(project, videoIds);
    } catch (e) {
      log('ERROR', 'runBatchProcessForBatch failed: ' + (e.message || e));
    }
  }

  // ===== 对单个视频进行预处理（复用 runBatchProcess，传入单元素列表） =====
  function processSingleVideo(project, videoId) {
    try {
      if (!project || !videoId) {
        log('WARN', 'processSingleVideo: no project or videoId');
        return;
      }
      var video = findVideoInProject(project, videoId);
      if (!video) {
        log('WARN', 'processSingleVideo: video not found: ' + videoId);
        return;
      }
      if (video.processed_file) {
        showToast(tt('annotate.project.already_processed',
          '该视频已预处理，如需重新处理请先删除预处理结果'));
        return;
      }
      // 拦截：视频所属批次的工作目录必须设置后才可以预处理
      if (video.batch_id) {
        var batch = findBatchById(project, video.batch_id);
        if (!batch || !batch.work_dir_name) {
          log('WARN', 'processSingleVideo: work_dir not set, batch=' + video.batch_id);
          showToast(tt('annotate.project.work_dir_required_for_process',
            '请先设置该视频所属批次的工作目录，再进行预处理'));
          return;
        }
      } else {
        // 无批次归属的视频不允许预处理（批次是预处理的前提）
        log('WARN', 'processSingleVideo: video has no batch, video=' + videoId);
        showToast(tt('annotate.project.no_batch_for_process',
          '该视频未归属任何批次，无法预处理'));
        return;
      }
      log('PROCESS', 'processSingleVideo: id=' + videoId);
      runBatchProcess(project, [videoId]);
    } catch (e) {
      log('ERROR', 'processSingleVideo failed: ' + (e.message || e));
    }
  }

  // ===== 创建批次 =====
  function createBatch(project) {
    try {
      if (!project) return;
      if (!Array.isArray(project.batches)) project.batches = [];

      // 默认值：从项目 data_source 和 device_config 带入
      var defaultDataSource = project.data_source || '';
      var defaultFrameName = (project.device_config && Array.isArray(project.device_config.frame_name))
        ? project.device_config.frame_name.join(', ') : '';
      var defaultSubCam = (project.device_config && project.device_config.instruction_sub_camera) || '';

      // 构建弹窗表单
      var bodyHtml = '<div class="annotate-batch-meta-form">' +
        '<p class="annotate-batch-meta-hint">' +
          tt('annotate.project.batch_meta_hint', '填写批次元信息，进入标注时将自动继承到元信息表单') +
        '</p>' +
        '<div class="annotate-form-row">' +
          '<label>' + tt('annotate.meta_info.data_source', '数据来源 (data_source)') + '</label>' +
          '<input type="text" id="batchMetaDataSource" class="annotate-input" value="' + escapeHtml(defaultDataSource) +
            '" placeholder="如：AIX-Office-v1">' +
        '</div>' +
        '<div class="annotate-form-row">' +
          '<label>' + tt('annotate.meta_info.frame_name', '相机名 (frame_name)') + '</label>' +
          '<input type="text" id="batchMetaFrameName" class="annotate-input" value="' + escapeHtml(defaultFrameName) +
            '" placeholder="cam_0, cam_1, ...">' +
        '</div>' +
        '<div class="annotate-form-row">' +
          '<label>' + tt('annotate.meta_info.instruction_sub_camera', '指令相机 (instruction_sub_camera)') + '</label>' +
          '<input type="text" id="batchMetaSubCam" class="annotate-input" value="' + escapeHtml(defaultSubCam) +
            '" placeholder="cam_0">' +
        '</div>' +
        '<div class="annotate-form-row annotate-form-row-inline">' +
          '<label>' + tt('annotate.meta_info.task_success', '任务成功 (task_success)') + '</label>' +
          '<input type="checkbox" id="batchMetaTaskSuccess" checked>' +
        '</div>' +
        '<div class="annotate-form-row">' +
          '<label>' + tt('annotate.meta_info.task_horizon', '任务时长类型 (task_horizon)') + '</label>' +
          '<select id="batchMetaTaskHorizon" class="annotate-input">' +
            '<option value="NA">' + tt('annotate.meta_info.task_horizon_na', 'NA') + '</option>' +
            '<option value="short">' + tt('annotate.meta_info.task_horizon_short', 'short') + '</option>' +
            '<option value="long">' + tt('annotate.meta_info.task_horizon_long', 'long') + '</option>' +
          '</select>' +
        '</div>' +
      '</div>';

      showModal({
        title: tt('annotate.project.create_batch_title', '创建批次并填写元信息'),
        body: bodyHtml,
        confirmText: tt('annotate.project.create', '创建'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            // 读取表单值
            var dataSourceInput = document.getElementById('batchMetaDataSource');
            var frameNameInput = document.getElementById('batchMetaFrameName');
            var subCamInput = document.getElementById('batchMetaSubCam');
            var taskSuccessInput = document.getElementById('batchMetaTaskSuccess');
            var taskHorizonInput = document.getElementById('batchMetaTaskHorizon');

            // frame_name 按逗号分隔成数组
            var frameNameRaw = frameNameInput ? frameNameInput.value.trim() : '';
            var frameNameArr = frameNameRaw
              ? frameNameRaw.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; })
              : [];

            var batchId = genSequentialId('batch', project.batches);
            var batch = {
              id: batchId,
              name: batchId,
              created_at: new Date().toISOString(),
              video_ids: [],
              meta_info: {
                data_source: dataSourceInput ? dataSourceInput.value.trim() : '',
                frame_name: frameNameArr,
                instruction_sub_camera: subCamInput ? subCamInput.value.trim() : '',
                task_success: taskSuccessInput ? !!taskSuccessInput.checked : true,
                task_horizon: taskHorizonInput ? taskHorizonInput.value : 'NA'
              }
            };
            project.batches.push(batch);
            saveProjects();
            // 自动展开新建批次 + 高亮导入按钮
            if (!state.expandedBatchIds) state.expandedBatchIds = {};
            state.expandedBatchIds[batchId] = true;
            state.highlightBatchId = batchId;
            // 重新渲染批次面板
            refreshBatchPanel(project);
            // 重新渲染流程向导
            var wizardBox = dom.projectDetailView ?
              dom.projectDetailView.querySelector('.annotate-process-wizard') : null;
            if (wizardBox && wizardBox.parentNode) {
              var newWizard = document.createElement('div');
              newWizard.innerHTML = renderProcessWizard(project).trim();
              if (newWizard.firstChild) {
                wizardBox.parentNode.replaceChild(newWizard.firstChild, wizardBox);
                bindProcessWizard(project);
              }
            }
            hideModal();
            showToast(tt('annotate.project.batch_created', '批次已创建: ') + batchId);
            log('BATCH', 'createBatch: ' + batchId + ' meta_info=' + JSON.stringify(batch.meta_info));
          } catch (e) {
            log('ERROR', 'createBatch onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'createBatch failed: ' + (e.message || e));
    }
  }

  // ===== 把 videoId 加入到指定批次（去重） =====
  function addVideoIdToBatch(project, batchId, videoId) {
    try {
      if (!project || !batchId || !videoId) return false;
      if (!Array.isArray(project.batches)) return false;
      for (var i = 0; i < project.batches.length; i++) {
        var b = project.batches[i];
        if (b && b.id === batchId) {
          if (!Array.isArray(b.video_ids)) b.video_ids = [];
          if (b.video_ids.indexOf(videoId) === -1) {
            b.video_ids.push(videoId);
            log('BATCH', 'addVideoIdToBatch: batch=' + batchId + ' video=' + videoId);
          }
          return true;
        }
      }
      log('WARN', 'addVideoIdToBatch: batch not found: ' + batchId);
      return false;
    } catch (e) {
      log('ERROR', 'addVideoIdToBatch failed: ' + (e.message || e));
      return false;
    }
  }

  // ===== 从所有批次中移除指定 videoId（删除视频时调用） =====
  function removeVideoIdFromAllBatches(project, videoId) {
    try {
      if (!project || !videoId || !Array.isArray(project.batches)) return 0;
      var removedCount = 0;
      for (var i = 0; i < project.batches.length; i++) {
        var b = project.batches[i];
        if (b && Array.isArray(b.video_ids)) {
          var idx = b.video_ids.indexOf(videoId);
          if (idx >= 0) {
            b.video_ids.splice(idx, 1);
            removedCount++;
            log('BATCH', 'removeVideoIdFromAllBatches: batch=' + b.id + ' video=' + videoId);
          }
        }
      }
      return removedCount;
    } catch (e) {
      log('ERROR', 'removeVideoIdFromAllBatches failed: ' + (e.message || e));
      return 0;
    }
  }

  // ===== 删除批次（二次确认） =====
  function deleteBatch(project, batchId) {
    try {
      var batch = null;
      for (var i = 0; i < (project.batches || []).length; i++) {
        if (project.batches[i] && project.batches[i].id === batchId) {
          batch = project.batches[i]; break;
        }
      }
      if (!batch) {
        log('WARN', 'deleteBatch: batch not found, id=' + batchId);
        return;
      }
      showModal({
        title: tt('annotate.project.delete_batch_title', '删除批次'),
        body: '<p>' + tt('annotate.project.delete_batch_body',
          '确认删除批次「{id}」？批次内视频将移除轨迹编号。此操作不可撤销。')
          .replace('{id}', escapeHtml(batchId)) + '</p>',
        confirmText: tt('annotate.project.delete_btn', '删除'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            // 清空批次内视频的 trajectory_index 和 batch_id
            var videoIds = Array.isArray(batch.video_ids) ? batch.video_ids : [];
            for (var v = 0; v < videoIds.length; v++) {
              var vid = videoIds[v];
              var video = findVideoInProject(project, vid);
              if (video) {
                video.trajectory_index = '';
                video.batch_id = '';
              }
            }
            // 从 batches 列表移除
            var idx = -1;
            for (var j = 0; j < (project.batches || []).length; j++) {
              if (project.batches[j] && project.batches[j].id === batchId) {
                idx = j; break;
              }
            }
            if (idx >= 0) {
              project.batches.splice(idx, 1);
            }
            saveProjects();
            refreshBatchPanel(project);
            updateVideoListOnly(project);
            showToast(tt('annotate.project.batch_deleted', '批次已删除'));
            log('BATCH', 'deleteBatch: ' + batchId);
            hideModal();
          } catch (e) {
            log('ERROR', 'deleteBatch onConfirm failed: ' + (e.message || e));
            hideModal();
          }
        }
      });
    } catch (e) {
      log('ERROR', 'deleteBatch failed: ' + (e.message || e));
    }
  }

  // ===== 刷新批次面板（局部） =====
  function refreshBatchPanel(project) {
    try {
      var panel = qs('projectBatchPanel');
      if (!panel) return;
      var newHtml = renderBatchPanelHtml(project);
      panel.innerHTML = newHtml.substring('<div class="annotate-batch-panel">'.length,
        newHtml.length - '</div>'.length);
      // 上面 substring 是去除最外层 div 包裹，直接整体替换更简单：
      panel.innerHTML = newHtml;
      // 重新绑定事件
      bindBatchPanelEvents(project);
      // 更新计数
      var countEl = qs('projectBatchesCount');
      if (countEl) {
        countEl.textContent = (Array.isArray(project.batches) ? project.batches.length : 0);
      }
    } catch (e) {
      log('ERROR', 'refreshBatchPanel failed: ' + (e.message || e));
    }
  }

  // ===== 显示"将视频加入批次"弹窗 =====
  function showAddVideoToBatchModal(project, videoId) {
    try {
      var video = findVideoInProject(project, videoId);
      if (!video) return;
      var batches = project.batches || [];
      if (batches.length === 0) {
        showToast(tt('annotate.project.no_batch_first', '请先创建批次'));
        return;
      }
      // 构建 batch 选项 HTML
      var optionsHtml = '';
      for (var i = 0; i < batches.length; i++) {
        var b = batches[i];
        var sel = (video.batch_id === b.id) ? 'selected' : '';
        optionsHtml += '<option value="' + escapeHtml(b.id) + '"' + sel + '>' +
          escapeHtml(b.id) + (b.name ? ' (' + escapeHtml(b.name) + ')' : '') +
          '</option>';
      }
      var body =
        '<div class="annotate-modal-form">' +
          '<p class="annotate-modal-form-hint">' +
            tt('annotate.project.add_to_batch_hint', '选择批次，系统将自动分配轨迹编号（同批次内不重复）') +
          '</p>' +
          '<div class="annotate-form-field">' +
            '<label data-i18n="annotate.project.select_batch">选择批次</label>' +
            '<select id="addToBatchSelect" class="annotate-input">' +
              '<option value="">' + tt('annotate.project.select_batch_placeholder', '-- 选择批次 --') + '</option>' +
              optionsHtml +
            '</select>' +
          '</div>' +
          (video.batch_id ?
            '<p class="annotate-modal-form-current">' +
              tt('annotate.project.current_batch', '当前批次') + ': ' + escapeHtml(video.batch_id) +
              ' · ' + tt('annotate.project.current_traj', '轨迹') + ': ' + escapeHtml(video.trajectory_index || '-') +
            '</p>' : '') +
        '</div>';

      showModal({
        title: tt('annotate.project.add_to_batch_title', '将视频加入批次'),
        body: body,
        confirmText: tt('annotate.modal_confirm', '确认'),
        cancelText: tt('annotate.modal_cancel', '取消'),
        onConfirm: function () {
          try {
            var select = qs('addToBatchSelect');
            var newBatchId = select ? select.value : '';
            if (!newBatchId) {
              showToast(tt('annotate.project.select_batch_first', '请选择批次'));
              return false; // 不关闭弹窗
            }
            addVideoToBatch(project, videoId, newBatchId);
            hideModal();
          } catch (e) {
            log('ERROR', 'add to batch confirm failed: ' + (e.message || e));
            hideModal();
          }
          return true;
        }
      });
    } catch (e) {
      log('ERROR', 'showAddVideoToBatchModal failed: ' + (e.message || e));
    }
  }

  // ===== 将视频加入批次，自动分配 trajectory_index =====
  function addVideoToBatch(project, videoId, batchId) {
    try {
      var video = findVideoInProject(project, videoId);
      if (!video) return;
      var batch = null;
      for (var i = 0; i < (project.batches || []).length; i++) {
        if (project.batches[i] && project.batches[i].id === batchId) {
          batch = project.batches[i]; break;
        }
      }
      if (!batch) {
        showToast(tt('annotate.project.batch_not_found', '批次未找到'));
        return;
      }
      if (!Array.isArray(batch.video_ids)) batch.video_ids = [];

      // 如果视频已在其他批次，先从原批次移除
      if (video.batch_id && video.batch_id !== batchId) {
        var oldBatch = null;
        for (var j = 0; j < (project.batches || []).length; j++) {
          if (project.batches[j] && project.batches[j].id === video.batch_id) {
            oldBatch = project.batches[j]; break;
          }
        }
        if (oldBatch && Array.isArray(oldBatch.video_ids)) {
          var idx = oldBatch.video_ids.indexOf(videoId);
          if (idx >= 0) oldBatch.video_ids.splice(idx, 1);
        }
      }

      // 如果已在当前批次，不重复添加
      if (video.batch_id === batchId && video.trajectory_index) {
        showToast(tt('annotate.project.already_in_batch', '视频已在此批次') + ' (traj=' + video.trajectory_index + ')');
        return;
      }

      // 分配新的 trajectory_index（同批次内不重复）
      var newTraj = allocateTrajectoryIndex(project, batch);
      video.batch_id = batchId;
      video.trajectory_index = newTraj;
      if (batch.video_ids.indexOf(videoId) < 0) {
        batch.video_ids.push(videoId);
      }
      saveProjects();
      updateVideoListOnly(project);
      showToast(tt('annotate.project.added_to_batch', '已加入批次 {id}，轨迹编号 {traj}')
        .replace('{id}', batchId).replace('{traj}', newTraj));
      log('BATCH', 'addVideoToBatch: video=' + videoId + ' batch=' + batchId + ' traj=' + newTraj);
    } catch (e) {
      log('ERROR', 'addVideoToBatch failed: ' + (e.message || e));
    }
  }

  // ===== 分配 trajectory_index（traj_001 格式，同批次内不重复） =====
  function allocateTrajectoryIndex(project, batch) {
    try {
      // 采集日期：优先从 meta_info.date 获取，否则用当天日期
      var dateStr = '';
      if (project.meta_info && project.meta_info.date) {
        dateStr = String(project.meta_info.date).replace(/-/g, '');
      } else {
        var now = new Date();
        dateStr = '' + now.getFullYear() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0');
      }
      // 收集该批次内已使用的序号
      var usedNum = {};
      if (Array.isArray(batch.video_ids)) {
        for (var i = 0; i < batch.video_ids.length; i++) {
          var v = findVideoInProject(project, batch.video_ids[i]);
          if (v && v.trajectory_index) {
            // 解析已有 trajectory_index 的序号部分
            var match = String(v.trajectory_index).match(/_(\d+)$/);
            if (match) {
              usedNum[parseInt(match[1], 10)] = true;
            }
          }
        }
      }
      // 从 001 开始寻找第一个未使用的
      var idx = 1;
      while (true) {
        if (!usedNum[idx]) {
          return dateStr + '_' + String(idx).padStart(3, '0');
        }
        idx++;
        if (idx > 99999) break; // 安全上限
      }
      return dateStr + '_' + Date.now().toString(36); // 兜底
    } catch (e) {
      log('ERROR', 'allocateTrajectoryIndex failed: ' + (e.message || e));
      var now = new Date();
      var fallback = '' + now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '_001';
      return fallback;
    }
  }

  // ==========================================================================
  // 阶段 5：meta_info 表单（步骤 2）
  // ==========================================================================

  // ===== 回填 meta_info 表单 =====
  function fillMetaInfoForm() {
    try {
      var mi = state.meta_info || {};
      if (dom.metaDataSourceInput) dom.metaDataSourceInput.value = mi.data_source || '';
      if (dom.metaTrajectoryIndexInput) dom.metaTrajectoryIndexInput.value = mi.trajectory_index || '';
      if (dom.metaFpsInput) dom.metaFpsInput.value = mi.fps || 30;
      if (dom.metaNumFramesInput) dom.metaNumFramesInput.value = mi.num_frames || 0;
      if (dom.metaFrameNameInput) {
        // frame_name 是数组，用逗号分隔显示
        dom.metaFrameNameInput.value = Array.isArray(mi.frame_name) ? mi.frame_name.join(', ') : '';
      }
      if (dom.metaInstructionSubCameraInput) dom.metaInstructionSubCameraInput.value = mi.instruction_sub_camera || '';
      if (dom.metaTaskSuccessInput) dom.metaTaskSuccessInput.checked = (mi.task_success !== false);
      if (dom.metaTaskHorizonInput) dom.metaTaskHorizonInput.value = mi.task_horizon || 'NA';
      log('META_INFO', 'fillMetaInfoForm: data_source=' + mi.data_source + ' traj=' + mi.trajectory_index +
        ' fps=' + mi.fps + ' frames=' + mi.num_frames);
    } catch (e) {
      log('ERROR', 'fillMetaInfoForm failed: ' + (e.message || e));
    }
  }

  // ===== 绑定 meta_info 表单事件 =====
  function bindMetaInfoForm() {
    try {
      var fields = [
        { el: dom.metaDataSourceInput, key: 'data_source' },
        { el: dom.metaTrajectoryIndexInput, key: 'trajectory_index' },
        { el: dom.metaFpsInput, key: 'fps', isNumber: true },
        { el: dom.metaNumFramesInput, key: 'num_frames', isNumber: true, isInt: true },
        { el: dom.metaInstructionSubCameraInput, key: 'instruction_sub_camera' },
        { el: dom.metaTaskHorizonInput, key: 'task_horizon' }
      ];
      for (var i = 0; i < fields.length; i++) {
        (function (f) {
          if (!f.el) return;
          function handleValue() {
            try {
              var val = f.el.value;
              if (f.isNumber) {
                var n = f.isInt ? parseInt(val, 10) : parseFloat(val);
                if (isNaN(n) || n < 0) n = 0;
                val = n;
                if (f.key === 'fps' && n <= 0) {
                  n = 30;
                  if (f.el) f.el.value = '30';
                  val = 30;
                }
              }
              state.meta_info[f.key] = val;
              // fps 联动 totalFrames
              if (f.key === 'fps') {
                state.fps = val;
                if (state.videoDuration > 0) {
                  var oldTotal = state.totalFrames;
                  state.totalFrames = Math.round(state.videoDuration * state.fps);
                  if (oldTotal !== state.totalFrames) {
                    log('META_INFO', 'totalFrames recalculated: ' + oldTotal + ' -> ' + state.totalFrames);
                    updateFrameDisplay();
                  }
                }
              }
              log('META_INFO', f.key + ' = ' + val);
              saveToLocalStorage();
            } catch (e) {
              log('ERROR', 'meta_info field handler failed for ' + f.key + ': ' + (e.message || e));
            }
          }
          f.el.addEventListener('input', handleValue);
          f.el.addEventListener('change', handleValue);
        })(fields[i]);
      }

      // frame_name 输入（逗号分隔的字符串 → 数组）
      if (dom.metaFrameNameInput) {
        dom.metaFrameNameInput.addEventListener('input', function () {
          try {
            var raw = dom.metaFrameNameInput.value || '';
            var arr = raw.split(',').map(function (s) { return s.trim(); })
              .filter(function (s) { return s.length > 0; });
            state.meta_info.frame_name = arr;
            log('META_INFO', 'frame_name = [' + arr.join(', ') + ']');
            saveToLocalStorage();
          } catch (e) {
            log('ERROR', 'frame_name input handler failed: ' + (e.message || e));
          }
        });
      }

      // task_success checkbox
      if (dom.metaTaskSuccessInput) {
        dom.metaTaskSuccessInput.addEventListener('change', function () {
          try {
            state.meta_info.task_success = !!dom.metaTaskSuccessInput.checked;
            log('META_INFO', 'task_success = ' + state.meta_info.task_success);
            saveToLocalStorage();
          } catch (e) {
            log('ERROR', 'task_success handler failed: ' + (e.message || e));
          }
        });
      }
    } catch (e) {
      log('ERROR', 'bindMetaInfoForm failed: ' + (e.message || e));
    }
  }

  // ===== 折叠面板事件绑定 =====
  function bindAccordionEvents(root) {
    try {
      var headers = (root || document).querySelectorAll('.annotate-accordion-header');
      for (var i = 0; i < headers.length; i++) {
        (function (header) {
          header.addEventListener('click', function () {
            try {
              var targetId = header.getAttribute('data-target');
              if (!targetId) return;
              var body = document.getElementById(targetId);
              if (!body) return;
              var isCollapsed = header.classList.contains('collapsed');
              if (isCollapsed) {
                header.classList.remove('collapsed');
                body.classList.remove('collapsed');
                body.style.display = '';
              } else {
                header.classList.add('collapsed');
                body.classList.add('collapsed');
                body.style.display = 'none';
              }
            } catch (e) {
              log('ERROR', 'accordion header click failed: ' + (e.message || e));
            }
          });
        })(headers[i]);
      }
    } catch (e) {
      log('ERROR', 'bindAccordionEvents failed: ' + (e.message || e));
    }
  }

  // ===== 直接标注模式（无项目）入口 =====
  function enterDirectAnnotateMode() {
    try {
      state.mode = 'direct';
      state.currentProject = null;
      state.currentVideo = null;
      state.project_id = null;
      state.video_id = null;
      state.device_config = null;
      state.currentStep = 1;
      // 清空视频运行时状态（File 对象不可持久化，刷新后需重新选择）
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
      state.isPlaying = false;
      // meta_info 保持默认
      state.meta_info = {
        data_source: '',
        trajectory_index: '',
        fps: 30,
        num_frames: 0,
        frame_name: [],
        instruction_sub_camera: '',
        task_success: true,
        task_horizon: 'NA'
      };
      hideProjectPanelAndShowAnnotate();
      // 重置步骤 1 UI（隐藏旧文件信息，显示上传区）
      if (dom.fileInfo) dom.fileInfo.setAttribute('hidden', '');
      if (dom.uploadZone) dom.uploadZone.removeAttribute('hidden');
      if (dom.fileName) dom.fileName.textContent = '';
      goToStep(1);
      // 清空 IndexedDB 中的 direct_video handle（进入全新直接标注，旧句柄不再需要）
      if (FS_ACCESS_SUPPORTED) {
        fsDeleteHandle('direct_video').catch(function (err) {
          log('WARN', 'enterDirectAnnotateMode: fsDeleteHandle direct_video failed: ' + (err.message || err));
        });
      }
      log('PROJECT', 'enterDirectAnnotateMode: switched to direct mode (video state cleared)');
      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'enterDirectAnnotateMode failed: ' + (e.message || e));
    }
  }

  // ===== 返回项目面板（从标注模式） =====
  function backToProjectPanel() {
    try {
      if (!state.project_id) {
        log('WARN', 'backToProjectPanel: no project_id, cannot return');
        return;
      }
      // 恢复 mode
      state.mode = 'project';
      showProjectPanel();
      showProjectListView();
      log('PROJECT', 'backToProjectPanel');
      saveToLocalStorage();
    } catch (e) {
      log('ERROR', 'backToProjectPanel failed: ' + (e.message || e));
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
    // 阶段 1-5：项目管理 API
    createProject: createProject,
    deleteProject: deleteProject,
    selectProject: selectProject,
    saveProjects: saveProjects,
    loadProjects: loadProjects,
    renderProjectList: renderProjectList,
    renderProjectDetail: renderProjectDetail,
    showProjectListView: showProjectListView,
    showProjectDetailView: showProjectDetailView,
    showNewProjectFormView: showNewProjectFormView,
    showProjectPanel: showProjectPanel,
    hideProjectPanelAndShowAnnotate: hideProjectPanelAndShowAnnotate,
    enterDirectAnnotateMode: enterDirectAnnotateMode,
    backToProjectPanel: backToProjectPanel,
    handleProjectVideoImport: handleProjectVideoImport,
    startAnnotateFromProject: startAnnotateFromProject,
    fillMetaInfoForm: fillMetaInfoForm,
    bindMetaInfoForm: bindMetaInfoForm,
    findProjectById: findProjectById,
    findVideoInProject: findVideoInProject,
    createDefaultDeviceConfig: createDefaultDeviceConfig,
    createBatch: createBatch,
    deleteBatch: deleteBatch,
    addVideoToBatch: addVideoToBatch,
    allocateTrajectoryIndex: allocateTrajectoryIndex,
    genId: genId,
    genSequentialId: genSequentialId,
    escapeHtml: escapeHtml,
    formatDateTime: formatDateTime,
    DEFAULT_THUMBNAIL: DEFAULT_THUMBNAIL,
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
