#!/bin/bash
SECRET_ID="your_secret_id"
SECRET_KEY="your_secret_key"

TIMESTAMP=$(date +%s)
DATE=$(date -u +"%Y-%m-%d")

echo "Timestamp: $TIMESTAMP"
echo "Date: $DATE"
echo "Secret Key length: ${#SECRET_KEY}"

# 测试 HMAC
TEST=$(echo -n "$DATE" | openssl dgst -sha256 -hmac "TC3$SECRET_KEY" -hex)
echo "Secret Date (hex): $TEST"
