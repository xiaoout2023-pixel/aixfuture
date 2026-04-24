# AIXfuture Portal MVP 开发计划

## 项目概述
构建一个 **AIX未来视野** 门户网站，展示多维度大模型排名，用户可以在一张表格中比较不同模型的性能、价格、语言能力等核心指标。

## 品牌标识
- **名称**: AIX未来视野
- **Logo**: `AIX.jpg` (置于 Header 左侧)

## 技术栈
- **前端**: HTML + CSS + JavaScript (纯静态，无需框架)
- **数据抓取**: Python + Playwright (无头浏览器)
- **数据存储**: JSON 文件 (`models.json`)
- **部署**: Vercel (纯静态托管)
- **本地开发**: Python `http.server` 或 `npx serve`

---

## 设计规范 (Framer Inspired Design System)
- **风格**: 大胆的黑蓝色调、运动优先、设计导向
- **色调**: 深色电影感 UI (Dark cinematic UI)
- **特点**: Bold black and blue, motion-first, design-forward
- **参考**: https://getdesign.md/framer/design-md

---

## 实现步骤

### 第一阶段：项目初始化

1. 创建项目目录结构
   ```
   aix-future-cc/
   ├── index.html          # 首页 (排名表)
   ├── favicon.ico         # 网站图标 (可选)
   ├── css/
   │   └── style.css       # 样式
   ├── js/
   │   └── main.js         # 前端逻辑 (表格渲染、搜索、排序)
   ├── data/
   │   ├── models.json     # 模型数据
   │   └── models_backup.json  # 抓取备份 (抓取成功后自动备份)
   ├── scraper/
   │   ├── scrape.py       # 主数据抓取脚本 (Playwright)
   │   └── scrape_gitee.py # 备用数据源抓取脚本 (BeautifulSoup)
   ├── .github/
   │   └── workflows/
   │       └── scrape.yml  # GitHub Actions 定时抓取工作流
   ├── requirements.txt    # Python 依赖
   ├── vercel.json         # Vercel 部署配置
   └── docs/               # 已有设计文档
   ```

2. 创建 `requirements.txt`
   ```
   playwright>=1.40
   requests>=2.31
   beautifulsoup4>=4.12
   ```

3. 创建 `vercel.json`
   ```json
   {
     "buildCommand": null,
     "outputDirectory": ".",
     "devCommand": "npx serve"
   }
   ```

### 第二阶段：前端开发

4. **编写 `index.html`**
   - Header: Logo (`AIX.jpg` 左侧) + 品牌名 "AIX未来视野" + 导航链接 (Rankings / Models)
   - Hero 区域: 简洁的标题和描述语
   - 搜索框 (支持按模型名称/厂商搜索，带清除按钮)
   - 多维度排名表格 (7列: 排名、模型名称、厂商、类型、语言能力、评分、特殊能力)
   - Footer: 版权信息 + 数据来源说明
   - 移动端响应式 meta (`viewport`)
   - 引入 `css/style.css` 和 `js/main.js`

5. **编写 `css/style.css`**
   - CSS 变量定义 (主色: 深蓝 #0055ff, 背景: #0a0a0a, 文字: #f5f5f5)
   - Header 样式 (flex 布局，Logo 自适应大小)
   - Hero 区域样式 (大标题，副标题)
   - 搜索框样式 (圆角输入框，focus 高亮，带搜索图标)
   - 表格样式:
     - 深色背景，斑马纹行
     - 表头可点击列排序指示器 (↑↓ 箭头)
     - Hover 行高亮
     - 圆角卡片包裹
     - 响应式横向滚动
   - 响应式布局 (断点: 768px, 480px)
   - 动画过渡 (hover 效果、表格行淡入)

6. **编写 `js/main.js`**
   - 使用 `fetch('data/models.json')` 加载数据
   - 渲染表格 DOM
   - 列排序功能:
     - 点击表头切换排序方向 (升序/降序)
     - 数字列按数值排序
     - 字符串列按字母排序
     - 当前排序列高亮 + 方向指示
   - 搜索功能:
     - 实时搜索 (input 事件)
     - 模糊匹配模型名称和厂商
     - 无结果时显示提示
   - 移动端适配:
     - 表格横向滚动容器
     - 隐藏非核心列 (语言)
   - 数据为空时的 Loading 状态

### 第三阶段：数据层

7. **创建示例数据 `data/models.json`**
   - 按设计文档数据模型填充示例数据
   - 包含至少 10-15 个主流模型 (GPT-4, Claude 3, Gemini, 文心, 通义, GLM, 豆包, LLaMA 等)
   - JSON 字段结构:
     ```json
     [
       {
         "rank": 1,
         "name": "GPT-4o",
         "vendor": "OpenAI",
         "type": "闭源",
         "languages": "多语言",
         "score": 9.8,
         "special": "多模态、插件"
       }
     ]
     ```

8. **编写主抓取脚本 `scraper/scrape.py`**
   - **技术选型**: Playwright (无头浏览器) + Python
     - 原因: superclueai.com 是 SPA (单页应用)，数据通过 JS 动态渲染，requests/BeautifulSoup 无法直接获取数据
     - Playwright 可以模拟浏览器加载完整页面后提取 DOM 数据
     - **仅在本地运行**，不部署到 Vercel
   - **目标数据源**:
     - https://www.superclueai.com/generalpage (通用榜)
     - https://www.superclueai.com/benchmarkselection?category=multimodal (多模态榜)
     - 备用: https://gitee.com/mirrors/SuperCLUE (Gitee 镜像，含 HTML 表格数据)
   - **抓取字段映射**:
     | 抓取字段 | 映射到 JSON 字段 | 说明 |
     |----------|-----------------|------|
     | 排名 | rank | 榜单排名 |
     | 模型 | name | 模型名称 |
     | 机构 | vendor | 厂商/机构 |
     | 总分 | score | 综合评分 |
     | 使用方式 (API/网页/模型) | type | 开源/闭源 |
     | 语言与知识/多轮开放问题 | special | 特殊能力 |
     | 语言能力 | languages | 根据厂商信息推断 |
   - **抓取流程**:
     1. Playwright 启动无头 Chromium 浏览器
     2. 访问目标 URL，等待页面完全加载 (等待 DOM 中排名表格渲染完成，最长 30s)
     3. 使用 CSS 选择器定位表格数据并提取
     4. 按数据模型映射字段，缺失字段填充默认值
     5. 合并多数据源数据 (按模型名称去重)
     6. 先备份旧数据为 `models_backup.json`
     7. 写入 `data/models.json`
   - **错误处理与容错**:
     - 页面加载超时 (30s): 重试 3 次后使用上一次数据
     - 字段缺失: 使用默认值 (score=0, vendor="未知", languages="未知")
     - 网络异常: 捕获异常后提示并保留上一次数据
     - 每次成功抓取前自动备份 `models.json` → `models_backup.json`
   - **运行方式**: 本地手动运行 `python scraper/scrape.py`，每 15 天手动执行一次
   - **依赖安装**: `pip install -r requirements.txt` 然后 `playwright install chromium`

9. **创建备用数据源抓取 `scraper/scrape_gitee.py`**
   - 抓取 https://gitee.com/mirrors/SuperCLUE 上的 HTML 表格数据
   - 使用 requests + BeautifulSoup (静态 HTML，无需浏览器)
   - 作为 superclueai.com 抓取失败时的备用方案
   - 数据格式统一，与主抓取脚本输出一致
   - 可独立运行: `python scraper/scrape_gitee.py`

### 第四阶段：集成与测试

10. **前端与数据集成**
    - 确保 `main.js` 正确读取并渲染 `models.json`
    - 测试搜索和排序功能
    - 验证数据为空/加载失败的错误处理

11. **本地开发测试**
    - 使用 `python -m http.server 8000` 或 `npx serve` 启动本地服务器
    - 在浏览器中访问 `http://localhost:8000` 验证功能
    - 测试响应式布局 (使用浏览器开发者工具切换设备)

12. **部署到 Vercel**
    - 将代码 push 到 Git 仓库
    - Vercel 自动检测到 `vercel.json` 配置
    - 纯静态部署，无需构建步骤
    - 验证线上访问正常

### 第五阶段：响应式与验收

13. **响应式测试**
    - 桌面端 (1920x1080): 完整 7 列表格
    - 平板端 (768x1024): 完整表格，搜索框自适应
    - 移动端 (375x667): 表格横向滚动，隐藏次要列

14. **验收标准**
    - [ ] 用户可查看多维度模型排名
    - [ ] 支持按列排序 (升序/降序)
    - [ ] 支持搜索模型名称和厂商
    - [ ] 桌面端和移动端均可正常访问
    - [ ] 数据抓取脚本可在本地正常运行
    - [ ] 网站部署到 Vercel 后可公网访问

---

## 文件创建清单

| 文件 | 说明 |
|------|------|
| `index.html` | 主页面 |
| `css/style.css` | 样式文件 |
| `js/main.js` | 前端交互逻辑 |
| `data/models.json` | 模型数据 (示例 + 抓取结果) |
| `data/models_backup.json` | 上次抓取数据备份 |
| `scraper/scrape.py` | Python 数据抓取脚本 (Playwright) |
| `scraper/scrape_gitee.py` | 备用数据源抓取脚本 (BeautifulSoup) |
| `requirements.txt` | Python 依赖列表 |
| `vercel.json` | Vercel 部署配置 |

---

## 重要说明

### Vercel 部署架构
- 抓取脚本 **不部署到 Vercel** (Vercel Serverless 没有 Chromium，Playwright 无法运行)
- Vercel 只托管 **纯静态前端** (HTML + CSS + JS)
- 数据抓取在 **本地手动执行**，将结果 commit 到 Git
- Vercel 部署时直接读取 `data/models.json`

### 本地开发环境要求
- Python 3.8+ (用于本地 HTTP 服务器 + 抓取脚本)
- Node.js (可选，用于 `npx serve` 本地预览)
- Playwright Chromium (~130MB，首次安装时下载)

### 数据更新流程
1. 本地运行 `python scraper/scrape.py`
2. 检查 `data/models.json` 数据正确性
3. `git add data/models.json && git commit -m "update models data"`
4. `git push` → Vercel 自动部署
