@echo off
title MobiPOS License Administrator v2.1
cd /d "%~dp0"

chcp 65001 >nul
set PYTHONIOENCODING=utf-8

echo ===================================================
echo   MobiPOS License Administrator - Enterprise Suite
echo ===================================================
echo Demarrage de l'interface d'administration...
echo.

python admin_desktop\main.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR] Impossible de lancer l'application Python.
    echo Verifiez que Python 3 et les dependances sont bien installes.
    echo Tentative d'installation des dependances...
    python -m pip install PyQt6 cryptography requests qrcode pillow
    echo Relance de l'application...
    python admin_desktop\main.py
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo Lancement echoue. Veuillez verifier l'installation de Python.
        pause
    )
)
