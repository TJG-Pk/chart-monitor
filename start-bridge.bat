@echo off
rem ดับเบิลคลิกไฟล์นี้เพื่อเปิด bridge แล้วเปิดเบราว์เซอร์ไปที่ http://localhost:8000
chcp 65001 >nul
cd /d "%~dp0bridge"
if not exist .venv\Scripts\python.exe (
  echo ติดตั้งครั้งแรก กำลังสร้าง .venv และติดตั้ง MetaTrader5...
  py -3 -m venv .venv || python -m venv .venv || goto :nopython
  .venv\Scripts\python.exe -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail
)
title Chart Monitor bridge
rem bridge.py เปิดเบราว์เซอร์ให้เองเมื่อพร้อม
.venv\Scripts\python.exe bridge.py %*
pause
exit /b

:nopython
echo ไม่พบ Python กรุณาติดตั้ง Python 3.10 ขึ้นไปจาก python.org ก่อน
pause
exit /b 1

:fail
echo ติดตั้ง MetaTrader5 ไม่สำเร็จ
pause
exit /b 1
