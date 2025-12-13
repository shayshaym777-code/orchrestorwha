# API Test Script
$baseUrl = "http://localhost:3000"
$apiKey = "test-key"
$headers = @{"X-API-KEY" = $apiKey}

$passed = 0
$failed = 0

function Test-Endpoint {
    param($name, $method, $url, $body = $null, $expectedStatus = 200)
    
    try {
        $params = @{
            Uri = "$baseUrl$url"
            Method = $method
            Headers = $headers
            ContentType = "application/json"
        }
        if ($body) {
            $params.Body = $body
        }
        
        $response = Invoke-WebRequest @params -UseBasicParsing
        if ($response.StatusCode -eq $expectedStatus) {
            Write-Host "[PASS] $name" -ForegroundColor Green
            $script:passed++
            return $true
        } else {
            Write-Host "[FAIL] $name - Got status $($response.StatusCode)" -ForegroundColor Red
            $script:failed++
            return $false
        }
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq $expectedStatus) {
            Write-Host "[PASS] $name (expected $expectedStatus)" -ForegroundColor Green
            $script:passed++
            return $true
        }
        Write-Host "[FAIL] $name - Error: $($_.Exception.Message)" -ForegroundColor Red
        $script:failed++
        return $false
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "       API ENDPOINT TESTS" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Health & Status
Write-Host "--- Health & Status ---" -ForegroundColor Yellow
Test-Endpoint "Health Check" "GET" "/health"

# Dashboard
Write-Host "`n--- Dashboard API ---" -ForegroundColor Yellow
Test-Endpoint "Dashboard Sessions" "GET" "/api/v1/dashboard/sessions"
Test-Endpoint "Dashboard Alerts" "GET" "/api/v1/dashboard/alerts"

# Session Management
Write-Host "`n--- Session Management ---" -ForegroundColor Yellow
Test-Endpoint "Session Provision (no docker)" "POST" "/api/sessions/provision" '{"phone":"test123"}' 500

# Static Files
Write-Host "`n--- Static Files ---" -ForegroundColor Yellow
Test-Endpoint "Main Dashboard" "GET" "/"
Test-Endpoint "Scan Page" "GET" "/scan"
Test-Endpoint "Live Log Page" "GET" "/live-log"

# API Key Protection
Write-Host "`n--- Security ---" -ForegroundColor Yellow
try {
    $noKeyResponse = Invoke-WebRequest -Uri "$baseUrl/api/v1/dashboard/sessions" -UseBasicParsing
    Write-Host "[FAIL] API Key Protection - Should require key" -ForegroundColor Red
    $failed++
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 401) {
        Write-Host "[PASS] API Key Protection" -ForegroundColor Green
        $passed++
    } else {
        Write-Host "[FAIL] API Key Protection - Wrong error" -ForegroundColor Red
        $failed++
    }
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "       TEST RESULTS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Passed: $passed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor Red
Write-Host "Total:  $($passed + $failed)" -ForegroundColor White

if ($failed -eq 0) {
    Write-Host "`n[SUCCESS] All tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n[WARNING] Some tests failed!" -ForegroundColor Yellow
    exit 1
}

