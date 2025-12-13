<#
.SYNOPSIS
    Update password in proxy URLs
.DESCRIPTION
    Reads a file with proxy URLs and replaces the password portion with a new password.
    Supports formats: socks5h://user:pass@host:port, http://user:pass@host:port
.PARAMETER InputFile
    Path to the input file containing proxy URLs (one per line)
.PARAMETER OutputFile
    Path to the output file for updated proxy URLs
.PARAMETER NewPassword
    The new password to set for all proxies
.EXAMPLE
    .\update_proxies_password.ps1 -InputFile proxies.private.txt -OutputFile proxies.updated.txt -NewPassword "newpass123"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$InputFile,
    
    [Parameter(Mandatory=$true)]
    [string]$OutputFile,
    
    [Parameter(Mandatory=$true)]
    [string]$NewPassword
)

# Check if input file exists
if (-not (Test-Path $InputFile)) {
    Write-Error "Input file not found: $InputFile"
    exit 1
}

# Read input file
$proxies = Get-Content $InputFile

$updatedProxies = @()
$count = 0

foreach ($proxy in $proxies) {
    # Skip empty lines and comments
    if ([string]::IsNullOrWhiteSpace($proxy) -or $proxy.StartsWith("#")) {
        $updatedProxies += $proxy
        continue
    }
    
    # Match proxy URL pattern: protocol://user:password@host:port
    # Supports: socks5h://, socks5://, http://, https://
    if ($proxy -match '^(socks5h?|https?):\/\/([^:]+):([^@]+)@(.+)$') {
        $protocol = $Matches[1]
        $user = $Matches[2]
        $oldPassword = $Matches[3]
        $hostPort = $Matches[4]
        
        # Build new proxy URL with new password
        $newProxy = "${protocol}://${user}:${NewPassword}@${hostPort}"
        $updatedProxies += $newProxy
        $count++
        
        Write-Host "Updated: $user@$($hostPort.Split(':')[0])" -ForegroundColor Green
    } else {
        # Keep original if doesn't match pattern
        $updatedProxies += $proxy
        Write-Warning "Skipped (no match): $proxy"
    }
}

# Write output file
$updatedProxies | Out-File -FilePath $OutputFile -Encoding UTF8

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Updated $count proxies" -ForegroundColor Cyan
Write-Host "  Output: $OutputFile" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
