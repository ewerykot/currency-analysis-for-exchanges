#!/bin/sh
# Мої валюти з доступом з інтернету (тунель Cloudflare) — macOS / Linux
cd "$(dirname "$0")"
python3 -m pip install -q -r server/requirements.txt
TUNNEL=1 python3 server/main.py
