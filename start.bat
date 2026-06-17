@echo off
cd /d "%~dp0"
set PORT=8787
set CATALOG=catalog/dist/market_sources_catalog.json
echo Starting http://localhost:%PORT%/
start "" "http://localhost:%PORT%/"
python app.py --catalog %CATALOG% --port %PORT%
if errorlevel 1 (
  echo Python not found. Use Anaconda Prompt and run:
  echo python app.py --catalog %CATALOG% --port %PORT%
  pause
)
