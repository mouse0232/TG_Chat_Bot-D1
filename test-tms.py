#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TMS API 测试脚本 - Python 版本"""

import hmac
import hashlib
import time
from datetime import datetime
import requests

# ========== 配置 ==========
SECRET_ID = "your_secret_id"
SECRET_KEY = "your_secret_key"
REGION = "ap-guangzhou"
# =========================

if SECRET_ID == "your_secret_id":
    print("请先修改脚本中的 SECRET_ID 和 SECRET_KEY")
    exit(1)

# 请求参数
HOST = "tms.tencentcloudapi.com"
ACTION = "TextModeration"
VERSION = "2020-12-29"
SERVICE = "tms"
TIMESTAMP = str(int(time.time()))
DATE = datetime.utcnow().strftime("%Y-%m-%d")

# 请求体
CONTENT = "test"
PAYLOAD = {"Content": CONTENT}

def sign(secret_key, date, secret_id):
    """计算 TC3-HMAC-SHA256 签名"""
    # 1. 计算哈希
    def sha256hex(data):
        return hashlib.sha256(data.encode('utf-8')).hexdigest()
    
    def hmac_sha256(key, data):
        return hmac.new(key.encode('utf-8'), data.encode('utf-8'), hashlib.sha256).digest()
    
    # 2. 哈希请求体
    hashed_payload = sha256hex(str(PAYLOAD).replace("'", '"'))
    
    # 3. 规范请求
    canonical_headers = f"content-type:application/json; charset=utf-8\nhost:{HOST}\nx-tc-action:textmoderation\n"
    signed_headers = "content-type;host;x-tc-action"
    canonical_request = f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"
    hashed_canonical_request = sha256hex(canonical_request)
    
    # 4. 待签名字符串
    credential_scope = f"{DATE}/{SERVICE}/tc3_request"
    string_to_sign = f"TC3-HMAC-SHA256\n{TIMESTAMP}\n{credential_scope}\n{hashed_canonical_request}"
    
    # 5. 计算签名
    secret_date = hmac_sha256(f"TC3{secret_key}", DATE)
    secret_service = hmac_sha256(secret_date.hex(), SERVICE)
    secret_signing = hmac_sha256(secret_service.hex(), "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode('utf-8'), hashlib.sha256).hexdigest()
    
    return f"TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"

# 计算签名
authorization = sign(SECRET_KEY, DATE, SECRET_ID)

# 发送请求
headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Host": HOST,
    "X-TC-Action": ACTION,
    "X-TC-Version": VERSION,
    "X-TC-Timestamp": TIMESTAMP,
    "X-TC-Region": REGION,
    "Authorization": authorization
}

print("=== TMS API 测试 ===")
print(f"地域：{REGION}")
print(f"时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print(f"RequestID 将显示在响应中")
print()

import json
response = requests.post(f"https://{HOST}", headers=headers, data=json.dumps(PAYLOAD))
result = response.json()

print("响应:")
print(json.dumps(result, indent=2, ensure_ascii=False))

if "Response" in result and "Error" in result["Response"]:
    error = result["Response"]["Error"]
    print()
    print("✗ TMS API 调用失败")
    print(f"  错误码：{error['Code']}")
    print(f"  错误信息：{error['Message']}")
    if error['Code'] == 'AuthFailure.SignatureFailure':
        print()
        print("可能原因：")
        print("  1. SecretKey 复制时多了空格或换行")
        print("  2. 密钥被禁用或删除")
        print("  3. 账号没有开通 TMS 服务")
        print("  4. 使用的是子账号密钥但没有 TMS 权限")
else:
    suggestion = result.get("Response", {}).get("Suggestion", "")
    label = result.get("Response", {}).get("Label", "")
    print()
    print("✓ TMS API 调用成功")
    print(f"  Suggestion: {suggestion}")
    print(f"  Label: {label}")
