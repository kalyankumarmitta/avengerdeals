#!/bin/bash
cat > js/config.js << EOF
window.SITE_CONFIG = {
  telegramGroupUrl: "${TELEGRAM_GROUP_URL}",
  githubRepo: "${GITHUB_REPO}"
};
EOF
