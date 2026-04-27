# Create Cost Calculator Page Spec

## Why
基于用户提供的设计稿（assets/calculator/），实现成本计算页面，让用户可以根据使用场景（输入token、输出token、每日请求量）计算不同AI模型的成本，并进行对比选择。

## What Changes
- 新增 `calculator.html` - 成本计算页面
- 新增 `css/calculator.css` - 成本计算页面专属样式
- 新增 `js/calculator.js` - 成本计算逻辑和API对接
- 更新 `js/main.js` - 导航栏链接更新，添加Calculator入口
- 更新 `index.html` 或其他公共导航 - 确保全局导航一致

## Impact
- Affected specs: 新增成本计算功能
- Affected code: 新增calculator.html, calculator.css, calculator.js；更新导航相关代码

## ADDED Requirements

### Requirement: Cost Calculator Page
系统应提供成本计算页面，包含场景配置和模型成本对比功能。

#### Scenario: User configures scenario
- **WHEN** 用户调整输入token、输出token、每日请求量滑块
- **THEN** 实时更新预估月度成本

#### Scenario: User compares models
- **WHEN** 用户查看模型列表
- **THEN** 显示每个模型的预估月成本和性能指标

### Requirement: API Integration
系统应调用以下API：
- `GET /api/models` - 获取所有模型列表（包含定价信息）
- `POST /api/cost/calculate` - 计算单个模型成本
- `POST /api/cost/compare` - 批量对比多个模型成本

### Requirement: Design System
页面应遵循设计规范：
- 深色主题（#131313背景）
- 主色：#00FFA3 (Neo-Mint绿)
- 字体：Space Grotesk (标题), Inter (正文)
- Glassmorphism效果
- 响应式布局

## MODIFIED Requirements

### Requirement: Navigation
导航栏需添加"Calculator"入口，保持与其他页面一致的导航结构。

## REMOVED Requirements
无
