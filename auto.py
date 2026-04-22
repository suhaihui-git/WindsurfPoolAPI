#!/usr/bin/env python3
"""
Windsurf 协议注册 — 测试并发版

流程 (6 步):
  1) 建邮箱
  2) POST /_devin-auth/connections
  3) POST /_devin-auth/email/start   -> email_verification_token
  4) 轮询邮箱拿 6 位 code
  5) POST /_devin-auth/email/complete    -> auth1_XXX + user_id
  6) POST /_backend/.../WindsurfPostAuth -> devin-session-token (= api_key)

输出: output/windsurf-{email}.json

用法:
  python windsurf_register_test.py
  python windsurf_register_test.py --count 5 --workers 3
"""

import argparse
import json
import os
import random
import re
import string
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import requests
from curl_cffi import requests as curl_requests


# ========== 配置 ==========

MAIL_API            = "域名邮箱api"
MAIL_ADMIN_PASSWORD = "api密码"

WS  = "https://windsurf.com"
UA  = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
IMP = "chrome131"

OUTPUT_DIR = "output"
print_lock = threading.Lock()


# ========== 工具 ==========

def log(msg):
    with print_lock:
        t = threading.current_thread().name
        prefix = f"[{t}] " if t.startswith("Task-") else ""
        print(f"{prefix}{msg}")


def rand_password(length=12):
    sp = "!@#$%^&*"
    must = [
        random.choice(string.ascii_uppercase),
        random.choice(string.ascii_lowercase),
        random.choice(sp),
        random.choice(string.digits),
    ]
    pool = string.ascii_letters + string.digits + sp
    must += random.choices(pool, k=length - 4)
    random.shuffle(must)
    return "".join(must)


_FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan",
          "Casey", "Riley", "Quinn", "Avery", "Cameron"]
_LAST  = ["Smith", "Johnson", "Williams", "Brown", "Jones",
          "Garcia", "Miller", "Davis"]


def rand_name():
    return f"{random.choice(_FIRST)} {random.choice(_LAST)}"


def H():
    """请求头 (JSON)"""
    return {
        "Content-Type": "application/json",
        "User-Agent":   UA,
        "Origin":       WS,
        "Referer":      f"{WS}/account/register",
        "Accept":       "*/*",
    }


# ========== Protobuf 最小编解码 ==========

def pb_str(field_num, s):
    """field_num (wire 2 string) = s,支持 1 字节长度"""
    if isinstance(s, str):
        s = s.encode()
    ln = len(s)
    if ln < 0x80:
        return bytes([(field_num << 3) | 2, ln]) + s
    # 2 字节 varint
    return bytes([(field_num << 3) | 2, (ln & 0x7f) | 0x80, ln >> 7]) + s


def pb_parse(data):
    """解析 string 字段,返回 [(field_num, bytes_value)],非 wire-2 字段忽略"""
    out, i = [], 0
    while i < len(data):
        tag = data[i]
        i += 1
        wt = tag & 7
        fn = tag >> 3
        if wt == 2:
            ln = data[i]; i += 1
            if ln & 0x80:
                ln = (ln & 0x7f) | (data[i] << 7); i += 1
            out.append((fn, data[i:i + ln]))
            i += ln
        else:
            # 跳过 varint / 定长字段
            if wt == 0:
                while data[i] & 0x80:
                    i += 1
                i += 1
            elif wt == 1:
                i += 8
            elif wt == 5:
                i += 4
            else:
                break
    return out


# ========== 邮箱 ==========

def create_mailbox():
    name = "ws" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    r = requests.post(
        f"{MAIL_API}/admin/new_address",
        headers={"x-admin-auth": MAIL_ADMIN_PASSWORD, "Content-Type": "application/json"},
        json={"name": name},
        timeout=10,
    )
    r.raise_for_status()
    d = r.json()
    return d["address"], d["jwt"]


_OTP_RE = [
    re.compile(r'(?:login\s+code|verification\s+code|verify\s+your|enter\s+the)[\s\S]{0,300}?\b(\d{6})\b', re.I),
    re.compile(r'\b(\d{6})\b'),
]


def poll_otp(mail_jwt, timeout=120):
    start = time.time()
    time.sleep(1.0)
    while time.time() - start < timeout:
        try:
            r = requests.get(
                f"{MAIL_API}/api/mails",
                headers={"Authorization": f"Bearer {mail_jwt}"},
                params={"limit": 5, "offset": 0},
                timeout=5,
            )
            if r.status_code == 200:
                for m in r.json().get("results", []):
                    body = (m.get("raw") or "") + "\n" + (m.get("text") or "")
                    for pat in _OTP_RE:
                        match = pat.search(body)
                        if match:
                            return match.group(1)
        except Exception:
            pass
        time.sleep(0.6)
    raise TimeoutError(f"OTP 超时 ({timeout}s)")


# ========== 主流程 ==========

def register_one():
    t0 = time.time()

    # 1) 建邮箱
    email, mail_jwt = create_mailbox()
    password = rand_password()
    name     = rand_name()
    log(f"📧 {email}")

    # 2) connections 预检查
    r = curl_requests.post(
        f"{WS}/_devin-auth/connections", headers=H(),
        json={"product": "windsurf", "email": email},
        impersonate=IMP, timeout=15,
    )
    if r.status_code != 200:
        raise Exception(f"connections {r.status_code}: {r.text[:200]}")

    # 3) email/start 领验证 token
    r = curl_requests.post(
        f"{WS}/_devin-auth/email/start", headers=H(),
        json={"email": email, "mode": "signup", "product": "Windsurf"},
        impersonate=IMP, timeout=15,
    )
    if r.status_code != 200:
        raise Exception(f"email/start {r.status_code}: {r.text[:200]}")
    ver_token = r.json()["email_verification_token"]

    # 4) 轮询 OTP
    code = poll_otp(mail_jwt)
    log(f"📨 code={code}")

    # 5) email/complete 建账号,拿 auth1_XXX + user_id
    r = curl_requests.post(
        f"{WS}/_devin-auth/email/complete", headers=H(),
        json={
            "email_verification_token": ver_token,
            "code":     code,
            "mode":     "signup",
            "password": password,
            "name":     name,
        },
        impersonate=IMP, timeout=20,
    )
    if r.status_code != 200:
        raise Exception(f"email/complete {r.status_code}: {r.text[:200]}")
    d = r.json()
    auth1   = d["token"]
    user_id = d["user_id"]

    # 6) WindsurfPostAuth:auth1_XXX -> devin-session-token (= api_key)
    pb_body = pb_str(1, auth1)
    r = curl_requests.post(
        f"{WS}/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth",
        headers={**H(), "Content-Type": "application/proto", "Accept": "application/proto"},
        data=pb_body,
        impersonate=IMP, timeout=30,
    )
    if r.status_code != 200:
        raise Exception(f"PostAuth {r.status_code}: {r.text[:200]}")

    api_key = account_id = org_id = None
    for fn, val in pb_parse(r.content):
        try:
            s = val.decode()
        except Exception:
            continue
        if   fn == 1 and s.startswith("devin-session-token$"): api_key    = s
        elif fn == 4 and s.startswith("account-"):             account_id = s
        elif fn == 5 and s.startswith("org-"):                 org_id     = s
    if not api_key:
        raise Exception("PostAuth: 未找到 devin-session-token")

    # 7) 保存
    result = {
        "email":      email,
        "password":   password,
        "name":       name,
        "api_key":    api_key,
        "user_id":    user_id,
        "account_id": account_id,
        "org_id":     org_id,
        "created_at": datetime.now().isoformat(),
    }
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = os.path.join(OUTPUT_DIR, f"windsurf-{email}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    log(f"✅ {time.time() - t0:.1f}s → {path}")
    return result


# ========== Worker + Main ==========

def worker(idx):
    threading.current_thread().name = f"Task-{idx}"
    try:
        data = register_one()
        return {"ok": True, "email": data["email"], "idx": idx}
    except Exception as e:
        log(f"❌ {e}")
        return {"ok": False, "error": str(e), "idx": idx}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--count",   type=int, default=1, help="注册数量")
    p.add_argument("--workers", type=int, default=1, help="并发线程数")
    args = p.parse_args()

    print(f"Windsurf 注册 — count={args.count} workers={args.workers}")
    print("=" * 60)

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(worker, i + 1) for i in range(args.count)]
        for f in as_completed(futures):
            results.append(f.result())

    ok = sum(1 for r in results if r["ok"])
    print("=" * 60)
    print(f"结果: {ok}/{args.count} 成功")
    for r in sorted(results, key=lambda x: x["idx"]):
        mark = "✅" if r["ok"] else "❌"
        info = r.get("email") or r.get("error", "")
        print(f"  {mark} Task-{r['idx']}: {info}")


if __name__ == "__main__":
    main()