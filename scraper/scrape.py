#!/usr/bin/env python3
"""
AIX未来视野 - 主数据抓取脚本
数据源: superclueai.com (SPA动态渲染页面)
使用 Playwright 无头浏览器抓取
"""

import json
import re
import shutil
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MODELS_FILE = DATA_DIR / "models.json"
BACKUP_FILE = DATA_DIR / "models_backup.json"

SOURCES = [
    {
        "name": "SuperCLUE通用榜",
        "url": "https://www.superclueai.com/generalpage",
    },
]

MAX_RETRIES = 3
PAGE_LOAD_TIMEOUT = 30000


def load_existing_data():
    if MODELS_FILE.exists():
        with open(MODELS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def backup_existing_data():
    if MODELS_FILE.exists():
        shutil.copy2(MODELS_FILE, BACKUP_FILE)
        print(f"[OK] 已备份旧数据 -> {BACKUP_FILE}")


def save_data(models):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(models, f, ensure_ascii=False, indent=2)
    print(f"[OK] 数据已保存: {len(models)} 条模型")


def infer_languages(vendor):
    chinese_vendors = [
        "智谱", "百度", "阿里", "阿里巴巴", "字节跳动", "月之暗面",
        "商汤", "科大讯飞", "零一", "清华", "智谱AI", "DeepSeek",
        "深度求索", "出门问问", "OPPO", "佳都科技", "360", "百川",
        "稀宇", "稀宇科技", "元象", "腾讯", "小米", "美团", "阶跃",
    ]
    if any(v in vendor for v in chinese_vendors):
        return "中文/英文"
    return "多语言"


def parse_superclue_table(page):
    models = []
    seen_names = set()

    try:
        page.wait_for_load_state("domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
    except PlaywrightTimeoutError:
        print(f"[WARN] 页面加载超时，尝试继续...")

    time.sleep(5)

    tables = page.query_selector_all("table")
    for table in tables:
        table_rows = table.query_selector_all("tr")
        if len(table_rows) < 3:
            continue

        for row in table_rows:
            cells = row.query_selector_all("td, th")
            if len(cells) < 5:
                continue

            cell_texts = [cell.inner_text().strip() for cell in cells]

            # 表格行格式: ['', '1', 'Doubao-Seed-2.0-pro...', '字节跳动', '闭源', '71.53']
            # 或者: ['1', 'Doubao-Seed-2.0-pro...', '字节跳动', '闭源', '71.53']
            rank_idx = None
            for ci in range(min(2, len(cell_texts))):
                ct = re.sub(r'[^0-9]', '', cell_texts[ci])
                if ct and ct.isdigit():
                    rank_idx = ci
                    break

            if rank_idx is None:
                continue

            try:
                rank = int(cell_texts[rank_idx])
                name = cell_texts[rank_idx + 1].strip() if rank_idx + 1 < len(cell_texts) else ""
                vendor = cell_texts[rank_idx + 2].strip() if rank_idx + 2 < len(cell_texts) else ""
                score_text = cell_texts[rank_idx + 3].strip() if rank_idx + 3 < len(cell_texts) else ""

                if not name or not vendor:
                    continue

                # 检查是否已有 score 字段（避免把其他数字当分数）
                try:
                    score = float(score_text)
                except ValueError:
                    continue

                if score > 100 or score < 0:
                    continue

                if name in seen_names:
                    continue
                seen_names.add(name)

                # 推断类型
                model_type = "闭源"
                for ci in range(rank_idx + 2, min(rank_idx + 5, len(cell_texts))):
                    if "开源" in cell_texts[ci]:
                        model_type = "开源"
                        break

                models.append({
                    "rank": rank,
                    "name": name,
                    "vendor": vendor,
                    "type": model_type,
                    "languages": infer_languages(vendor),
                    "score": round(score, 2),
                    "special": "-",
                })

                print(f"  [OK] #{rank} {name} ({vendor}) - {model_type} - {score}")

            except (ValueError, IndexError):
                continue

    return models


def scrape_source(source):
    name = source["name"]
    url = source["url"]
    print(f"\n{'='*60}")
    print(f"抓取: {name}")
    print(f"URL: {url}")
    print(f"{'='*60}")

    for attempt in range(1, MAX_RETRIES + 1):
        print(f"  尝试 {attempt}/{MAX_RETRIES}...")
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    headless=True,
                    args=[
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-gpu",
                        "--disable-dev-shm-usage",
                    ]
                )
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                )
                page = context.new_page()
                page.goto(url, timeout=PAGE_LOAD_TIMEOUT)
                models = parse_superclue_table(page)
                browser.close()
                return models
        except PlaywrightTimeoutError:
            print(f"  [WARN] 页面加载超时")
        except Exception as e:
            print(f"  [ERROR] {e}")

    print(f"  [FAIL] 无法从 {name} 抓取数据")
    return []


def main():
    print("AIX未来视野 - 数据抓取脚本")
    print(f"工作目录: {BASE_DIR}")
    print(f"数据文件: {MODELS_FILE}")

    backup_existing_data()

    all_models = []

    for source in SOURCES:
        models = scrape_source(source)
        if models:
            all_models.extend(models)
            print(f"[OK] {source['name']}: 抓取 {len(models)} 条")
        else:
            print(f"[WARN] {source['name']}: 无数据")

    # 去重
    seen = {}
    for m in all_models:
        key = m.get("name", "").strip()
        if key and key not in seen:
            seen[key] = m
    unique_models = list(seen.values())

    # 按分数降序排序
    unique_models.sort(key=lambda x: x.get("score", 0), reverse=True)

    # 重新分配排名
    for i, m in enumerate(unique_models):
        m["rank"] = i + 1

    if unique_models:
        save_data(unique_models)
        print(f"\n排名前5:")
        for m in unique_models[:5]:
            print(f"  #{m['rank']} {m['name']} ({m['vendor']}) - 评分: {m['score']}")
    else:
        existing = load_existing_data()
        if existing:
            print("[INFO] 本次抓取无新数据，保留上次数据")
            save_data(existing)
        else:
            print("[ERROR] 无数据可保存")
            sys.exit(1)

    print("\n抓取完成!")


if __name__ == "__main__":
    main()
