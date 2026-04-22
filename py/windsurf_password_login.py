#!/usr/bin/env python3
"""
Login to Windsurf via /_devin-auth/password/login, then exchange the
returned auth token via WindsurfPostAuth to get a devin-session-token.

Usage:
  python examples/windsurf_password_login.py --email "your@email.com" --password "your-password"

Or via env vars:
  WINDSURF_EMAIL="your@email.com" WINDSURF_PASSWORD="your-password" python examples/windsurf_password_login.py
"""

import argparse
import json
import os
import sys
from datetime import datetime

import requests

try:
    from curl_cffi import requests as curl_requests
except Exception:
    curl_requests = None

WS = "https://windsurf.com"
LOGIN_URL = f"{WS}/_devin-auth/password/login"
POST_AUTH_URL = f"{WS}/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth"
TIMEOUT = 20
POST_AUTH_TIMEOUT = 30
OUTPUT_DIR = "output"
IMP = "chrome131"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def parse_args():
    parser = argparse.ArgumentParser(description="Windsurf password login + post-auth exchange")
    parser.add_argument("--email", default=os.getenv("WINDSURF_EMAIL", ""), help="Windsurf email")
    parser.add_argument("--password", default=os.getenv("WINDSURF_PASSWORD", ""), help="Windsurf password")
    parser.add_argument("--raw", action="store_true", help="Print raw login and post-auth payloads")
    parser.add_argument("--save", action="store_true", help="Save result JSON to output directory")
    parser.add_argument("--output-dir", default=OUTPUT_DIR, help="Directory for --save output")
    return parser.parse_args()


def H(content_type="application/json", accept="application/json, text/plain, */*"):
    return {
        "Content-Type": content_type,
        "Accept": accept,
        "Origin": WS,
        "Referer": f"{WS}/",
        "User-Agent": UA,
    }


def pb_str(field_num, s):
    if isinstance(s, str):
        s = s.encode()
    ln = len(s)
    if ln < 0x80:
        return bytes([(field_num << 3) | 2, ln]) + s
    return bytes([(field_num << 3) | 2, (ln & 0x7F) | 0x80, ln >> 7]) + s


def pb_parse(data):
    out, i = [], 0
    while i < len(data):
        tag = data[i]
        i += 1
        wt = tag & 7
        fn = tag >> 3
        if wt == 2:
            ln = data[i]
            i += 1
            if ln & 0x80:
                ln = (ln & 0x7F) | (data[i] << 7)
                i += 1
            out.append((fn, data[i:i + ln]))
            i += ln
        else:
            if wt == 0:
                while i < len(data) and data[i] & 0x80:
                    i += 1
                i += 1
            elif wt == 1:
                i += 8
            elif wt == 5:
                i += 4
            else:
                break
    return out


def post(url, *, headers, json_body=None, data=None, timeout=TIMEOUT):
    if curl_requests is not None:
        return curl_requests.post(
            url,
            headers=headers,
            json=json_body,
            data=data,
            impersonate=IMP,
            timeout=timeout,
        )
    return requests.post(url, headers=headers, json=json_body, data=data, timeout=timeout)


def parse_json_response(response):
    content_type = response.headers.get("content-type", "")
    try:
        if "json" in content_type.lower():
            return response.json()
    except ValueError:
        pass
    try:
        return response.json()
    except Exception:
        return {"text": response.text}


def login_with_password(email, password):
    response = post(
        LOGIN_URL,
        headers=H(),
        json_body={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    data = parse_json_response(response)
    if response.status_code != 200:
        raise RuntimeError(f"password/login {response.status_code}: {json.dumps(data, ensure_ascii=False)[:400]}")

    token = data.get("token")
    if not token:
        raise RuntimeError(f"password/login succeeded but no token returned: {json.dumps(data, ensure_ascii=False)[:400]}")

    return data


def exchange_post_auth(auth_token):
    pb_body = pb_str(1, auth_token)
    response = post(
        POST_AUTH_URL,
        headers=H(content_type="application/proto", accept="application/proto"),
        data=pb_body,
        timeout=POST_AUTH_TIMEOUT,
    )
    if response.status_code != 200:
        preview = response.text if hasattr(response, "text") else repr(response.content[:200])
        raise RuntimeError(f"WindsurfPostAuth {response.status_code}: {preview[:400]}")

    api_key = None
    account_id = None
    org_id = None
    decoded_fields = []

    for fn, val in pb_parse(response.content):
        try:
            s = val.decode()
        except Exception:
            continue
        decoded_fields.append({"field": fn, "value": s})
        if fn == 1 and s.startswith("devin-session-token$"):
            api_key = s
        elif fn == 4 and s.startswith("account-"):
            account_id = s
        elif fn == 5 and s.startswith("org-"):
            org_id = s

    if not api_key:
        raise RuntimeError("WindsurfPostAuth succeeded but no devin-session-token found")

    return {
        "api_key": api_key,
        "account_id": account_id,
        "org_id": org_id,
        "decoded_fields": decoded_fields,
    }


def save_result(result, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    safe_email = result["email"].replace("@", "_at_")
    path = os.path.join(output_dir, f"windsurf-login-{safe_email}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return path


def main():
    args = parse_args()

    if not args.email or not args.password:
        print(
            "Missing email or password. Use --email/--password or WINDSURF_EMAIL/WINDSURF_PASSWORD.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        login_data = login_with_password(args.email, args.password)
        auth_token = login_data.get("token", "")
        post_auth_data = exchange_post_auth(auth_token)
    except requests.RequestException as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        sys.exit(3)

    result = {
        "ok": True,
        "email": login_data.get("email", args.email),
        "user_id": login_data.get("user_id", ""),
        "token": auth_token,
        "api_key": post_auth_data["api_key"],
        "account_id": post_auth_data["account_id"],
        "org_id": post_auth_data["org_id"],
        "created_at": datetime.now().isoformat(),
    }

    if args.save:
        result["saved_to"] = save_result(result, args.output_dir)

    if args.raw:
        result["raw"] = {
            "login": login_data,
            "post_auth": post_auth_data,
        }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
