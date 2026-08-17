@echo off
set /p commit_msg="Masukkan pesan commit: "

if "%commit_msg%"=="" (
    echo [ERROR] Pesan commit tidak boleh kosong!
    pause
    exit /b
)

echo.
echo 🚀 Running git add...
git add .

echo.
echo 📝 Running git commit...
git commit -m "%commit_msg%"

echo.
echo 📤 Running git push...
git push

echo.
echo ✅ Deploy Berhasil!
pause