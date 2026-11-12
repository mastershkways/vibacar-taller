# Lanza las pruebas de las Fases 3 a 4 sin tocar la base real: base temporal + seed + servidor en 5055 por ciclo,
# navegador headless (Brave/Chrome/Edge) para las de interfaz y las pruebas de migración (roles y Tablero v2).
# Uso: powershell -ExecutionPolicy Bypass -File tests\ejecutar-fase3.ps1 [-SinNavegador] [-Solo tecnico,planificador] [-Brave "C:\ruta\brave.exe"]
#   -Solo: lista de ciclos a lanzar (clientes2, maquinas2, tablero2, tablero2nav, planificador, planificadornav, tecnico, tecniconav, karve, migraciones); sin él, todos.
param(
  [string]$Brave = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
  [switch]$SinNavegador,
  [string[]]$Solo = @()
)
$ErrorActionPreference = 'Continue'
$Solo = @($Solo | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })   # con -File, "a,b" llega como un solo texto
$raiz = Split-Path $PSScriptRoot -Parent
$tmp = Join-Path $env:TEMP 'vibacar-taller-pruebas'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$script:fallos = 0
$script:resumen = @()

# Mata el árbol de procesos que escucha en un puerto (node o el navegador, que relanza procesos hijos).
function Matar-Puerto($puerto) {
  $pids = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) { if ($p -gt 0) { & taskkill /PID $p /T /F 2>$null | Out-Null } }
}

function Esperar-Url($url, $segundos) {
  for ($i = 0; $i -lt $segundos * 2; $i++) {
    try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Ejecutar-Script($nombre) {
  Write-Host "`n=== $nombre ===" -ForegroundColor Cyan
  $salida = & node (Join-Path $PSScriptRoot $nombre) 2>&1 | ForEach-Object { "$_" }
  $salida | ForEach-Object { if ($_ -match '^FALLO|^ERROR') { Write-Host $_ -ForegroundColor Red } elseif ($_ -match 'fallos$') { Write-Host $_ -ForegroundColor Yellow } else { Write-Host $_ } }
  $linea = ($salida | Where-Object { $_ -match '(\d+)/(\d+) OK, (\d+) fallos' } | Select-Object -Last 1)
  if ($linea -and $linea -match '(\d+)/(\d+) OK, (\d+) fallos') {
    $n = [int]$matches[3]
    $script:resumen += "$nombre : $($matches[1])/$($matches[2]) OK"
    if ($n -gt 0) { $script:fallos += $n }
  } else {
    $script:resumen += "$nombre : SIN RESUMEN (error)"
    $script:fallos += 1
  }
}

function Quiere($nombre) { return ($Solo.Count -eq 0) -or ($Solo -contains $nombre) }

function Ciclo($nombre, $scripts) {
  if (-not (Quiere $nombre)) { return }
  $db = Join-Path $tmp "$nombre.db"
  Get-ChildItem -Path $tmp -Filter "$nombre.db*" -ErrorAction SilentlyContinue | Remove-Item -Force
  $env:PORT = '5055'; $env:RUTA_BD = $db; $env:APP_USUARIO = 'admin_prueba'; $env:APP_CLAVE = 'clave-prueba-123'
  Write-Host "`n### Ciclo $nombre : base temporal + datos de prueba" -ForegroundColor Green
  & node (Join-Path $raiz 'scripts\generar-datos-prueba.js') | Select-Object -Last 1 | Write-Host
  $srv = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $raiz -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $tmp "$nombre-servidor.log") -RedirectStandardError (Join-Path $tmp "$nombre-servidor.err")
  if (-not (Esperar-Url 'http://localhost:5055/acceso' 15)) { Write-Host 'El servidor de prueba no arranca en 5055 (¿puerto ocupado?)' -ForegroundColor Red; $script:fallos += 1 }
  else {
    foreach ($s in $scripts) {
      if ($SinNavegador -and $s -like 'navegador-*') { $script:resumen += "$s : omitido (-SinNavegador)"; continue }
      Ejecutar-Script $s
    }
  }
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
  Matar-Puerto 5055
  Start-Sleep -Milliseconds 500
}

foreach ($puerto in 5055, 9333) {
  if (Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue) { Write-Host "El puerto $puerto ya está en uso: ciérralo antes de lanzar las pruebas" -ForegroundColor Red; exit 2 }
}
$brv = $null
if (-not $SinNavegador) {
  if (-not (Test-Path $Brave)) { Write-Host "No existe el navegador $Brave; usa -Brave o -SinNavegador" -ForegroundColor Red; exit 2 }
  $perfil = Join-Path $tmp 'brave-perfil'
  $brv = Start-Process -FilePath $Brave -ArgumentList "--headless=new --remote-debugging-port=9333 --user-data-dir=`"$perfil`" --no-first-run --disable-gpu" -PassThru -WindowStyle Hidden
  if (-not (Esperar-Url 'http://127.0.0.1:9333/json/version' 15)) { Write-Host 'El navegador headless no responde en 9333' -ForegroundColor Red; exit 2 }
}

Ciclo 'clientes2' @('cliente-prueba-clientes2.js', 'navegador-prueba-clientes2.js')
Ciclo 'maquinas2' @('cliente-prueba-maquinas2.js', 'navegador-prueba-maquinas2.js', 'navegador-colores.js', 'cliente-prueba-numeracion.js')
Ciclo 'tablero2' @('cliente-prueba-tablero2.js')
Ciclo 'tablero2nav' @('navegador-prueba-tablero2.js')   # base aparte: el arnés HTTP deja el seed cambiado y el de navegador cuenta tarjetas del seed
Ciclo 'planificador' @('cliente-prueba-planificador.js')
Ciclo 'planificadornav' @('navegador-prueba-planificador.js')
Ciclo 'tecnico' @('cliente-prueba-tecnico.js')
Ciclo 'tecniconav' @('navegador-prueba-tecnico.js')

if (-not (Quiere 'karve')) { }
elseif (Select-String -Path (Join-Path $raiz '.env') -Pattern '^KARVE_COPIA_CONNECTION_STRING=' -Quiet -ErrorAction SilentlyContinue) {
  Ciclo 'karve' @('cliente-prueba-karve.js', 'cliente-prueba-importar-ot.js', 'navegador-prueba-karve.js')
} else { $script:resumen += 'ciclo karve : omitido (sin KARVE_COPIA_CONNECTION_STRING en el .env)' }

if (Quiere 'migraciones') {
  Write-Host "`n### Migración de roles (base sintética)" -ForegroundColor Green
  $env:RUTA_BD = Join-Path $tmp 'migracion.db'; $env:APP_USUARIO = 'jefe'
  Ejecutar-Script 'prueba-migracion-roles.js'
  Write-Host "`n### Migración del Tablero v2 (base con los estados antiguos)" -ForegroundColor Green
  $env:RUTA_BD = Join-Path $tmp 'migracion-tablero.db'; $env:APP_USUARIO = 'admin_prueba'; $env:APP_CLAVE = 'clave-prueba-123'
  Ejecutar-Script 'prueba-migracion-tablero.js'
  $env:RUTA_BD = Join-Path $tmp 'numeracion.db'; $env:APP_USUARIO = 'admin_prueba'; $env:APP_CLAVE = 'clave-prueba-123'
  Ejecutar-Script 'prueba-numeracion-y-limpiar.js'
  Write-Host "`n### Bloques automáticos de la importación de Karve (base sintética, sin Karve)" -ForegroundColor Green
  $env:RUTA_BD = Join-Path $tmp 'bloques-auto.db'; $env:APP_USUARIO = 'admin_prueba'; $env:APP_CLAVE = 'clave-prueba-123'
  Ejecutar-Script 'prueba-bloques-automaticos.js'
}

if ($brv) { Stop-Process -Id $brv.Id -Force -ErrorAction SilentlyContinue; Matar-Puerto 9333 }

Write-Host "`n=== RESUMEN ===" -ForegroundColor Cyan
$script:resumen | ForEach-Object { Write-Host "  $_" }
if ($script:fallos -gt 0) { Write-Host "`nFALLOS: $($script:fallos)" -ForegroundColor Red; exit 1 }
Write-Host "`nTodo OK" -ForegroundColor Green
exit 0
