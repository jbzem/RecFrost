param(
	[string]$App,
	[string]$Root
)

$ErrorActionPreference = 'Stop'

if (-not $App) { Write-Error "App name required. Usage: deploy.ps1 -App <name>"; exit 1 }
if (-not $Root) { $Root = (Get-Location).Path }
$Root = $Root.TrimEnd('\')

$appDir = Join-Path $Root "apps\$App"
if (-not (Test-Path $appDir)) { Write-Error "No such app: $appDir"; exit 1 }

# --- load repo .env (mirrors recflare_load_env; exported env wins by being inherited) ---
$envFile = Join-Path $Root '.env'
$envVars = @{}
if (Test-Path $envFile) {
	foreach ($line in (Get-Content $envFile)) {
		$l = $line.Trim()
		if ($l -eq '' -or $l.StartsWith('#')) { continue }
		if ($l -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { continue }
		$k = $Matches[1]
		$v = $Matches[2].Trim()
		if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
			$v = $v.Substring(1, $v.Length - 2)
		}
		$envVars[$k] = $v
	}
}

$domain = $envVars['RECFLARE_DOMAIN']
if (-not $domain) { Write-Error 'RECFLARE_DOMAIN is not set in .env'; exit 1 }
$store = $envVars['RECFLARE_SECRETS_STORE']
$d1 = $envVars['RECFLARE_D1']
$kvJson = $envVars['RECFLARE_KV']
$subdomainsJson = if ($envVars['RECFLARE_SUBDOMAINS']) { $envVars['RECFLARE_SUBDOMAINS'] } else { '{}' }

$kvMap = @{}
if ($kvJson) {
	try {
		$kvObj = $kvJson | ConvertFrom-Json
		foreach ($p in $kvObj.PSObject.Properties) { $kvMap[$p.Name] = $p.Value }
	} catch { Write-Warning "RECFLARE_KV not valid JSON: $_" }
}
$subMap = @{}
try {
	$subObj = $subdomainsJson | ConvertFrom-Json
	foreach ($p in $subObj.PSObject.Properties) { $subMap[$p.Name] = $p.Value }
} catch { Write-Warning 'RECFLARE_SUBDOMAINS not valid JSON' }

# --- package name + version (SENTRY_RELEASE) ---
$pkg = Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version

# --- pick config: Vite-built (dist/<app>/wrangler.json) else wrangler.jsonc ---
$viteConfig = Join-Path $appDir "dist\$App\wrangler.json"
$isVite = $false
if (Test-Path $viteConfig) { $config = $viteConfig; $isVite = $true }
else { $config = Join-Path $appDir 'wrangler.jsonc' }
if (-not (Test-Path $config)) { Write-Error "No wrangler config at $config"; exit 1 }

# --- splice "local" placeholders -> real ids (mirrors run-wrangler-deploy) ---
$genPath = if ($isVite) { Join-Path $appDir "dist\$App\wrangler.generated.json" } else { Join-Path $appDir 'wrangler.generated.jsonc' }
$text = Get-Content $config -Raw

if ($isVite) {
	$cfg = $text | ConvertFrom-Json
	if ($d1) { foreach ($db in $cfg.d1_databases) { if ($db.database_id -eq 'local') { $db.database_id = $d1 } } }
	if ($kvMap.Count) { foreach ($ns in $cfg.kv_namespaces) { if ($ns.id -eq 'local' -and $kvMap.ContainsKey($ns.binding)) { $ns.id = $kvMap[$ns.binding] } } }
	if ($store) { foreach ($s in $cfg.secrets_store_secrets) { if ($s.store_id -eq 'local') { $s.store_id = $store } } }
	$cfg | ConvertTo-Json -Depth 20 | Set-Content $genPath -NoNewline
} else {
	# String replacements (no regex group refs, so an id beginning with digits can't be
	# mistaken for a backreference like `$18`).
	if ($d1) { $text = $text -replace '"database_id"\s*:\s*"local"', ('"database_id": "' + $d1 + '"') }
	if ($store) { $text = $text -replace '"store_id"\s*:\s*"local"', ('"store_id": "' + $store + '"') }
	if ($kvMap.Count) {
		$lines = $text -split "`n"
		$curBind = $null
		for ($i = 0; $i -lt $lines.Count; $i++) {
			if ($lines[$i] -match '"binding"\s*:\s*"([^"]+)"') { $curBind = $Matches[1] }
			if ($curBind -and $kvMap.ContainsKey($curBind) -and $lines[$i] -match '"id"\s*:\s*"local"') {
				$lines[$i] = $lines[$i] -replace '"id"\s*:\s*"local"', ('"id": "' + $kvMap[$curBind] + '"')
				$curBind = $null
			}
		}
		$text = $lines -join "`n"
	}
	Set-Content $genPath -Value $text -NoNewline
}

# --- tuning knobs: every RECFLARE_<X> (non-reserved) -> --var X=VALUE (mirrors recflare_vars) ---
$reserved = @('DOMAIN', 'SUBDOMAINS', 'D1', 'KV', 'SECRETS_STORE', 'ENV_LOADED')
$extraVars = @()
foreach ($k in $envVars.Keys) {
	if ($k -notlike 'RECFLARE_*') { continue }
	$suffix = $k.Substring('RECFLARE_'.Length)
	if ($reserved -contains $suffix) { continue }
	$val = $envVars[$k]
	if ($val -eq '') { continue }
	$extraVars += @('--var', "${suffix}:${val}")
}

# --- custom-domain flag (workers.dev needs no --domain) ---
$domainFlag = @()
if ($domain -notlike '*.workers.dev') {
	$sub = if ($subMap.ContainsKey($App)) { $subMap[$App] } else { $App }
	$domainFlag = @('--domain', "$sub.$domain")
}

$minify = if (-not $isVite) { '--minify' } else { '' }

# Optional: bypass local TLS/proxy interception (set RECFLARE_INSECURE_TLS=1).
if ($env:RECFLARE_INSECURE_TLS) { $env:NODE_TLS_REJECT_UNAUTHORIZED = '0' }

# --- deploy ---
# NOTE: `--var` takes `KEY:VALUE` (colon) — wrangler splits on ':' only, so an
# `=` form silently creates a var literally named `KEY=VALUE` and the real key
# falls back to the committed config. That misdeploy left every worker running
# placeholder vars (notably DOMAIN=rec.example.com); do not "simplify" this.
# wrangler's bundled CLI entry, run under node directly: `bun x wrangler` goes
# through cmd.exe, which mangles repo paths containing spaces/parens (e.g. a
# checkout under "RecFrost Private Development"). node gets argv straight
# through CreateProcess with no shell involved; same code either way.
$wranglerCli = Join-Path $appDir 'node_modules\wrangler\wrangler-dist\cli.js'
if (-not (Test-Path $wranglerCli)) {
	Write-Error "wrangler CLI not found at $wranglerCli (run install first)"
	exit 1
}
$wArgs = @($wranglerCli, 'deploy', '--config', $genPath,
	'--var', "NAME:${name}",
	'--var', "SENTRY_RELEASE:${version}",
	'--var', "DOMAIN:${domain}",
	'--var', "SUBDOMAINS:${subdomainsJson}")
$wArgs += $extraVars
$wArgs += $domainFlag
if ($minify) { $wArgs += $minify }

Write-Host "Deploying worker '$name' (v$version) to $domain"
Push-Location $appDir
# Native stderr must not be fatal here: node/wrangler warnings (e.g. the TLS
# bypass notice) go to stderr with a zero exit, and $ErrorActionPreference is
# 'Stop' above. Only the process exit code decides success.
$prevEAP = $ErrorActionPreference
try {
	$ErrorActionPreference = 'Continue'
	& node @wArgs
	$exit = $LASTEXITCODE
} finally {
	$ErrorActionPreference = $prevEAP
	Pop-Location
	Remove-Item $genPath -Force -ErrorAction SilentlyContinue
}
exit $exit
