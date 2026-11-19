@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Мої валюти
python --version >nul 2>&1 || (echo Не знайдено Python. Встановіть Python 3.11+ з python.org ^(галочка "Add to PATH"^). & pause & exit /b)
echo Перевіряю бібліотеки...
python -m pip install -q -r server\requirements.txt
python server\main.py
pause
