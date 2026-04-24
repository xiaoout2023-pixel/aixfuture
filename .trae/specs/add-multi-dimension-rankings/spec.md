# 多维度数据展示与榜单时间 Spec

## Why
用户需要在排名表中展示更多维度数据（数学推理、幻觉控制、科学推理、精确指令遵循、代码生成、智能体任务规划），以及榜单更新时间，使排名信息更丰富、更有参考价值。

## What Changes
- 扩展数据模型：在 `models.json` 中为每个模型新增 6 个维度分数 + 榜单更新时间
- 更新爬虫脚本：抓取超脑网站上的多维度分数
- 更新前端表格：增加 6 列展示各维度分数
- 添加榜单更新时间显示

## Impact
- Affected specs: 数据抓取、前端展示
- Affected code: 
  - `scraper/scrape.py` - 爬虫脚本
  - `data/models.json` - 数据文件
  - `index.html` - 页面结构
  - `js/main.js` - 前端渲染逻辑
  - `css/style.css` - 样式

## ADDED Requirements
### Requirement: 多维度数据抓取
爬虫脚本 (scrape.py)  SHALL 从超脑网站的表格中提取以下维度分数：
- 数学推理 (math_reasoning)
- 幻觉控制 (hallucination_control)
- 科学推理 (science_reasoning)
- 精确指令遵循 (instruction_following)
- 代码生成 (code_generation)
- 智能体任务规划 (agent_planning)

#### Scenario: 成功抓取多维度数据
- **WHEN** 爬虫运行
- **THEN** models.json 中每个模型都包含以上 6 个维度分数

### Requirement: 榜单更新时间
数据文件 SHALL 包含榜单更新时间，格式为 "YYYY年MM月"。

#### Scenario: 保存更新时间
- **WHEN** 数据抓取完成
- **THEN** models.json 顶层包含 `update_time` 字段，值为当前月份（如 "2026年3月"）

### Requirement: 前端展示多维度分数
前端表格 SHALL 展示以下维度分数列：
- 数学推理
- 幻觉控制
- 科学推理
- 精确指令遵循
- 代码生成
- 智能体

#### Scenario: 表格渲染
- **WHEN** 页面加载数据
- **THEN** 表格包含所有维度列，且可排序

### Requirement: 前端展示更新时间
前端页面 SHALL 在表格上方显示榜单更新时间，格式为 "榜单更新时间：2026年3月"。

#### Scenario: 显示更新时间
- **WHEN** 数据加载完成
- **THEN** 页面显示正确的更新时间
