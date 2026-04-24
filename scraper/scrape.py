#!/usr/bin/env python3
"""
AIX未来视野 - 主数据抓取脚本
数据源: superclueai.com (SPA动态渲染页面)
使用 Playwright 无头浏览器抓取
支持多榜单: 通用排行榜、推理模型总排行榜、开源排行榜
"""

import json
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
MODELS_FILE = DATA_DIR / "models.json"
BACKUP_FILE = DATA_DIR / "models_backup.json"

SOURCES = [
    {
        "board_type": "general",
        "name": "通用排行榜",
        "url": "https://www.superclueai.com/generalpage",
    },
    {
        "board_type": "reasoning",
        "name": "推理模型总排行榜",
        "url": "https://www.superclueai.com/reasoningpage",
    },
    {
        "board_type": "open",
        "name": "开源排行榜",
        "url": "https://www.superclueai.com/openpage",
    },
]

MAX_RETRIES = 3
PAGE_LOAD_TIMEOUT = 30000


def load_existing_data():
    if MODELS_FILE.exists():
        with open(MODELS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"update_time": "", "leaderboards": {}}


def backup_existing_data():
    if MODELS_FILE.exists():
        shutil.copy2(MODELS_FILE, BACKUP_FILE)
        print(f"[OK] 已备份旧数据 -> {BACKUP_FILE}")


def save_data(leaderboards, update_time):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    output = {
        "update_time": update_time,
        "leaderboards": leaderboards,
    }
    with open(MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    total_models = sum(len(lb.get("models", [])) for lb in leaderboards.values())
    print(f"[OK] 数据已保存: {len(leaderboards)} 个榜单, 共 {total_models} 条模型")


def safe_float(text):
    if text == "-" or text == "":
        return "-"
    try:
        return round(float(text), 2)
    except ValueError:
        return "-"


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
        print(f"  [WARN] 页面加载超时，尝试继续...")

    time.sleep(5)

    try:
        page.wait_for_selector("table", timeout=10000)
    except PlaywrightTimeoutError:
        print(f"  [WARN] 未找到 table 元素")
        return models

    tables = page.query_selector_all("table")

    for table_idx, table in enumerate(tables):
        table_rows = table.query_selector_all("tr")

        if len(table_rows) < 3:
            continue

        first_row = table_rows[0]
        first_cells = first_row.query_selector_all("td, th")
        first_texts = [cell.inner_text().strip() for cell in first_cells]

        is_new_format = len(first_texts) >= 6 and (
            '模型名称' in first_texts or
            (len(first_texts) > 1 and first_texts[1] == '排名')
        )

        start_row = 1
        extracted_count = 0

        for row in table_rows[start_row:]:
            cells = row.query_selector_all("td, th")
            if len(cells) < 6:
                continue

            cell_texts = [cell.inner_text().strip() for cell in cells]

            if is_new_format:
                name = cell_texts[2] if len(cell_texts) > 2 else ""
                vendor = cell_texts[3] if len(cell_texts) > 3 else ""
                model_type_text = cell_texts[4] if len(cell_texts) > 4 else ""
                score_text = cell_texts[5] if len(cell_texts) > 5 else ""

                if not name or not vendor:
                    continue

                try:
                    score = float(score_text)
                except ValueError:
                    continue

                if score > 100 or score < 0:
                    continue

                math_reasoning = safe_float(cell_texts[6] if len(cell_texts) > 6 else "-")
                hallucination_control = safe_float(cell_texts[7] if len(cell_texts) > 7 else "-")
                science_reasoning = safe_float(cell_texts[8] if len(cell_texts) > 8 else "-")
                instruction_following = safe_float(cell_texts[9] if len(cell_texts) > 9 else "-")
                code_generation = safe_float(cell_texts[10] if len(cell_texts) > 10 else "-")
                agent_planning = safe_float(cell_texts[11] if len(cell_texts) > 11 else "-")
            else:
                rank_idx = None
                for ci in range(min(2, len(cell_texts))):
                    ct = re.sub(r'[^0-9]', '', cell_texts[ci])
                    if ct and ct.isdigit():
                        rank_idx = ci
                        break

                if rank_idx is None:
                    continue

                name = cell_texts[rank_idx + 1].strip() if rank_idx + 1 < len(cell_texts) else ""
                vendor = cell_texts[rank_idx + 2].strip() if rank_idx + 2 < len(cell_texts) else ""
                model_type_text = ""
                score_text = cell_texts[rank_idx + 3].strip() if rank_idx + 3 < len(cell_texts) else ""

                if not name or not vendor:
                    continue

                try:
                    score = float(score_text)
                except ValueError:
                    continue

                if score > 100 or score < 0:
                    continue

                math_reasoning = "-"
                hallucination_control = "-"
                science_reasoning = "-"
                instruction_following = "-"
                code_generation = "-"
                agent_planning = "-"

            if name in seen_names:
                continue
            seen_names.add(name)

            model_type = "闭源"
            if "开源" in model_type_text:
                model_type = "开源"

            rank = len(models) + 1

            models.append({
                "rank": rank,
                "name": name,
                "vendor": vendor,
                "type": model_type,
                "languages": infer_languages(vendor),
                "score": round(score, 2),
                "math_reasoning": math_reasoning,
                "hallucination_control": hallucination_control,
                "science_reasoning": science_reasoning,
                "instruction_following": instruction_following,
                "code_generation": code_generation,
                "agent_planning": agent_planning,
            })

            print(f"  [OK] #{rank} {name} ({vendor}) - {model_type} - {score}")
            extracted_count += 1

        if extracted_count > 0:
            print(f"  [INFO] 表格 {table_idx} 提取了 {extracted_count} 个模型")

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

    existing = load_existing_data()
    leaderboards = existing.get("leaderboards", {}) if isinstance(existing, dict) else {}

    for source in SOURCES:
        board_type = source["board_type"]
        models = scrape_source(source)

        if models:
            models.sort(key=lambda x: x.get("score", 0), reverse=True)
            for i, m in enumerate(models):
                m["rank"] = i + 1

            leaderboards[board_type] = {
                "name": source["name"],
                "models": models,
            }
            print(f"[OK] {source['name']}: 抓取 {len(models)} 条")

            top3 = models[:3]
            print(f"  排名前3:")
            for m in top3:
                print(f"    #{m['rank']} {m['name']} ({m['vendor']}) - {m['score']}")
        else:
            print(f"[WARN] {source['name']}: 无数据，保留上次数据")
            if board_type not in leaderboards:
                print(f"  [ERROR] {source['name']} 无历史数据可保留")

    now = datetime.now()
    update_time = f"{now.year}年{now.month}月"

    if any(lb.get("models") for lb in leaderboards.values()):
        save_data(leaderboards, update_time)
        print(f"\n榜单更新时间: {update_time}")
    else:
        print("[ERROR] 所有榜单均无数据可保存")
        sys.exit(1)

    print("\n抓取完成!")


if __name__ == "__main__":
    main()
