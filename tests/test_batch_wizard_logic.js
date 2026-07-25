/*!
 * 测试：批次流程核心逻辑（不依赖 DOM，纯逻辑测试）
 * 运行：node tests/test_batch_wizard_logic.js
 */
(function () {
  'use strict';

  // 模拟 addVideoIdToBatch 的核心逻辑
  function addVideoIdToBatch(project, batchId, videoId) {
    if (!project || !batchId || !videoId) return false;
    if (!Array.isArray(project.batches)) return false;
    for (var i = 0; i < project.batches.length; i++) {
      var b = project.batches[i];
      if (b && b.id === batchId) {
        if (!Array.isArray(b.video_ids)) b.video_ids = [];
        if (b.video_ids.indexOf(videoId) === -1) {
          b.video_ids.push(videoId);
        }
        return true;
      }
    }
    return false;
  }

  // 模拟 renderProcessWizard 的状态判定逻辑
  function computeWizardStep(project) {
    var hasWorkDir = !!(project && project.work_dir_name);
    var batches = (project && Array.isArray(project.batches)) ? project.batches : [];
    var batchCount = batches.length;
    var hasBatch = batchCount > 0;
    var videos = (project && Array.isArray(project.videos)) ? project.videos : [];
    var hasVideos = videos.length > 0;
    var hasProcessed = false;
    for (var i = 0; i < videos.length; i++) {
      if (videos[i] && videos[i].processed_file) { hasProcessed = true; break; }
    }

    var currentStep;
    if (!hasWorkDir) currentStep = 1;
    else if (!hasBatch) currentStep = 2;
    else if (!hasVideos) currentStep = 3;
    else if (!hasProcessed) currentStep = 4;
    else currentStep = 5;

    var step1State = hasWorkDir ? 'done' : 'current';
    var step2State = hasBatch ? 'done' : (hasWorkDir ? 'current' : 'pending');
    var step3State = hasVideos ? 'done' : (hasBatch ? 'current' : 'pending');
    var step4State = hasProcessed ? 'done' : 'skip';
    var step5State = hasVideos ? 'current' : 'pending';

    return {
      currentStep: currentStep,
      steps: [step1State, step2State, step3State, step4State, step5State]
    };
  }

  // ===== 测试用例 =====
  var passed = 0;
  var failed = 0;

  function assertEqual(actual, expected, msg) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a === e) {
      console.log('  [PASS] ' + msg);
      passed++;
    } else {
      console.log('  [FAIL] ' + msg);
      console.log('         expected: ' + e);
      console.log('         actual:   ' + a);
      failed++;
    }
  }

  function assertTrue(cond, msg) {
    if (cond) {
      console.log('  [PASS] ' + msg);
      passed++;
    } else {
      console.log('  [FAIL] ' + msg);
      failed++;
    }
  }

  console.log('\n=== 测试 1: addVideoIdToBatch 正常路径 ===');
  (function () {
    var project = {
      batches: [
        { id: 'batch_001', name: 'Batch 1', video_ids: [] },
        { id: 'batch_002', name: 'Batch 2', video_ids: [] }
      ]
    };
    var ok = addVideoIdToBatch(project, 'batch_001', 'vid_001');
    assertTrue(ok, '应返回 true');
    assertEqual(project.batches[0].video_ids, ['vid_001'], 'video_ids 应包含 vid_001');
    assertEqual(project.batches[1].video_ids, [], '其他批次不应被影响');
  })();

  console.log('\n=== 测试 2: addVideoIdToBatch 去重 ===');
  (function () {
    var project = {
      batches: [{ id: 'batch_001', video_ids: ['vid_001'] }]
    };
    addVideoIdToBatch(project, 'batch_001', 'vid_001');
    assertEqual(project.batches[0].video_ids, ['vid_001'], '重复添加不应增加');
    addVideoIdToBatch(project, 'batch_001', 'vid_002');
    assertEqual(project.batches[0].video_ids, ['vid_001', 'vid_002'], '不同 ID 应正常添加');
  })();

  console.log('\n=== 测试 3: addVideoIdToBatch 边界（批次不存在/参数缺失） ===');
  (function () {
    var project = { batches: [{ id: 'batch_001', video_ids: [] }] };
    assertFalse(addVideoIdToBatch(project, 'batch_xxx', 'vid_001'), '批次不存在应返回 false');
    assertFalse(addVideoIdToBatch(null, 'batch_001', 'vid_001'), 'project 为空应返回 false');
    assertFalse(addVideoIdToBatch(project, '', 'vid_001'), 'batchId 为空应返回 false');
    assertFalse(addVideoIdToBatch(project, 'batch_001', ''), 'videoId 为空应返回 false');
    assertFalse(addVideoIdToBatch({}, 'batch_001', 'vid_001'), 'project 无 batches 应返回 false');
  })();

  function assertFalse(cond, msg) {
    assertTrue(!cond, msg);
  }

  console.log('\n=== 测试 4: renderProcessWizard 状态判定（全新项目） ===');
  (function () {
    var project = { id: 'p1', work_dir_name: '', batches: [], videos: [] };
    var r = computeWizardStep(project);
    assertEqual(r.currentStep, 1, '无工作目录 → currentStep=1');
    assertEqual(r.steps, ['current', 'pending', 'pending', 'skip', 'pending'], '步骤状态正确');
  })();

  console.log('\n=== 测试 5: renderProcessWizard 状态判定（已设工作目录） ===');
  (function () {
    var project = { id: 'p1', work_dir_name: '/tmp/work', batches: [], videos: [] };
    var r = computeWizardStep(project);
    assertEqual(r.currentStep, 2, '无批次 → currentStep=2');
    assertEqual(r.steps, ['done', 'current', 'pending', 'skip', 'pending'], '步骤状态正确');
  })();

  console.log('\n=== 测试 6: renderProcessWizard 状态判定（已建批次） ===');
  (function () {
    var project = {
      id: 'p1', work_dir_name: '/tmp/work',
      batches: [{ id: 'b1', video_ids: [] }],
      videos: []
    };
    var r = computeWizardStep(project);
    assertEqual(r.currentStep, 3, '有批次无视频 → currentStep=3');
    assertEqual(r.steps, ['done', 'done', 'current', 'skip', 'pending'], '步骤状态正确');
  })();

  console.log('\n=== 测试 7: renderProcessWizard 状态判定（已导入轨迹） ===');
  (function () {
    var project = {
      id: 'p1', work_dir_name: '/tmp/work',
      batches: [{ id: 'b1', video_ids: ['v1'] }],
      videos: [{ id: 'v1', processed_file: '' }]
    };
    var r = computeWizardStep(project);
    assertEqual(r.currentStep, 4, '有视频未预处理 → currentStep=4');
    assertEqual(r.steps, ['done', 'done', 'done', 'skip', 'current'], '步骤状态正确');
  })();

  console.log('\n=== 测试 8: renderProcessWizard 状态判定（已预处理） ===');
  (function () {
    var project = {
      id: 'p1', work_dir_name: '/tmp/work',
      batches: [{ id: 'b1', video_ids: ['v1'] }],
      videos: [{ id: 'v1', processed_file: 'processed/v1_processed.webm' }]
    };
    var r = computeWizardStep(project);
    assertEqual(r.currentStep, 5, '已预处理 → currentStep=5');
    assertEqual(r.steps, ['done', 'done', 'done', 'done', 'current'], '步骤状态正确');
  })();

  console.log('\n=== 测试 9: 模拟完整导入流程 ===');
  (function () {
    var project = {
      id: 'p1', work_dir_name: '/tmp/work',
      batches: [{ id: 'b1', name: 'Batch 1', video_ids: [], created_at: '2026-07-26T00:00:00Z' }],
      videos: []
    };
    // 模拟导入 2 个视频到批次 b1
    var files = [
      { name: 'video1.mp4', size: 1024 },
      { name: 'video2.mp4', size: 2048 }
    ];
    var batchId = 'b1';
    files.forEach(function (f) {
      var videoId = 'vid_' + Math.random().toString(36).substr(2, 9);
      var video = {
        id: videoId,
        file_name: f.name,
        file_size: f.size,
        batch_id: batchId
      };
      project.videos.push(video);
      addVideoIdToBatch(project, batchId, videoId);
    });
    assertEqual(project.videos.length, 2, '应有 2 个视频');
    assertEqual(project.videos[0].batch_id, 'b1', '视频 1 batch_id=b1');
    assertEqual(project.videos[1].batch_id, 'b1', '视频 2 batch_id=b1');
    assertEqual(project.batches[0].video_ids.length, 2, '批次应有 2 个 video_id');

    var r = computeWizardStep(project);
    assertEqual(r.currentStep, 4, '导入后未预处理 → currentStep=4');
  })();

  console.log('\n=== 测试 10: 历史视频 batch_id 为空（兼容性） ===');
  (function () {
    // 模拟用户之前导入的视频，batch_id 为空
    var project = {
      id: 'p1', work_dir_name: '/tmp/work',
      batches: [{ id: 'b1', video_ids: [] }],
      videos: [{ id: 'v_old', batch_id: '' }]
    };
    var r = computeWizardStep(project);
    // 历史视频不影响 wizard 流程判定
    assertEqual(r.currentStep, 4, '有视频 → currentStep=4');
    assertTrue(r.steps[2] === 'done', '步骤 3 应为 done');
  })();

  console.log('\n========================================');
  console.log('测试结果：通过 ' + passed + ' 个，失败 ' + failed + ' 个');
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
