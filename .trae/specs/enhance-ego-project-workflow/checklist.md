# Checklist — EGO 标注工具工作流调整（第一步）

## annotate.html 首屏改造
- [x] 首屏改为项目选择面板（项目列表 + 新建项目按钮 + 直接标注降级入口）
- [x] 项目卡片展示（项目名、data_source、视频数、创建时间、删除按钮）
- [x] 项目删除有二次确认

## 项目管理逻辑（js/annotate.js）
- [x] state 增加 projects / currentProject 字段
- [x] localStorage 键 aix_ego_projects 自动保存/恢复
- [x] 项目数据结构定义（id, name, data_source, remark, created_at, videos, batches, device_config）
- [x] createProject / deleteProject / selectProject 函数实现
- [x] 新建项目表单（项目名必填、data_source 必填、备注选填）
- [x] 项目名和 data_source 必填校验

## 项目详情面板
- [x] 顶部显示项目名 + data_source + 返回按钮
- [x] 三个折叠面板（视频列表 / 设备配置 / 批次管理）

## 视频导入
- [x] 单视频导入（文件选择器，accept="video/*"）
- [x] 文件夹批量导入（`<input webkitdirectory>`）
- [x] 格式校验（MP4/MOV/AVI）
- [x] 视频元信息检测（分辨率、时长、fps）
- [x] 缩略图生成（第 1 秒帧，canvas.toDataURL）
- [x] 缩略图失败降级（默认占位图）
- [x] 批量导入进度条
- [x] 视频列表展示（缩略图、文件名、大小、分辨率、时长、轨迹编号）
- [x] 视频删除（二次确认）

## 采集设备参数配置
- [x] 设备配置折叠面板（内参 / 外参 / 相机名称映射）
- [x] 内参表单（fx, fy, cx, cy, k1, k2, p1, p2, k3）
- [x] 外参表单（R 3×3, T 3）
- [x] frame_name 列表（增删改，元素互不重复校验）
- [x] instruction_sub_camera 下拉选择（选项来自 frame_name）
- [x] 主相机校验（必须存在于 frame_name 中）
- [x] 设备参数 localStorage 自动保存

## 批次和轨迹编号管理
- [x] 批次列表展示（批次 ID、名称、视频数、创建时间）
- [x] 新建批次（自动生成 batch_id）
- [x] 视频加入批次（自动分配 trajectory_index，同批次内不重复）
- [x] 视频从批次移除（清空 trajectory_index）
- [x] 批次删除（二次确认）

## 与标注流程集成
- [x] 项目模式下标注流程改为 4 步（元信息/标注/预览/导出）
- [x] "直接标注"降级入口保留原 5 步流程
- [x] 元信息表单字段替换为 8 个 meta_info 字段
- [x] data_source / trajectory_index / frame_name / instruction_sub_camera 从项目自动带入
- [x] fps / num_frames 由视频自动检测
- [x] task_success 默认 True
- [x] task_horizon 用户选择（short/long/NA）
- [x] js/annotate.js state 扩展（project_id, video_id, device_config, currentProject）
- [x] js/annotate.js state.meta → state.meta_info
- [x] js/annotate-export.js 导出 JSON 结构调整（meta → meta_info）
- [x] 导出校验逻辑调整（8 个必填字段）

## 样式与多语言
- [x] css/style.css 追加项目面板/视频列表/设备配置样式
- [x] zh-CN.json 新增项目/设备/批次翻译键
- [x] en.json 与 zh-CN.json 结构一致
- [x] 新增 UI 文本有 data-i18n 属性

## 静态验证（已通过）
- [x] node --check js/annotate.js 通过
- [x] node --check js/annotate-export.js 通过
- [x] JSON 解析正常（zh-CN.json / en.json）
- [x] annotate.html 项目面板 DOM 元素存在（19 个 ID）
- [x] annotate.html data-i18n 翻译键引用正确（annotate.project.* / annotate.meta_info.*）
- [x] annotate.js 项目管理逻辑存在（43 处匹配）
- [x] annotate-export.js meta_info 导出结构存在（39 处匹配）
- [x] style.css 项目面板样式存在（47 处匹配）

## 待用户浏览器实测
- [ ] 项目创建/删除流程
- [ ] 单视频导入 + 缩略图生成
- [ ] 文件夹批量导入 + 进度条
- [ ] 设备参数配置（内参/外参/相机映射）
- [ ] 批次创建 + 视频加入批次 + trajectory_index 分配
- [ ] 从项目进入标注（元信息自动带入）
- [ ] "直接标注"降级流程
- [ ] 导出 JSON 结构正确（meta_info 8 字段）
- [ ] 中英文切换

## 后续阶段（待讨论，不在本 Spec 范围）
- [ ] 标注数据节点结构调整
- [ ] 部署 UAT / 生产
