@echo off
echo ===================================================
echo Iniciando Agentic Server e o Tunel Ngrok
echo Dominio: america-descriptive-lacy.ngrok-free.dev
echo ===================================================

:: Inicia o servidor local compilado em segundo plano na mesma janela
start /b node dist/cli.js serve

:: Espera 3 segundos para garantir que o servidor ligou
timeout /t 3 >nul

:: Inicia o ngrok com o seu dominio estatico
ngrok http --domain=america-descriptive-lacy.ngrok-free.dev 7676
