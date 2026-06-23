# Скрипт для запуска тестового веб-сервера на порту 8001

Write-Host "Starting test web server on port 8001..." -ForegroundColor Green

# Проверка наличия Python
$pythonCmd = $null
if (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonCmd = "python"
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    $pythonCmd = "python3"
} else {
    Write-Host "Error: Python not found! Please install Python or use another HTTP server." -ForegroundColor Red
    Write-Host ""
    Write-Host "Alternative options:" -ForegroundColor Yellow
    Write-Host "  1. Install Python: https://www.python.org/downloads/" -ForegroundColor White
    Write-Host "  2. Use Node.js: npx http-server . -p 8001" -ForegroundColor White
    Write-Host "  3. Use VS Code Live Server extension on port 8001" -ForegroundColor White
    exit 1
}

Write-Host "Test site will be available at: http://localhost:8001" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Yellow
Write-Host ""

& $pythonCmd -m http.server 8001
