# PATCH parcial de los 4 email templates nativos de Supabase Auth.
#
# Envia UNICAMENTE estas 8 claves (gated y verificadas abajo):
#   mailer_subjects_confirmation           mailer_templates_confirmation_content
#   mailer_subjects_recovery               mailer_templates_recovery_content
#   mailer_subjects_magic_link             mailer_templates_magic_link_content
#   mailer_subjects_email_change           mailer_templates_email_change_content
#
# Nada mas: ni site_url, ni uri_allow_list, ni mailer_autoconfirm,
# ni OTP/password/MFA/Google OAuth/SMTP/rate limits/JWT/storage/db/api.
#
# Autenticacion: token del Credential Manager de Windows (Supabase CLI:supabase),
# leido solo en memoria. Jamas se imprime.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\patch-email-templates.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\patch-email-templates.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\patch-email-templates.ps1 -ValidateRemoteTemplate
#
# Opcional: -Ref <project-ref>  (default: supabase\.temp\project-ref)
# -DryRun: valida el payload localmente y SALTA la red (no PATCH).
# -ValidateRemoteTemplate: GET /config/auth (solo lectura) y compara
#   mailer_templates_confirmation_content contra email-templates/confirm-signup.html,
#   reportando longitudes, SHA-256 y match exacto. No imprime secretos.

param(
    [string]$Ref = "",
    [switch]$DryRun,
    [switch]$Diagnose,
    [switch]$ValidateRemoteTemplate
)

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptRoot

# --- 0. Resolver project ref -------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Ref)) {
    $refFile = Join-Path $repoRoot "supabase\.temp\project-ref"
    if (-not (Test-Path -LiteralPath $refFile)) { throw "project-ref file not found: $refFile" }
    $Ref = (Get-Content -Raw -LiteralPath $refFile).Trim()
}
if ($Ref -notmatch "^[a-z0-9]{20}$") { throw "invalid project ref: $Ref" }

# --- 0.5 Helpers de autenticacion/diagnostico ---------------------------------
function Get-SupabaseToken {
    if (-not ("CredMan" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct CREDENTIAL {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
}
public static class CredMan {
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr Credential);
    [DllImport("advapi32.dll", EntryPoint="CredFree", SetLastError=true)]
    public static extern void CredFree(IntPtr Buffer);
}
"@
    }
    $credPtr = [IntPtr]::Zero
    if (-not [CredMan]::CredRead("Supabase CLI:supabase", 1, 0, [ref]$credPtr)) {
        throw "CredRead failed: token Supabase CLI:supabase not found"
    }
    try {
        $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure([System.IntPtr]$credPtr, [type][CREDENTIAL])
        $blob = New-Object byte[] $cred.CredentialBlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize)
        $token = [System.Text.Encoding]::UTF8.GetString($blob).Trim([char]0).Trim()
    } finally {
        [CredMan]::CredFree($credPtr)
    }
    if ([string]::IsNullOrWhiteSpace($token)) { throw "empty token" }
    return $token
}

function Get-Sha256Hex([byte[]]$bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLower() }
    finally { $sha.Dispose() }
}

function Write-ContentEqualityReport($localContent, $remoteContent) {
    $match = [string]::Equals($localContent, $remoteContent, [System.StringComparison]::Ordinal)
    Write-Output ("exact match            = {0}" -f $match)
    if (-not $match) {
        $n = [System.Math]::Min($localContent.Length, $remoteContent.Length)
        $firstDiff = -1
        for ($i = 0; $i -lt $n; $i++) {
            if ($localContent[$i] -ne $remoteContent[$i]) { $firstDiff = $i; break }
        }
        if ($firstDiff -eq -1) { $firstDiff = $n }
        $from = [System.Math]::Max(0, $firstDiff - 40)
        $len = 80
        Write-Output ("first_diff_index     = {0}" -f $firstDiff)
        Write-Output ("local  context       = {0}" -f $localContent.Substring($from, [System.Math]::Min($len, $localContent.Length - $from)))
        Write-Output ("remote context       = {0}" -f $remoteContent.Substring($from, [System.Math]::Min($len, $remoteContent.Length - $from)))
    }
}

# --- 0.6 Modo diagnostico: validar template remoto de confirmacion -------------
if ($ValidateRemoteTemplate) {
    $localPath = Join-Path $repoRoot "email-templates\confirm-signup.html"
    if (-not (Test-Path -LiteralPath $localPath)) { throw "local template not found: $localPath" }
    $localBytes = [System.IO.File]::ReadAllBytes($localPath)
    $localContent = [System.Text.Encoding]::UTF8.GetString($localBytes)
    $token = Get-SupabaseToken
    $uri = "https://api.supabase.com/v1/projects/$Ref/config/auth"
    try {
        $resp = (Invoke-RestMethod -Uri $uri -Method Get -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 30)
    } catch {
        Write-Output ("GET status            = {0}" -f [int]$_.Exception.Response.StatusCode)
        Write-Output "GET result            = ERROR"
        exit 1
    }
    $remoteContent = [string]$resp.mailer_templates_confirmation_content
    $remoteUtf8 = [System.Text.Encoding]::UTF8.GetBytes($remoteContent)
    Write-Output "remote-template-validation = TRUE (GET /config/auth, read-only)"
    Write-Output "project_ref          = $Ref"
    Write-Output "GET uri              = $uri"
    Write-Output "GET status           = 200 OK"
    Write-Output "remote subject       = $($resp.mailer_subjects_confirmation)"
    Write-Output "local length (chars) = $($localContent.Length)"
    Write-Output "remote length(chars) = $($remoteContent.Length)"
    Write-Output "local sha256         = $(Get-Sha256Hex $localBytes)"
    Write-Output "remote sha256        = $(Get-Sha256Hex $remoteUtf8)"
    if ($null -eq $resp.mailer_templates_confirmation_content) {
        Write-Output "WARNING: remote mailer_templates_confirmation_content is NULL"
    }
    Write-ContentEqualityReport $localContent $remoteContent
    exit 0
}

# --- 1. Generar payload (8 claves) desde config.toml + email-templates -------
$python = (Get-Command python -ErrorAction Stop).Source
$payloadTmp = Join-Path $env:TEMP "supabase-email-templates-payload.json"
$build = Join-Path $scriptRoot "build-templates-payload.py"
& $python $build --out $payloadTmp | Out-Null
if ($LASTEXITCODE -ne 0) { throw "payload build failed" }

$payload = Get-Content -Raw -LiteralPath $payloadTmp -Encoding UTF8 | ConvertFrom-Json

# --- 1.5 El valor real (post serializacion/deserializacion) de la propiedad
#      mailer_templates_confirmation_content DEBE ser el contenido exacto del
#      archivo email-templates/confirm-signup.html -----------------------------
$confirmLocalPath = Join-Path $repoRoot "email-templates\confirm-signup.html"
$confirmLocalBytes = [System.IO.File]::ReadAllBytes($confirmLocalPath)
$confirmLocalContent = [System.Text.Encoding]::UTF8.GetString($confirmLocalBytes)
$confirmJson = [string]$payload.mailer_templates_confirmation_content
$confirmExact = [string]::Equals($confirmJson, $confirmLocalContent, [System.StringComparison]::Ordinal)
Write-Output ("confirmation content matches file = {0}" -f $confirmExact)
if (-not $confirmExact) {
    throw "mailer_templates_confirmation_content != email-templates/confirm-signup.html (post-deserialize)"
}

$expected = @(
    "mailer_subjects_confirmation",      "mailer_templates_confirmation_content",
    "mailer_subjects_recovery",          "mailer_templates_recovery_content",
    "mailer_subjects_magic_link",        "mailer_templates_magic_link_content",
    "mailer_subjects_email_change",      "mailer_templates_email_change_content"
)
$actualKeys = @($payload.PSObject.Properties.Name)

# --- 2. Validaciones estrictas (no enviamos nada que no sea lo esperado) -----
$blockedRe = "site_url|uri_allow_list|mailer_autoconfirm|password_|jwt_|smtp_|external_|mfa_|rate_limit|sms_|hook_|captcha|sessions|web3|third_party|key|secret|oauth"
if (($actualKeys | Where-Object { $_ -match $blockedRe }).Count -gt 0) {
    throw "PAYLOAD CONTAINS NON-TEMPLATE KEYS - aborting"
}
$expectedCount = $expected.Count
$actualCount   = $actualKeys.Count
$missing = @($expected | Where-Object { $actualKeys -notcontains $_ })
$extra   = @($actualKeys | Where-Object { $expected -notcontains $_ })
if ($missing.Count -gt 0 -or $extra.Count -gt 0) {
    throw "KEY SET MISMATCH - expected=$expectedCount actual=$actualCount missing=$($missing -join ',') extra=$($extra -join ',')"
}
foreach ($k in $actualKeys) {
    $v = $payload.($k)
    if ($null -eq $v) { throw "missing value for $k" }
    if ([string]::IsNullOrWhiteSpace([string]$v)) { throw "empty value for $k" }
}

Write-Output "expected key count = $expectedCount"
Write-Output "actual key count   = $actualCount"
Write-Output "missing            = $($missing.Count)"
Write-Output "extra              = $($extra.Count)"
Write-Output "key-set validation = PASS"
Write-Output "payload validation = PASS"

if ($DryRun) {
    Write-Output "dry_run            = TRUE"
    Write-Output "project_ref        = $Ref"
    Write-Output "payload_sha256     = $((Get-FileHash -LiteralPath $payloadTmp -Algorithm SHA256).Hash.ToLower())"
    Write-Output "DRY-RUN: NO network/PATCH executed"
    exit 0
}

$body = $payload | ConvertTo-Json -Compress -Depth 5
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$sentHash = ([System.Security.Cryptography.SHA256]::Create()).ComputeHash($bodyBytes)
$sentHashHex = [System.BitConverter]::ToString($sentHash).Replace("-", "").ToLower()
$localHash = (Get-FileHash -LiteralPath $payloadTmp -Algorithm SHA256).Hash.ToLower()
Write-Output "project_ref       = $Ref"
Write-Output "payload_file      = $payloadTmp"
Write-Output "payload_sha256    = $localHash"
Write-Output "fields            = $($actualKeys -join ' | ')"
if ($Diagnose) {
    Write-Output "sent_body_sha256  = $sentHashHex"
    Write-Output "sent_body_bytes   = $($bodyBytes.Length)"
    Write-Output "sent_matches_file = $($sentHashHex -eq $localHash)"
}

# --- 3. Autenticacion via Credential Manager (solo en memoria) ---------------
$token = Get-SupabaseToken

# --- 4. PATCH parcial ---------------------------------------------------------
$uri = "https://api.supabase.com/v1/projects/$Ref/config/auth"
$headers = @{ Authorization = "Bearer $token" }
try {
    $resp = Invoke-WebRequest -Uri $uri -Method Patch -Headers $headers -ContentType "application/json" -Body $bodyBytes
    Write-Output "PATCH status      = $($resp.StatusCode)"
    Write-Output "PATCH result      = OK (solo los 4 templates actualizados)"
    if ($Diagnose) {
        Write-Output "PATCH method      = PATCH"
        Write-Output "PATCH uri         = $uri"
        Write-Output "PATCH content-type= application/json"
        Write-Output "PATCH body sha256 = $sentHashHex"
        Write-Output "PATCH body bytes  = $($bodyBytes.Length)"
    }
} catch {
    $code = [int]$_.Exception.Response.StatusCode
    Write-Output "PATCH status      = $code"
    Write-Output "PATCH result      = ERROR"
    if ($Diagnose) {
        Write-Output "PATCH method      = PATCH"
        Write-Output "PATCH uri         = $uri"
        Write-Output "PATCH content-type= application/json"
        Write-Output "PATCH body sha256 = $sentHashHex"
        Write-Output "PATCH body bytes  = $($bodyBytes.Length)"
        $errBody = ""
        try { $errBody = [string]$_.ErrorDetails.Message } catch { $errBody = "" }
        if ([string]::IsNullOrWhiteSpace($errBody)) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $errBody = $reader.ReadToEnd()
                }
            } catch { $errBody = "" }
        }
        $scrubbed = $errBody
        if (-not [string]::IsNullOrWhiteSpace($token)) {
            $scrubbed = $scrubbed -replace [regex]::Escape($token), "<redacted-token>"
        }
        $scrubbed = $scrubbed -replace "sbp_[A-Za-z0-9_\-]+", "<redacted-sbp>"
        $scrubbed = $scrubbed -replace "[A-Za-z0-9_\-\.]+@[A-Za-z0-9_\-\.]+", "<redacted-email>"
        $scrubbed = $scrubbed -replace "eyJ[A-Za-z0-9_\-\.]+", "<redacted-jwt>"
        if ($scrubbed.Length -gt 2000) { $scrubbed = $scrubbed.Substring(0, 2000) + " ... [truncated]" }
        Write-Output "PATCH error body  = $scrubbed"
    }
    exit 1
} finally {
    Remove-Item -LiteralPath $payloadTmp -Force -ErrorAction SilentlyContinue
}