# Tasks
- [x] Task 1: 更新爬虫脚本抓取多维度数据
  - [x] SubTask 1.1: 修改 parse_superclue_table() 函数，从表格中提取 6 个维度分数（数学推理、幻觉控制、科学推理、精确指令遵循、代码生成、智能体任务规划）
  - [x] SubTask 1.2: 更新数据模型结构，为每个模型添加 math_reasoning, hallucination_control, science_reasoning, instruction_following, code_generation, agent_planning 字段
  - [x] SubTask 1.3: 添加榜单更新时间字段（update_time），格式为 "YYYY年MM月"
  - [x] SubTask 1.4: 更新 save_data() 函数，将数据保存为 {update_time, models} 格式

- [x] Task 2: 更新前端 HTML 表格结构
  - [x] SubTask 2.1: 在表头添加 6 列：数学推理、幻觉控制、科学推理、精确指令遵循、代码生成、智能体
  - [x] SubTask 2.2: 在表格上方添加榜单更新时间显示区域

- [x] Task 3: 更新前端 JS 渲染逻辑
  - [x] SubTask 3.1: 修改数据加载逻辑，适配新的 JSON 格式（包含 update_time 和 models）
  - [x] SubTask 3.2: 修改渲染函数，为每行数据填充 6 个维度分数
  - [x] SubTask 3.3: 为新增的 6 列添加排序功能
  - [x] SubTask 3.4: 在页面加载后显示榜单更新时间

- [x] Task 4: 更新 CSS 样式适配新列
  - [x] SubTask 4.1: 调整表格列宽和样式，确保 13 列能正常显示
  - [x] SubTask 4.2: 确保移动端响应式布局正常工作

- [ ] Task 5: 测试和验证
  - [ ] SubTask 5.1: 在本地运行爬虫脚本验证数据抓取
  - [ ] SubTask 5.2: 在本地启动服务验证前端展示

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4] depends on [Task 2, Task 3]
- [Task 5] depends on [Task 1, Task 2, Task 3, Task 4]
