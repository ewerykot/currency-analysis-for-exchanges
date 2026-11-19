#!/bin/sh
# Мої валюти — запуск на macOS / Linux
cd "$(dirname "$0")"
python3 -m pip install -q -r server/requirements.txt
python3 server/main.py
