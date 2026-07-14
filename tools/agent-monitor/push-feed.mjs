#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const endpoint = process.env.MONITOR_ENDPOINT ?? 'http://localhost:3000/prototype/agent-monitor/api/feed';
const token = process.env.AGENT_MONITOR_FEED_TOKEN;
const file = process.argv[2];

if (!file) {
  console.error('Usage: node tools/agent-monitor/push-feed.mjs <feed.json>');
  process.exit(1);
}

const body = readFileSync(file, 'utf-8');
const headers = { 'content-type': 'application/json' };
if (token) {
  headers['x-monitor-token'] = token;
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers,
  body,
});

if (!response.ok) {
  console.error('Feed push failed:', response.status, await response.text());
  process.exit(1);
}

console.log(await response.text());
