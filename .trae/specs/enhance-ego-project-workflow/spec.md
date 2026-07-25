# EGO 标注工具工作流调整 Spec（第一步）

> 本 Spec 是对 `add-ego-annotation-tool` 的迭代调整。**只定义第一步**：项目管理 + 视频导入 + 设备配置 + 批次/轨迹。后续步骤（标注节点结构调整、多语言、测试、部署）待后续讨论后再补充。

## Why

当前 `annotate.html` 是"打开页面 → 直接上传单视频 → 标注"的扁平流程，缺少标注前的项目组织环节。下游训练流程要求 HDF5 `meta_info` 包含 `data_source`、`trajectory_index`、`frame_name`、`instruction_sub_camera` 等字段，这些应由项目维度统一配置，而非每次标注手填。本 Spec 在 `annotate.html` 内增加项目化管理前置流程，**不创建新 HTML 页面**。

## What Changes

- **修改 `annotate.html`**：首屏从"上传视频"改为"项目选择面板"
  - 首屏 A：项目列表（已创建项目）+ "新建项目"按钮
  - 首屏 B（选中项目后）：视频列表 + 设备配置入口 + 批次管理
  - 选中视频后进入原标注流程（元信息 → 标注 → 预览 → 导出）
- **修改 `js/annotate.js`**：state 增加 `project`、`device_config` 字段；原 5 步流程改为"项目 → 元信息 → 标注 → 预览 → 导出"（去掉独立"上传"步骤，视频在项目内选择）
- **修改 `js/annotate-export.js`**：导出 JSON 的 `meta` 字段 → `meta_info` 字段，按 [deliverable.md](file:///c:/Users/32879/Documents/free-model-projects/aix-future-cc/.trae/specs/add-ego-annotation-tool/deliverable.md) 定义
- **修改 `css/style.css`**：项目面板、视频列表、设备配置表单样式
- **修改 `locales/zh-CN.json` 和 `en.json`**：新增项目/设备/批次翻译键
- **不创建** `projects.html`、`device-config.html`、`js/projects.js`、`js/device-config.js`（全部集成到 annotate.html / annotate.js）

## Impact

- Affected specs: `add-ego-annotation-tool`（导出 JSON 结构变更、流程步骤变更）
- Affected code:
  - 修改：`annotate.html`（首屏改造 + 元信息表单字段调整）
  - 修改：`js/annotate.js`（state 扩展 + 项目管理逻辑）
  - 修改：`js/annotate-export.js`（导出 JSON 结构）
  - 修改：`css/style.css`（项目面板样式）
  - 修改：`locales/zh-CN.json`, `locales/en.json`
- **不修改**导航栏（项目管理在 annotate.html 内，复用现有"具身智能专区 → 数据标注工具"入口）

---

## ADDED Requirements

### Requirement: 项目管理（嵌入 annotate.html 首屏）

系统 SHALL 在 `annotate.html` 首屏展示项目选择面板，包含：项目列表（卡片式）+ "新建项目"按钮。每个项目包含：项目名称、`data_source`（数据来源标识）、备注、创建时间。项目数据 SHALL 自动保存到 localStorage（键：`aix_ego_projects`），刷新不丢失。

#### Scenario: 首屏展示项目列表
- **WHEN** 用户打开 `annotate.html`（无 URL 参数）
- **THEN** 显示项目选择面板：已创建项目列表 + "新建项目"按钮 + "直接标注（无项目）"入口（保留原单视频流程作为降级）

#### Scenario: 新建项目
- **WHEN** 用户点击"新建项目"
- **THEN** 弹出表单，字段：项目名称（必填）、`data_source`（必填）、备注（选填）
- **WHEN** 用户提交表单
- **THEN** 项目创建成功，自动生成 `project.id`，保存到 localStorage，进入项目详情面板

#### Scenario: 进入项目
- **WHEN** 用户点击项目列表中的某个项目卡片
- **THEN** 进入项目详情面板：视频列表 + 设备配置入口 + 批次管理

#### Scenario: 删除项目
- **WHEN** 用户点击项目卡片的"删除"按钮
- **THEN** 二次确认后删除项目及其下所有视频/批次/设备配置

### Requirement: 视频导入（项目详情面板内）

系统 SHALL 支持两种视频导入方式：
1. **单视频导入**：文件选择器选择单个视频
2. **文件夹批量导入**：`<input type="file" webkitdirectory multiple>` 选择文件夹，自动扫描视频文件

系统 SHALL 为每个视频生成缩略图（取第 1 秒帧，JPEG 0.7 质量），在视频列表中展示。视频列表展示：缩略图、文件名、大小、分辨率、时长、关联轨迹编号。

#### Scenario: 单视频导入
- **WHEN** 用户点击"导入视频" → "单个视频"
- **THEN** 弹出文件选择器（accept="video/*"）
- **WHEN** 用户选择视频文件
- **THEN** 视频加入项目视频列表，生成缩略图，自动保存

#### Scenario: 文件夹批量导入
- **WHEN** 用户点击"导入视频" → "文件夹批量"
- **THEN** 弹出文件夹选择器（`<input webkitdirectory>`）
- **WHEN** 用户选择文件夹
- **THEN** 扫描文件夹下所有 MP4/MOV/AVI 文件，逐个加入视频列表，显示导入进度，逐个生成缩略图

#### Scenario: 缩略图生成失败
- **WHEN** 视频无法解码或时长 < 1 秒
- **THEN** 使用默认占位图，不影响导入流程

### Requirement: 采集设备参数配置（项目详情面板内）

系统 SHALL 在项目详情面板提供设备配置入口（折叠面板或 Tab），支持配置：

**内参（intrinsic）**：
- `fx`, `fy`（焦距，float）
- `cx`, `cy`（主点，float）
- `distortion`：畸变系数 `[k1, k2, p1, p2, k3]`（5 个 float）

**外参（extrinsic）**：
- `R`：旋转矩阵 3×3（9 个 float）
- `T`：平移向量 3（3 个 float）

**相机名称映射**：
- `frame_name`：相机名称列表（string[]，长度 ≥ 1，元素互不重复）
- `instruction_sub_camera`：主相机名（必须存在于 `frame_name` 中）

设备参数 SHALL 自动保存到 localStorage。

#### Scenario: 配置内参
- **WHEN** 用户填写 fx, fy, cx, cy, 畸变系数
- **THEN** 实时校验数值合法性，保存到项目 device_config

#### Scenario: 配置相机名称映射
- **WHEN** 用户添加相机名称
- **THEN** 校验元素互不重复，加入 frame_name 列表
- **WHEN** 用户指定主相机
- **THEN** 校验该相机名必须存在于 frame_name 中

### Requirement: 批次和轨迹编号管理（项目详情面板内）

系统 SHALL 在项目详情面板提供批次管理（折叠面板或 Tab）：
- 创建批次（`batch_id` 自动生成，如 `batch_001`）
- 为批次内的视频自动分配 `trajectory_index`（同批次内不重复，字符串类型，如 `traj_001`）
- 视频-轨迹关联：每个视频可加入某批次，自动分配 trajectory_index

#### Scenario: 创建批次
- **WHEN** 用户点击"新建批次"
- **THEN** 创建新批次，自动分配 batch_id

#### Scenario: 视频加入批次
- **WHEN** 用户将视频加入批次
- **THEN** 系统自动分配 trajectory_index（同批次内不重复）

### Requirement: 从项目进入标注

系统 SHALL 支持用户从项目视频列表中点击某视频的"开始标注"，进入标注流程（跳过原"上传"步骤，直接进入"元信息"步骤）。元信息表单字段从项目/设备配置自动带入。

#### Scenario: 从项目进入标注
- **WHEN** 用户点击视频的"开始标注"
- **THEN** annotate.html 切换到标注模式，元信息表单自动填充：
  - `data_source` ← 项目配置
  - `trajectory_index` ← 视频-轨迹关联
  - `frame_name` ← 设备配置
  - `instruction_sub_camera` ← 设备配置
  - `fps`, `num_frames` ← 视频自动检测

---

## MODIFIED Requirements

### Requirement: annotate.html 流程步骤（原有）

原 5 步流程"上传 → 元信息 → 标注 → 预览 → 导出" **调整为**：
- **项目模式（首屏）**：项目列表 → 项目详情 → 选择视频
- **标注模式（4 步）**：元信息 → 标注 → 预览 → 导出
- 保留"直接标注（无项目）"入口作为降级，走原 5 步流程

### Requirement: 元信息表单字段（原有）

原字段（scene_type / device / collector / date / fps / resolution / remark）**替换为** [deliverable.md](file:///c:/Users/32879/Documents/free-model-projects/aix-future-cc/.trae/specs/add-ego-annotation-tool/deliverable.md) 的 `meta_info` 8 个字段：

| 字段 | 来源 |
|---|---|
| `data_source` | 项目配置自动带入（可编辑） |
| `trajectory_index` | 批次/轨迹关联自动带入（可编辑） |
| `fps` | 视频自动检测（可编辑） |
| `num_frames` | 视频自动检测 |
| `frame_name` | 设备配置自动带入（可编辑） |
| `instruction_sub_camera` | 设备配置自动带入（可编辑） |
| `task_success` | 默认 True，用户可选 |
| `task_horizon` | 用户选择（short/long/NA） |

### Requirement: HDF5 导出 JSON 结构（原有）

导出 JSON 的 `meta` 字段 **替换为** `meta_info`，按 [deliverable.md](file:///c:/Users/32879/Documents/free-model-projects/aix-future-cc/.trae/specs/add-ego-annotation-tool/deliverable.md) 定义：

```json
{
  "meta_info": {
    "data_source": "string",
    "trajectory_index": "string",
    "fps": 30,
    "num_frames": 3615,
    "frame_name": ["cam_0"],
    "instruction_sub_camera": "cam_0",
    "task_success": true,
    "task_horizon": "short"
  },
  "annotations": { ... }
}
```

---

## 技术约束

### 浏览器文件夹访问
- `<input type="file" webkitdirectory multiple>`：Chrome/Edge/Firefox 支持
- 无法记住文件夹绝对路径，每次需重新选择（可接受）

### 视频缩略图
- `<video>` 加载 → `currentTime = 1` → `seeked` 事件 → `<canvas>` 绘制 → `toDataURL('image/jpeg', 0.7)`
- 失败降级：默认占位图

### localStorage 容量
- 项目元数据 + 缩略图：单项目预估 2-5MB
- 溢出处理：try/catch + Toast 提示

### 多相机支持
- 当前版本仅支持单视频标注（`frame_name` 可多个，但标注只处理主相机）
- 多相机合并 HDF5 留作后续迭代

---

## 第二步迭代：批次中心化工作流（2026-07-26）

> 本章节是对第一步 Spec 的迭代调整。核心变更：**流程顺序调换**、**工作目录改为批次级**、**后续流程点全部在批次卡片内完成**、**预处理前置约束**。

### Requirement: 流程向导顺序调整

系统 SHALL 在项目详情页顶部展示 5 步流程向导条，顺序为：
① 创建批次 → ② 设置工作目录 → ③ 导入轨迹 → ④ 预处理（可选） → ⑤ 开始标注

步骤状态判定：
- 步骤 ①：`project.batches.length > 0` 即为 done
- 步骤 ②：任一 `batch.work_dir_name` 已设置即为 done（工作目录为批次级）
- 步骤 ③：`project.videos.length > 0` 即为 done
- 步骤 ④：任一 `video.processed_file` 存在即为 done；未完成显示为 skip（灰色，可选步骤）
- 步骤 ⑤：有视频即可点击（current 高亮），无视频为 pending

#### Scenario: 流程向导点击跳转
- **WHEN** 用户点击步骤 ①②③④
- **THEN** 展开并滚动到「批次管理」折叠面板
- **WHEN** 用户在未创建批次时点击步骤 ③（导入轨迹）
- **THEN** 拦截并 Toast 提示"请先创建批次，再导入轨迹"，高亮批次面板

### Requirement: 批次级工作目录

工作目录 SHALL 从项目级改为**批次级**，每个批次独立设置工作目录。预处理文件输出到该批次工作目录的 `processed/` 子文件夹。

- `workDirKey(projectId, batchId)` → `'project_' + projectId + '_batch_' + batchId + '_workdir'`
- `setBatchWorkDir(project, batch)` → 调用 `showDirectoryPicker`，保存句柄到 IndexedDB，写入 `batch.work_dir_name`
- `saveProcessedBlobToWorkDir(projectId, batchId, blob, fileName)` → 写入对应批次工作目录的 `processed/` 子文件夹
- `deleteProcessedFileFromWorkDir(projectId, batchId, relPath)` → 删除对应批次工作目录的预处理文件
- `getProjectWorkDirHandle(projectId, batchId)` → 从 IndexedDB 恢复批次工作目录句柄

### Requirement: 批次卡片（后续流程点的统一入口）

系统 SHALL 将「批次管理」面板重构为**批次卡片列表**。每个批次卡片展开后包含：
1. **工作目录行**：显示路径 + 设置/更改按钮
2. **操作按钮行**：导入轨迹 / 批量预处理 / 开始标注
3. **视频列表**：每个视频显示文件名、处理状态标签、预处理/标注/删除 按钮

所有后续流程点（导入轨迹、预处理、开始标注）SHALL 在批次卡片内完成，不再保留全局视频列表面板。

#### Scenario: 创建批次后自动展开 + 高亮导入按钮
- **WHEN** 用户点击「新建批次」
- **THEN** 创建批次，自动设置 `state.expandedBatchIds[batchId] = true` 和 `state.highlightBatchId = batchId`
- **AND** 批次卡片自动展开，「导入轨迹」按钮带绿色脉冲高亮（`highlight-pulse` 类）
- **AND** 刷新流程向导状态（步骤 ① 变为 done）
- **WHEN** 用户点击「导入轨迹」按钮
- **THEN** 清除 `state.highlightBatchId`，触发 `importVideosToBatch(project, batchId)`

#### Scenario: 批次卡片折叠/展开
- **WHEN** 用户点击批次卡片头部
- **THEN** 切换 `state.expandedBatchIds[batchId]`，局部刷新批次面板

#### Scenario: 导入轨迹到批次
- **WHEN** 用户在批次卡片内点击「导入轨迹」
- **THEN** 调用 `startImportWithBatch(project, batchId)`，使用 `showDirectoryPicker` 选择文件夹
- **AND** 扫描视频文件后调用 `processBatchVideoFiles(project, fileHandles, dirHandle, batchId)`
- **AND** 每个视频写入 `video.batch_id` 并同步到 `batch.video_ids`（去重）

#### Scenario: 批量预处理（批次级）
- **WHEN** 用户在批次卡片内点击「批量预处理」
- **THEN** 调用 `runBatchProcessForBatch(project, batchId)`
- **AND** 收集 `batch.video_ids`，调用 `runBatchProcess(project, videoIds)` 依次处理
- **WHEN** 批次未设置工作目录
- **THEN** 按钮禁用，hover 显示 title 提示"请先设置该批次的工作目录，再进行预处理"

#### Scenario: 单视频预处理
- **WHEN** 用户在批次卡片视频列表中点击某视频的「预处理」
- **THEN** 调用 `processSingleVideo(project, videoId)`，内部复用 `runBatchProcess(project, [videoId])`
- **WHEN** 视频已预处理
- **THEN** 按钮禁用，提示"该视频已预处理"
- **WHEN** 视频未归属批次
- **THEN** 拦截并 Toast 提示"该视频未归属任何批次，无法预处理"

#### Scenario: 开始标注
- **WHEN** 用户在批次卡片内点击「开始标注」
- **THEN** 取 `batch.video_ids[0]` 的第一个视频，调用 `startAnnotateFromProject(project, videoId)`

### Requirement: 预处理前置约束（强制）

系统 SHALL 在预处理入口强制检查工作目录是否已设置。**工作目录未设置的批次不允许预处理**。

拦截点：
1. `runBatchProcessForBatch(project, batchId)`：检查 `batch.work_dir_name`，未设置则 Toast 提示并 return
2. `processSingleVideo(project, videoId)`：检查视频所属批次的 `work_dir_name`，未设置则 Toast 提示并 return；视频无 `batch_id` 则提示"未归属任何批次，无法预处理"
3. UI 层：批次卡片内「批量预处理」和单视频「预处理」按钮在 `!hasWorkDir` 时 `disabled`，并设置 `title` 提示

#### Scenario: 未设置工作目录时点击预处理
- **WHEN** 批次未设置工作目录，用户点击「批量预处理」
- **THEN** 按钮已禁用，hover 显示"请先设置该批次的工作目录，再进行预处理"
- **WHEN** 批次未设置工作目录，用户通过其他途径触发 `runBatchProcessForBatch`
- **THEN** Toast 提示"请先设置该批次的工作目录，再进行预处理"，流程终止

### Requirement: 删除操作的状态一致性

系统 SHALL 在删除视频/批次时维护状态一致性：

1. **删除视频**：调用 `removeVideoIdFromAllBatches(project, videoId)` 从所有批次的 `video_ids` 移除；清理 IndexedDB 文件句柄（`fsDeleteHandle(video._restoreKey)`）；删除批次工作目录中的预处理文件（`deleteProcessedFileFromWorkDir`）；调用 `refreshBatchPanel(project)` 刷新批次卡片视频列表
2. **删除批次**：弹二次确认（单次确认，`skipConfirm` 参数避免 N 次弹窗）；清空批次内视频的 `trajectory_index` 和 `batch_id`；从 `project.batches` 移除
3. **删除项目**：遍历所有视频清理文件句柄，防止 IndexedDB 资源泄漏

### Requirement: 批量预处理的串行状态持久化

系统 SHALL 在批量预处理中**串行处理**视频，且每个视频的 `onProcessComplete` 必须 await 完成后再处理下一个。

- 使用 `Promise.resolve(onProcessComplete(...)).then(() => { idx++; processNext(); })` 确保状态写入（`video.processed_file`）完成后再递增索引
- 防止"只标记一个已预处理"的竞态条件

### i18n 翻译键（新增）

`zh-CN.json` / `en.json` 的 `annotate.project` 命名空间新增：
- `import_to_batch` / `no_videos_in_batch` / `processed` / `unprocessed` / `annotate` / `change` / `already_processed`
- `work_dir_required_for_process` / `no_batch_for_process`
- `wizard_step_batch` / `wizard_step_workdir` / `wizard_step_import` / `wizard_step_process` / `wizard_step_annotate`
- `wizard_status_has_batch` / `wizard_status_set` / `wizard_status_imported` / `wizard_status_done` / `wizard_status_skip` / `wizard_status_click`
- `wizard_no_batch_first` / `wizard_no_video` / `batch_created` / `batch_deleted`

### CSS 样式（新增）

`css/style.css` 新增：
- `.annotate-batch-card` / `.annotate-batch-card-header` / `.annotate-batch-card-body`：批次卡片容器
- `.annotate-batch-workdir` / `.annotate-batch-workdir-value.not-set`：工作目录行
- `.annotate-batch-card-actions`：操作按钮行
- `.annotate-batch-video-list` / `.annotate-batch-video-item` / `.annotate-batch-video-name` / `.annotate-batch-video-actions`：视频列表
- `.annotate-tag-success` / `.annotate-tag-muted`：状态标签
- `.highlight-pulse` + `@keyframes btnPulse`：新建批次高亮脉冲动画
- `.annotate-batch-card.highlight` + `@keyframes batchHighlightFade`：新建批次卡片高亮渐隐

### 受影响代码

- 修改：`js/annotate.js`
  - `renderProcessWizard`：流程向导顺序与状态判定
  - `renderBatchPanelHtml` / `renderBatchCardHtml` / `bindBatchPanelEvents`：批次卡片渲染与事件
  - `workDirKey` / `getProjectWorkDirHandle` / `setBatchWorkDir` / `saveProcessedBlobToWorkDir` / `deleteProcessedFileFromWorkDir`：批次级工作目录
  - `createBatch`：自动展开 + 高亮 + 流程向导刷新
  - `runBatchProcessForBatch` / `processSingleVideo`：预处理入口 + 工作目录拦截
  - `importVideosToBatch` / `findBatchById` / `toggleBatchExpand`：批次辅助函数
  - `deleteVideoFromProject`：刷新批次面板
  - `deleteBatch`：`skipConfirm` 参数避免多次确认
- 修改：`locales/zh-CN.json` / `locales/en.json`
- 修改：`css/style.css`

---

## 第三步迭代：批量标注功能（2026-07-26）

> 本章节新增批量标注功能。核心：**「开始标注」改为「批量标注」**，支持连续标注批次内多个视频，标注数据自动持久化到 `video.annotations`。

### Requirement: 标注数据持久化（基础）

系统 SHALL 将每个视频的标注数据持久化到 `video.annotations` 字段，而非仅存在于 `state.annotations`（运行时）。

- 进入标注（`startAnnotateFromProject`）：若 `video.annotations` 存在则深拷贝加载到 `state.annotations`，否则初始化空结构
- 标注修改（`pushHistory` / `undo` / `redo`）：debounce 1 秒调用 `persistCurrentAnnotationsToVideo(false)` 自动保存
- 切换视频 / 退出批量模式：调用 `persistCurrentAnnotationsToVideo(true)` 立即保存
- `persistCurrentAnnotationsToVideo` 同时同步 `state.meta_info` 到 `video.meta_info`

### Requirement: 标注状态管理

每个视频 SHALL 维护 `annotation_status` 字段，取值：
- `'unannotated'`（默认，从未标注）
- `'in_progress'`（进入标注界面时设置）
- `'completed'`（点「下一个」时设置，或导出后设置）

进入标注时：`if (video.annotation_status !== 'completed') video.annotation_status = 'in_progress'`

### Requirement: 批量标注入口

批次卡片内的「开始标注」按钮 SHALL 改为「批量标注」，点击后调用 `startBatchAnnotate(project, batchId)`：
1. 收集 `batch.video_ids` 顺序
2. 找第一个 `annotation_status !== 'completed'` 的视频作为起始（全部已完成则从第一个开始复检）
3. 初始化 `state.batchAnnotateContext = { projectId, batchId, videoIds, currentIndex }`
4. 调用 `loadVideoForBatchAnnotate(project, videoId)` 加载起始视频
5. 显示批量标注导航条

视频列表内的单视频「标注」按钮 SHALL 保留，单独标注某个视频（不进入批量模式，无导航条）。

### Requirement: 批量标注导航条

标注界面顶部 SHALL 显示导航条（`#annotateBatchNav`），含：
- **上一个按钮**（`#annotateBatchPrevBtn`）：`currentIndex === 0` 时禁用
- **视频名**（`#annotateBatchNavName`）：当前视频文件名
- **进度**（`#annotateBatchNavProgress`）：`当前 / 总数`（1-based）
- **状态标签**（`#annotateBatchNavStatus`）：未标注/标注中/已标注，根据 `annotation_status` 显示
- **下一个按钮**（`#annotateBatchNextBtn`）：最后一个视频时文案改为「完成」
- **退出按钮**（`#annotateBatchExitBtn`）：退出批量标注模式

导航条仅在批量标注模式显示（`state.batchAnnotateContext` 存在时），其他情况 `hidden`。

#### Scenario: 连续标注下一个
- **WHEN** 用户点击「下一个」
- **THEN** 标记当前视频 `annotation_status = 'completed'`，立即持久化
- **AND** 从 `currentIndex + 1` 开始找下一个未标注视频
- **AND** 若后面没有未标注视频，Toast 提示"该批次已全部标注完成"，从第一个开始复检
- **AND** 调用 `loadVideoForBatchAnnotate` 加载新视频，更新导航条

#### Scenario: 切换到上一个
- **WHEN** 用户点击「上一个」
- **THEN** 持久化当前标注，`currentIndex--`，加载上一个视频
- **WHEN** 已是第一个
- **THEN** Toast 提示"已是第一个视频"

#### Scenario: 退出批量标注
- **WHEN** 用户点击「✕ 退出」
- **THEN** 弹二次确认对话框
- **AND** 确认后立即持久化当前标注，清空 `state.batchAnnotateContext`，隐藏导航条，返回项目列表视图

### Requirement: 批量标注上下文持久化

`state.batchAnnotateContext` SHALL 持久化到 localStorage（`saveToLocalStorage`），刷新页面后：
- 若 URL 带 `project_id` 且 `currentStep > 1`：恢复标注界面 + 显示导航条
- 否则：清空 `batchAnnotateContext`，隐藏导航条（避免残留）

### Requirement: 批次卡片显示标注状态

批次卡片视频列表 SHALL 在每个视频项显示标注状态标签：
- `annotation_status === 'completed'` → 绿色「已标注」
- `annotation_status === 'in_progress'` → 黄色「标注中」
- 其他 → 灰色「未标注」

### i18n 翻译键（新增）

`zh-CN.json` / `en.json` 新增：
- `annotate.batch_nav_prev` / `batch_nav_next` / `batch_nav_finish`
- `annotate.batch_status_unannotated` / `batch_status_in_progress` / `batch_status_completed`
- `annotate.batch_all_completed` / `batch_complete` / `batch_first_video`
- `annotate.batch_exit_title` / `batch_exit_body` / `batch_exit_confirm`
- `annotate.project.batch_annotate`

### CSS 样式（新增）

`css/style.css` 新增：
- `.annotate-batch-nav`：导航条容器（flex 布局，绿色边框）
- `.annotate-batch-nav-info` / `.annotate-batch-nav-name` / `.annotate-batch-nav-progress` / `.annotate-batch-nav-status`
- `.annotate-batch-nav-status[data-status="completed"|"in_progress"|"unannotated"]`：状态标签配色
- `.annotate-tag-warning`：黄色标签（标注中状态）

### 受影响代码

- 修改：`annotate.html`：新增 `#annotateBatchNav` 导航条 DOM
- 修改：`js/annotate.js`
  - `state` 新增 `batchAnnotateContext` 字段
  - `dom` 新增 `batchNav` / `batchNavName` / `batchNavProgress` / `batchNavStatus` / `batchPrevBtn` / `batchNextBtn` / `batchExitBtn`
  - `startAnnotateFromProject`：加载 `video.annotations` + 设置 `annotation_status = 'in_progress'`
  - `pushHistory` / `undo` / `redo`：接入 `persistCurrentAnnotationsToVideo(false)` 自动保存
  - 新增 `persistCurrentAnnotationsToVideo` / `startBatchAnnotate` / `loadVideoForBatchAnnotate` / `goToNextBatchVideo` / `goToPrevBatchVideo` / `exitBatchAnnotate` / `showBatchAnnotateNav` / `hideBatchAnnotateNav` / `updateBatchAnnotateNav` / `bindBatchAnnotateNavEvents`
  - `renderBatchCardHtml`：「开始标注」→「批量标注」；视频项加 `annotation_status` 标签
  - `bindBatchPanelEvents`：`start-annotate-batch` 改调 `startBatchAnnotate`
  - `saveToLocalStorage`：持久化 `batchAnnotateContext`
  - `init`：调用 `bindBatchAnnotateNavEvents`；恢复时若 `batchAnnotateContext` 存在则显示导航条
  - `showProjectListView`：隐藏导航条
- 修改：`locales/zh-CN.json` / `locales/en.json`
- 修改：`css/style.css`

---

## 第四步迭代：批次元信息继承（2026-07-26）

> 本章节新增批次级 `meta_info` 字段。创建批次时填写，进入标注时优先从批次继承，避免每个视频重复填写元信息。

### Requirement: 批次 meta_info 数据结构

每个 batch SHALL 包含 `meta_info` 字段，含 5 个批次级字段：
- `data_source`（数据来源，如 AIX-Office-v1）
- `frame_name`（相机名数组，如 `["cam_0", "cam_1"]`）
- `instruction_sub_camera`（指令相机，如 cam_0）
- `task_success`（布尔，默认 true）
- `task_horizon`（枚举：NA / short / long，默认 NA）

`trajectory_index` / `fps` / `num_frames` 仍为视频级字段，不放入批次 meta_info。

### Requirement: 创建批次时填写 meta_info

点「新建批次」SHALL 弹窗填写 meta_info，字段含表单输入 + 默认值：
- `data_source`：默认从 `project.data_source` 带入
- `frame_name`：默认从 `project.device_config.frame_name` 带入（逗号分隔输入，提交时按逗号分割成数组）
- `instruction_sub_camera`：默认从 `project.device_config.instruction_sub_camera` 带入
- `task_success`：checkbox，默认勾选
- `task_horizon`：select（NA / short / long），默认 NA

确认后创建批次，`batch.meta_info` 写入。**创建后不可编辑**（如需修改需重建批次）。

#### Scenario: 创建批次流程
- **WHEN** 用户点击「新建批次」
- **THEN** 弹窗显示元信息表单，字段已预填项目/设备配置默认值
- **WHEN** 用户填写后点「创建」
- **THEN** 创建批次（含 `meta_info`），自动展开批次卡片，高亮「导入轨迹」按钮，刷新流程向导
- **WHEN** 用户点「取消」
- **THEN** 关闭弹窗，不创建批次

### Requirement: 进入标注时从批次继承 meta_info

`startAnnotateFromProject` SHALL 优先从视频所属批次的 `meta_info` 继承批次级字段，降级从项目/设备配置取：

```
data_source       = batch.meta_info.data_source       || project.data_source
frame_name        = batch.meta_info.frame_name        || project.device_config.frame_name
instruction_sub_camera = batch.meta_info.instruction_sub_camera || project.device_config.instruction_sub_camera
task_success      = batch.meta_info.task_success      (默认 true)
task_horizon      = batch.meta_info.task_horizon      (默认 NA)
trajectory_index  = video.trajectory_index            (视频级)
fps               = video.fps                         (视频级)
num_frames        = video.num_frames                  (视频级)
```

历史批次（无 `meta_info` 字段）自动降级从项目取，兼容旧数据。

### Requirement: 进入标注时一律跳过元信息步骤

由于元信息已从批次继承 + 视频级字段在导入时已填，采集人无需在步骤 2 填写任何字段。`startAnnotateFromProject` SHALL 一律跳过步骤 2，直接进入步骤 3（标注）：

- `state.currentStep = 3; goToStep(3);`（不再停在步骤 2）
- 仍调用 `fillMetaInfoForm()` 回填表单（供采集人点回步骤 2 时查看）
- 步骤 2 保留在步骤条上，采集人可主动点击回去查看/修改元信息
- 批量标注切换视频时同样直接跳到步骤 3（`loadVideoForBatchAnnotate` 调用 `startAnnotateFromProject`，自动继承此行为）

### Requirement: 批次卡片显示 meta_info 摘要

批次卡片展开后，工作目录行下方 SHALL 显示 `meta_info` 摘要（只读）：
- 已填写：显示 `data_source=xxx · frame_name=[cam_0, cam_1] · sub_cam=cam_0 · task_success=true · task_horizon=NA`
- 未填写：灰色提示"未填写（进入标注时将从项目继承）"

### i18n 翻译键（新增）

`zh-CN.json` / `en.json` 新增（`annotate.project` 命名空间）：
- `create_batch_title` / `batch_meta_hint` / `batch_meta_info` / `batch_meta_not_set`

### CSS 样式（新增）

`css/style.css` 新增：
- `.annotate-batch-meta-summary`：摘要容器
- `.annotate-batch-meta-label` / `.annotate-batch-meta-value` / `.annotate-batch-meta-value.not-set`
- `.annotate-batch-meta-form`：创建批次弹窗表单
- `.annotate-batch-meta-hint`：表单提示
- `.annotate-form-row` / `.annotate-form-row-inline`：表单行

### 受影响代码

- 修改：`js/annotate.js`
  - `createBatch`：改为弹窗填写 meta_info，写入 `batch.meta_info`
  - `startAnnotateFromProject`：`state.meta_info` 优先从 `batch.meta_info` 继承，降级从 project 取
  - `renderBatchCardHtml`：工作目录行下方新增 meta_info 摘要行
- 修改：`locales/zh-CN.json` / `locales/en.json`
- 修改：`css/style.css`

---

## 后续步骤（待讨论，不在本 Spec 范围）

- 标注数据节点结构（hand_detection / hand_keypoints / action_segmentation / hand_object / objects）的下游字段对齐
- 视频数据是否嵌入 HDF5
- 多相机合并方案
- 批次清单文件
- 校验规则
- 多语言翻译键补全
- 测试与部署
