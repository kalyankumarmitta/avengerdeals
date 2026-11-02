#!/bin/bash
cat > js/config.js << EOF
window.SITE_CONFIG = { sheetId: "1h8Jf8RGJC2qjcPnCybZNrM_DWcvTORtKP44r7Eggs00", sheetName: "Form Responses 1", telegramGroupUrl: "${TELEGRAM_GROUP_URL:-}" };
EOF
