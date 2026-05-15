#!/bin/bash
# TMS API 测试脚本 - 修正版

# ========== 配置 ==========
SECRET_ID="your_secret_id"
SECRET_KEY="your_secret_key"
REGION="ap-guangzhou"
# =========================

if [ "$SECRET_ID" = "your_secret_id" ]; then
  echo "请先修改脚本中的 SECRET_ID 和 SECRET_KEY"
  exit 1
fi

TIMESTAMP=$(date +%s)
DATE=$(date -u +"%Y-%m-%d")

ACTION="TextModeration"
VERSION="2020-12-29"
SERVICE="tms"
HOST="tms.tencentcloudapi.com"

CONTENT=$(echo -n "test" | base64 -w 0)
PAYLOAD="{\"Content\":\"$CONTENT\"}"

HASHED_PAYLOAD=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hex | awk '{print $NF}')

CANONICAL_HEADERS="content-type:application/json; charset=utf-8
host:$HOST
x-tc-action:textmoderation
"
SIGNED_HEADERS="content-type;host;x-tc-action"

CANONICAL_REQUEST="POST
/

$CANONICAL_HEADERS
$SIGNED_HEADERS
$HASHED_PAYLOAD"

HASHED_CANONICAL_REQUEST=$(echo -n "$CANONICAL_REQUEST" | openssl dgst -sha256 -hex | awk '{print $NF}')

STRING_TO_SIGN="TC3-HMAC-SHA256
$TIMESTAMP
$DATE/$SERVICE/tc3_request
$HASHED_CANONICAL_REQUEST"

SECRET_DATE=$(echo -n "$DATE" | openssl dgst -sha256 -hmac "TC3$SECRET_KEY" -binary | xxd -p -c 256)
SECRET_SERVICE=$(echo -n "$SERVICE" | openssl dgst -sha256 -hmac "$SECRET_DATE" -binary | xxd -p -c 256)
SECRET_SIGNING=$(echo -n "tc3_request" | openssl dgst -sha256 -hmac "$SECRET_SERVICE" -binary | xxd -p -c 256)
SIGNATURE=$(echo -n "$STRING_TO_SIGN" | openssl dgst -sha256 -hmac "$SECRET_SIGNING" -hex | awk '{print $NF}')

AUTHORIZATION="TC3-HMAC-SHA256 Credential=$SECRET_ID/$DATE/$SERVICE/tc3_request, SignedHeaders=$SIGNED_HEADERS, Signature=$SIGNATURE"

echo "=== TMS API 测试 ==="
echo "地域：$REGION"
echo "时间：$(date)"
echo "RequestID 将显示在响应中"
echo ""

RESPONSE=$(curl -s -X POST "https://$HOST" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Host: $HOST" \
  -H "X-TC-Action: $ACTION" \
  -H "X-TC-Version: $VERSION" \
  -H "X-TC-Timestamp: $TIMESTAMP" \
  -H "X-TC-Region: $REGION" \
  -H "Authorization: $AUTHORIZATION" \
  -d "$PAYLOAD")

echo "响应:"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

ERROR_CODE=$(echo "$RESPONSE" | grep -o '"Code":"[^"]*"' | head -1 | cut -d'"' -f4)

echo ""
if [ -z "$ERROR_CODE" ]; then
  SUGGESTION=$(echo "$RESPONSE" | grep -o '"Suggestion":"[^"]*"' | cut -d'"' -f4)
  LABEL=$(echo "$RESPONSE" | grep -o '"Label":"[^"]*"' | cut -d'"' -f4)
  echo "✓ TMS API 调用成功"
  echo "  Suggestion: $SUGGESTION"
  echo "  Label: ${LABEL:-N/A}"
else
  echo "✗ TMS API 调用失败"
  echo "  错误码：$ERROR_CODE"
  if [ "$ERROR_CODE" = "AuthFailure.SignatureFailure" ]; then
    echo "  原因：签名验证失败，请检查密钥是否正确"
  elif [ "$ERROR_CODE" = "AuthFailure.SecretIdNotFound" ]; then
    echo "  原因：SecretId 不存在"
  fi
fi
