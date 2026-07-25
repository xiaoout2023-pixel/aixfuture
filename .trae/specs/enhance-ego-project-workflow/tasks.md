# Tasks — EGO 标注工具工作流调整（第一步）

> 只聚焦第一步：在 annotate.html 内增加项目化管理前置流程。后续步骤待讨论后再补充。

---

## 阶段 1：annotate.html 首屏改造（项目面板）

- [x] **Task 1.1**：annotate.html 首屏改为项目选择面板
  - 项目列表区（卡片式）+ "新建项目"按钮 + "直接标注（无项目）"降级入口
  - 项目卡片显示：项目名、data_source、视频数、创建时间、删除按钮
  - 保留原"上传视频"流程作为"直接标注"降级入口

- [x] **Task 1.2**：js/annotate.js 增加项目管理逻辑
  - state 增加 `projects`（数组）、`currentProject`（对象）
  - localStorage 键：`aix_ego_projects`
  - 项目数据结构：
    ```javascript
    {
      id, name, data_source, remark, created_at,
      videos: [{ id, file_name, file_size, thumbnail, duration, resolution, fps, trajectory_index, batch_id }],
      batches: [{ id, name, created_at, video_ids: [] }],
      device_config: { intrinsic, extrinsic, frame_name: [], instruction_sub_camera: "" }
    }
    ```
  - 函数：createProject, deleteProject, selectProject, saveProjects, loadProjects

- [x] **Task 1.3**：新建项目表单
  - 字段：项目名（必填）、data_source（必填）、备注（选填）
  - 校验：项目名非空、data_source 非空
  - 提交后自动生成 project.id，保存到 localStorage

---

## 阶段 2：视频导入与缩略图（项目详情面板内）

- [x] **Task 2.1**：项目详情面板布局
  - 顶部：项目名 + data_source + 编辑按钮 + 返回项目列表
  - 三个折叠面板：视频列表 / 设备配置 / 批次管理

- [x] **Task 2.2**：单视频导入
  - `<input type="file" accept="video/*">`
  - 格式校验（MP4/MOV/AVI）
  - 加入 project.videos 数组，自动保存

- [x] **Task 2.3**：文件夹批量导入
  - `<input type="file" webkitdirectory multiple>`
  - 过滤视频文件（按扩展名）
  - 逐个加入 videos 数组，显示导入进度条
  - 自动保存

- [x] **Task 2.4**：视频元信息检测
  - `<video>` 加载视频
  - 检测：分辨率（videoWidth/videoHeight）、时长（duration）、fps（默认 30，可手动改）
  - 存入 video 对象

- [x] **Task 2.5**：缩略图生成
  - `video.currentTime = 1`（或 duration/2 如果 < 1 秒）
  - 监听 `seeked` 事件 → canvas 绘制 → `toDataURL('image/jpeg', 0.7)`
  - 失败时默认占位图
  - 存入 video.thumbnail

- [x] **Task 2.6**：视频列表展示
  - 网格布局：缩略图 + 文件名 + 大小 + 分辨率 + 时长 + 轨迹编号
  - 鼠标悬停显示"开始标注"按钮
  - 点击"开始标注"进入标注模式
  - 删除视频（二次确认）

---

## 阶段 3：采集设备参数配置（项目详情面板内）

- [x] **Task 3.1**：设备配置折叠面板
  - 三个分区：内参 / 外参 / 相机名称映射

- [x] **Task 3.2**：内参表单
  - fx, fy, cx, cy（number input）
  - 畸变系数 k1, k2, p1, p2, k3（5 个 number input）
  - 实时校验 + 自动保存

- [x] **Task 3.3**：外参表单
  - R 3×3 矩阵（9 个 number input，grid 布局）
  - T 3 向量（3 个 number input）
  - 自动保存

- [x] **Task 3.4**：相机名称映射
  - frame_name 列表（可增删改，元素互不重复校验）
  - instruction_sub_camera 下拉选择（选项来自 frame_name）
  - 主相机校验（必须存在于 frame_name 中）
  - 自动保存

---

## 阶段 4：批次和轨迹编号管理（项目详情面板内）

- [x] **Task 4.1**：批次管理折叠面板
  - 批次列表：批次 ID、名称、视频数量、创建时间
  - "新建批次"按钮
  - 删除批次（二次确认）

- [x] **Task 4.2**：视频加入批次
  - 视频列表中每个视频可选择"加入批次"
  - 选择批次后自动分配 trajectory_index（同批次内不重复，格式 `traj_001`）

- [x] **Task 4.3**：视频从批次移除
  - 清空 trajectory_index
  - 该 trajectory_index 可重新分配

---

## 阶段 5：与标注流程集成

- [x] **Task 5.1**：annotate.html 标注模式流程调整
  - 原 5 步（上传/元信息/标注/预览/导出）→ 项目模式下 4 步（元信息/标注/预览/导出）
  - "直接标注"降级入口保留原 5 步流程

- [x] **Task 5.2**：元信息表单字段替换
  - 删除：scene_type / device / collector / date / fps / resolution / remark
  - 新增：data_source / trajectory_index / fps / num_frames / frame_name / instruction_sub_camera / task_success / task_horizon
  - fps 和 num_frames 由视频自动检测
  - 其他字段从 currentProject 自动带入

- [x] **Task 5.3**：js/annotate.js state 扩展
  - state 增加：project_id, video_id, device_config, currentProject
  - state.meta → state.meta_info（8 个字段）

- [x] **Task 5.4**：js/annotate-export.js 导出 JSON 结构调整
  - `meta` → `meta_info`
  - 字段按 deliverable.md 定义
  - 校验逻辑调整（8 个必填字段）

---

## 阶段 6：样式与多语言（最小化）

- [x] **Task 6.1**：css/style.css 追加项目面板/视频列表/设备配置样式

- [x] **Task 6.2**：locales/zh-CN.json 和 en.json 新增项目/设备/批次翻译键
  - 仅本次新增的 UI 文本，预估 40-60 个键

---

## 后续阶段（待讨论，不在本 Spec 范围）

- [ ] 标注数据节点结构调整（待与产品方讨论下游字段）
- [ ] 多语言补全
- [ ] 测试
- [ ] 部署 UAT / 生产

---

# Task Dependencies

```
阶段 1（项目面板） → 阶段 2（视频导入） → 阶段 3（设备配置）
                                              ↓
                                        阶段 4（批次/轨迹）
                                              ↓
                                        阶段 5（与标注集成）
                                              ↓
                                        阶段 6（样式+多语言）
```
