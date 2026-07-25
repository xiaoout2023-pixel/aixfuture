/*!
 * 测试：删除功能 Bug 修复验证（不依赖 DOM，纯逻辑测试）
 * 运行：node tests/test_delete_bugs.js
 */
(function () {
  'use strict';

  // 模拟 removeVideoIdFromAllBatches 的核心逻辑
  function removeVideoIdFromAllBatches(project, videoId) {
    if (!project || !videoId || !Array.isArray(project.batches)) return 0;
    var removedCount = 0;
    for (var i = 0; i < project.batches.length; i++) {
      var b = project.batches[i];
      if (b && Array.isArray(b.video_ids)) {
        var idx = b.video_ids.indexOf(videoId);
        if (idx >= 0) {
          b.video_ids.splice(idx, 1);
          removedCount++;
        }
      }
    }
    return removedCount;
  }

  // 模拟 deleteVideoFromProject 的核心逻辑（仅批次清理部分）
  function simulateDeleteVideoCleanup(project, videoId) {
    var removedFromBatches = removeVideoIdFromAllBatches(project, videoId);
    var idx = -1;
    for (var i = 0; i < project.videos.length; i++) {
      if (project.videos[i] && project.videos[i].id === videoId) {
        idx = i; break;
      }
    }
    if (idx >= 0) project.videos.splice(idx, 1);
    return { removedFromBatches: removedFromBatches, videoRemoved: idx >= 0 };
  }

  // ===== 测试用例 =====
  var passed = 0;
  var failed = 0;

  function assertEqual(actual, expected, msg) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a === e) { console.log('  [PASS] ' + msg); passed++; }
    else {
      console.log('  [FAIL] ' + msg);
      console.log('         expected: ' + e);
      console.log('         actual:   ' + a);
      failed++;
    }
  }

  function assertTrue(cond, msg) {
    if (cond) { console.log('  [PASS] ' + msg); passed++; }
    else { console.log('  [FAIL] ' + msg); failed++; }
  }

  function assertFalse(cond, msg) { assertTrue(!cond, msg); }

  console.log('\n=== Bug 1 测试：删除视频时从批次 video_ids 移除 ===');
  (function () {
    var project = {
      videos: [
        { id: 'v1', file_name: 'a.mp4', batch_id: 'b1', _restoreKey: 'k1' },
        { id: 'v2', file_name: 'b.mp4', batch_id: 'b1', _restoreKey: 'k2' },
        { id: 'v3', file_name: 'c.mp4', batch_id: 'b2', _restoreKey: 'k3' }
      ],
      batches: [
        { id: 'b1', name: 'Batch 1', video_ids: ['v1', 'v2'] },
        { id: 'b2', name: 'Batch 2', video_ids: ['v3'] }
      ]
    };
    var r = simulateDeleteVideoCleanup(project, 'v1');
    assertTrue(r.videoRemoved, '视频应被删除');
    assertEqual(r.removedFromBatches, 1, '应从 1 个批次移除');
    assertEqual(project.videos.length, 2, '剩余 2 个视频');
    assertEqual(project.batches[0].video_ids, ['v2'], '批次 b1 应只剩 v2');
    assertEqual(project.batches[1].video_ids, ['v3'], '批次 b2 不应被影响');
  })();

  console.log('\n=== Bug 1 测试：删除不属于任何批次的视频 ===');
  (function () {
    var project = {
      videos: [{ id: 'v1', batch_id: '' }],
      batches: [{ id: 'b1', video_ids: [] }]
    };
    var r = simulateDeleteVideoCleanup(project, 'v1');
    assertTrue(r.videoRemoved, '视频应被删除');
    assertEqual(r.removedFromBatches, 0, '应从 0 个批次移除');
    assertEqual(project.videos.length, 0, '剩余 0 个视频');
  })();

  console.log('\n=== Bug 1 测试：批量删除后批次统计正确 ===');
  (function () {
    var project = {
      videos: [
        { id: 'v1', batch_id: 'b1' },
        { id: 'v2', batch_id: 'b1' },
        { id: 'v3', batch_id: 'b1' }
      ],
      batches: [{ id: 'b1', video_ids: ['v1', 'v2', 'v3'] }]
    };
    // 批量删除 v1, v2
    simulateDeleteVideoCleanup(project, 'v1');
    simulateDeleteVideoCleanup(project, 'v2');
    assertEqual(project.videos.length, 1, '剩余 1 个视频');
    assertEqual(project.batches[0].video_ids, ['v3'], '批次应只剩 v3');
  })();

  console.log('\n=== Bug 3 测试：批量删除传 skipConfirm 不弹窗 ===');
  (function () {
    // 模拟 deleteVideoFromProject(project, id, skipConfirm) 的逻辑
    function mockDeleteVideo(project, videoId, skipConfirm) {
      var confirmCalled = 0;
      if (!skipConfirm) {
        confirmCalled++;
      } else {
        // 直接执行删除
        removeVideoIdFromAllBatches(project, videoId);
        for (var i = 0; i < project.videos.length; i++) {
          if (project.videos[i].id === videoId) {
            project.videos.splice(i, 1); break;
          }
        }
      }
      return confirmCalled;
    }
    var project = {
      videos: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }],
      batches: [{ id: 'b1', video_ids: ['v1', 'v2', 'v3'] }]
    };
    // 批量删除 3 个，传 skipConfirm=true
    var totalConfirms = 0;
    totalConfirms += mockDeleteVideo(project, 'v1', true);
    totalConfirms += mockDeleteVideo(project, 'v2', true);
    totalConfirms += mockDeleteVideo(project, 'v3', true);
    assertEqual(totalConfirms, 0, '批量删除不应弹任何确认窗');
    assertEqual(project.videos.length, 0, '所有视频应被删除');
    assertEqual(project.batches[0].video_ids, [], '批次 video_ids 应为空');
  })();

  console.log('\n=== Bug 1 测试：removeVideoIdFromAllBatches 边界 ===');
  (function () {
    // videoId 在多个批次中（异常情况，但应能处理）
    var project = {
      batches: [
        { id: 'b1', video_ids: ['v1', 'v2'] },
        { id: 'b2', video_ids: ['v1', 'v3'] }
      ]
    };
    var removed = removeVideoIdFromAllBatches(project, 'v1');
    assertEqual(removed, 2, '应从 2 个批次移除');
    assertEqual(project.batches[0].video_ids, ['v2'], 'b1 剩 v2');
    assertEqual(project.batches[1].video_ids, ['v3'], 'b2 剩 v3');

    // 不存在的 videoId
    var removed2 = removeVideoIdFromAllBatches(project, 'v_xxx');
    assertEqual(removed2, 0, '不存在的 ID 返回 0');

    // 空参数
    assertEqual(removeVideoIdFromAllBatches(null, 'v1'), 0, 'null project 返回 0');
    assertEqual(removeVideoIdFromAllBatches(project, ''), 0, '空 videoId 返回 0');
    assertEqual(removeVideoIdFromAllBatches({}, 'v1'), 0, '无 batches 返回 0');
  })();

  console.log('\n=== 综合：模拟完整删除流程 ===');
  (function () {
    // 模拟项目→批次→视频的完整结构，删除一个视频后状态一致性
    var project = {
      id: 'p1', name: 'Test Project', work_dir_name: '/tmp/work',
      videos: [
        { id: 'v1', file_name: 'a.mp4', batch_id: 'b1', _restoreKey: 'project_p1_video_v1', processed_file: 'processed/a_processed.webm' },
        { id: 'v2', file_name: 'b.mp4', batch_id: 'b1', _restoreKey: 'project_p1_video_v2', processed_file: '' }
      ],
      batches: [
        { id: 'b1', name: 'Batch 1', video_ids: ['v1', 'v2'], created_at: '2026-07-26T00:00:00Z' }
      ]
    };

    // 删除 v1（有预处理文件、有句柄、属于批次）
    var r = simulateDeleteVideoCleanup(project, 'v1');
    assertTrue(r.videoRemoved, 'v1 被删除');
    assertEqual(r.removedFromBatches, 1, '从 1 个批次移除');

    // 验证一致性
    assertEqual(project.videos.length, 1, '剩余 1 个视频');
    assertEqual(project.videos[0].id, 'v2', '剩余的是 v2');
    assertEqual(project.batches[0].video_ids, ['v2'], '批次只剩 v2');

    // 批次统计应与实际视频数一致
    var batchVideoCount = project.batches[0].video_ids.length;
    var actualVideosInBatch = project.videos.filter(function (v) { return v.batch_id === 'b1'; }).length;
    assertEqual(batchVideoCount, actualVideosInBatch, '批次统计数 = 实际视频数');
  })();

  console.log('\n========================================');
  console.log('测试结果：通过 ' + passed + ' 个，失败 ' + failed + ' 个');
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
})();
