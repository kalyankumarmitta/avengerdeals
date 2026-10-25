'use strict';

exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ telegramGroupUrl: process.env.TELEGRAM_GROUP_URL || '' }),
});
