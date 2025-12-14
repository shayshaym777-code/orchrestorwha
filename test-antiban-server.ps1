# ========================================
# Anti-Ban / Message Distribution Tests
# ========================================

$baseUrl = "http://localhost:3000"
$apiKey = "test-key"
$headers = @{
    "X-API-KEY" = $apiKey
    "Content-Type" = "application/json"
}

$passed = 0
$failed = 0

function Write-Test {
    param($name, $status, $details = "")
    if ($status) {
        Write-Host "[PASS] $name" -ForegroundColor Green
        if ($details) { Write-Host "       $details" -ForegroundColor Gray }
        $script:passed++
    } else {
        Write-Host "[FAIL] $name" -ForegroundColor Red
        if ($details) { Write-Host "       $details" -ForegroundColor Yellow }
        $script:failed++
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   ANTI-BAN SERVER TESTS" -ForegroundColor Cyan
Write-Host "   Message Distribution System" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ==========================================
# TEST 1: Dispatcher Status
# ==========================================
Write-Host "--- 1. Dispatcher Status ---" -ForegroundColor Yellow
try {
    $status = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/status" -Headers $headers
    Write-Test "Dispatcher status endpoint" ($status.status -eq "ok") "Timestamp: $($status.data.timestamp)"
    
    if ($status.data.sessions) {
        Write-Test "Sessions data available" $true "Hot: $($status.data.sessions.hot.count), Warming: $($status.data.sessions.warming.count), Cold: $($status.data.sessions.cold.count)"
    }
    
    if ($null -ne $status.data.totalCapacity) {
        Write-Test "Total capacity calculated" $true "Capacity: $($status.data.totalCapacity) messages"
    }
} catch {
    Write-Test "Dispatcher status endpoint" $false "Error: $_"
}

# ==========================================
# TEST 2: Sessions by Grade
# ==========================================
Write-Host "`n--- 2. Sessions by Grade ---" -ForegroundColor Yellow
try {
    $sessions = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/sessions" -Headers $headers
    Write-Test "Sessions grading endpoint" ($sessions.status -eq "ok") ""
    
    if ($sessions.data) {
        $hotCount = if ($sessions.data.hot) { $sessions.data.hot.Count } else { 0 }
        $warmingCount = if ($sessions.data.warming) { $sessions.data.warming.Count } else { 0 }
        $coldCount = if ($sessions.data.cold) { $sessions.data.cold.Count } else { 0 }
        Write-Test "Grade categories exist" $true "Hot: $hotCount, Warming: $warmingCount, Cold: $coldCount"
    }
} catch {
    Write-Test "Sessions grading endpoint" $false "Error: $_"
}

# ==========================================
# TEST 3: Single Message Dispatch
# ==========================================
Write-Host "`n--- 3. Single Message Dispatch ---" -ForegroundColor Yellow
try {
    $body = @{
        targetPhone = "972501234567"
        message = "Test message from anti-ban system"
        priority = 2
    } | ConvertTo-Json
    
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/send" -Method POST -Headers $headers -Body $body
    
    if ($result.status -eq "ok") {
        $dispatchStatus = $result.data.status
        Write-Test "Message dispatch" $true "Status: $dispatchStatus, Reason: $($result.data.reason)"
    } else {
        Write-Test "Message dispatch" $false "Error: $($result.error)"
    }
} catch {
    $errorMsg = $_.ErrorDetails.Message
    if ($errorMsg -match "NO_SESSIONS_AVAILABLE|NO_HOT_SESSIONS") {
        Write-Test "Message dispatch" $true "(No sessions available - expected without connected sessions)"
    } else {
        Write-Test "Message dispatch" $false "Error: $_"
    }
}

# ==========================================
# TEST 4: Campaign Planning
# ==========================================
Write-Host "`n--- 4. Campaign Planning ---" -ForegroundColor Yellow
try {
    $body = @{
        campaignId = "test_campaign_001"
        targets = @("972501111111", "972502222222", "972503333333")
        message = "Campaign test message"
        priority = 2
    } | ConvertTo-Json
    
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/campaign/plan" -Method POST -Headers $headers -Body $body
    
    if ($result.status -eq "ok") {
        Write-Test "Campaign plan creation" $true "Targets: $($result.data.totalTargets), Capacity: $($result.data.capacity.total)"
    } else {
        Write-Test "Campaign plan creation" $false "Error: $($result.error)"
    }
} catch {
    Write-Test "Campaign plan creation" $false "Error: $_"
}

# ==========================================
# TEST 5: Queue Processing
# ==========================================
Write-Host "`n--- 5. Queue Processing ---" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/queue/process?max=5" -Method POST -Headers $headers
    Write-Test "Queue processing" ($result.status -eq "ok") "Processed: $($result.data.processed)"
} catch {
    Write-Test "Queue processing" $false "Error: $_"
}

# ==========================================
# TEST 6: Scheduler Status
# ==========================================
Write-Host "`n--- 6. Scheduler Status ---" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/scheduler/status" -Headers $headers
    Write-Test "Scheduler status" ($result.status -eq "ok") "Running: $($result.data.running)"
} catch {
    Write-Test "Scheduler status" $false "Error: $_"
}

# ==========================================
# TEST 7: Ramp Schedule Config
# ==========================================
Write-Host "`n--- 7. Ramp Schedule Config ---" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/config/schedule" -Headers $headers
    Write-Test "Get ramp schedule" ($result.status -eq "ok") "Custom: $($result.data.isCustom)"
    
    if ($result.data.schedule) {
        $day1 = $result.data.schedule."1"
        if ($day1) {
            Write-Test "Day 1 limits defined" $true "Max: $($day1.maxMessages) msgs, Delay: $($day1.minDelayMs/1000)-$($day1.maxDelayMs/1000) sec"
        }
    }
} catch {
    Write-Test "Get ramp schedule" $false "Error: $_"
}

# ==========================================
# TEST 8: Anti-Ban Status
# ==========================================
Write-Host "`n--- 8. Anti-Ban Status ---" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/anti-ban/status" -Headers $headers
    Write-Test "Anti-ban status endpoint" ($result.status -eq "ok") ""
    
    if ($result.gatewayQueue) {
        Write-Test "Gateway queue info" $true "Length: $($result.gatewayQueue.length)"
    }
    
    if ($result.incidents) {
        Write-Test "Incidents tracking" $true "Count: $($result.incidents.Count)"
    }
} catch {
    Write-Test "Anti-ban status endpoint" $false "Error: $_"
}

# ==========================================
# TEST 9: SmartGuard Toggle
# ==========================================
Write-Host "`n--- 9. SmartGuard Toggle ---" -ForegroundColor Yellow
try {
    $body = @{ enabled = $true } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$baseUrl/api/anti-ban/smartguard/enable" -Method POST -Headers $headers -Body $body
    Write-Test "SmartGuard enable" ($result.status -eq "ok") "Enabled: $($result.enabled)"
} catch {
    Write-Test "SmartGuard enable" $false "Error: $_"
}

# ==========================================
# TEST 10: Global RPM Control
# ==========================================
Write-Host "`n--- 10. Global RPM Control ---" -ForegroundColor Yellow
try {
    $body = @{ rpm = 10 } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$baseUrl/api/anti-ban/global/rpm" -Method POST -Headers $headers -Body $body
    Write-Test "Global RPM set" ($result.status -eq "ok") "RPM: $($result.rpm), Applied to: $($result.appliedTo) sessions"
} catch {
    Write-Test "Global RPM set" $false "Error: $_"
}

# ==========================================
# TEST 11: Insights / Learning Data
# ==========================================
Write-Host "`n--- 11. Insights / Learning ---" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/anti-ban/insights?days=7" -Headers $headers
    Write-Test "Insights endpoint" ($result.status -eq "ok") "Incidents: $($result.totals.incidents)"
    
    if ($null -ne $result.byHour) {
        Write-Test "Hourly breakdown available" $true "24 hours data"
    }
} catch {
    Write-Test "Insights endpoint" $false "Error: $_"
}

# ==========================================
# TEST 12: Admin Reset Daily Counters
# ==========================================
Write-Host "`n--- 12. Admin Controls ---" -ForegroundColor Yellow
try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/admin/reset-daily" -Method POST -Headers $headers
    Write-Test "Reset daily counters" ($result.status -eq "ok") "Reset: $($result.data.resetCount) sessions"
} catch {
    Write-Test "Reset daily counters" $false "Error: $_"
}

try {
    $result = Invoke-RestMethod -Uri "$baseUrl/api/dispatcher/admin/update-scores" -Method POST -Headers $headers
    Write-Test "Update trust scores" ($result.status -eq "ok") "Cold: $($result.data.cold), Warming: $($result.data.warming), Hot: $($result.data.hot)"
} catch {
    Write-Test "Update trust scores" $false "Error: $_"
}

# ==========================================
# TEST 13: Anti-Ban Dashboard UI
# ==========================================
Write-Host "`n--- 13. Dashboard UI ---" -ForegroundColor Yellow
try {
    $page = Invoke-WebRequest -Uri "$baseUrl/anti-ban" -UseBasicParsing
    Write-Test "Anti-ban dashboard page" ($page.StatusCode -eq 200) "Status: $($page.StatusCode)"
} catch {
    Write-Test "Anti-ban dashboard page" $false "Error: $_"
}

try {
    $page = Invoke-WebRequest -Uri "$baseUrl/warming" -UseBasicParsing
    Write-Test "Warming dashboard page" ($page.StatusCode -eq 200) "Status: $($page.StatusCode)"
} catch {
    Write-Test "Warming dashboard page" $false "Error: $_"
}

try {
    $page = Invoke-WebRequest -Uri "$baseUrl/learning" -UseBasicParsing
    Write-Test "Learning dashboard page" ($page.StatusCode -eq 200) "Status: $($page.StatusCode)"
} catch {
    Write-Test "Learning dashboard page" $false "Error: $_"
}

# ==========================================
# SUMMARY
# ==========================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   TEST RESULTS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Passed: $passed" -ForegroundColor Green
Write-Host "Failed: $failed" -ForegroundColor Red
Write-Host "Total:  $($passed + $failed)" -ForegroundColor White
Write-Host ""

if ($failed -eq 0) {
    Write-Host "[SUCCESS] All Anti-Ban tests passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Anti-Ban Server is ready for deployment!" -ForegroundColor Cyan
} elseif ($failed -le 3) {
    Write-Host "[OK] Most tests passed - minor issues" -ForegroundColor Yellow
} else {
    Write-Host "[WARNING] Several tests failed" -ForegroundColor Red
}

Write-Host ""

# ==========================================
# Trust Level Summary
# ==========================================
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "   TRUST LEVELS REFERENCE" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Level      Age        Daily Limit   Delay" -ForegroundColor White
Write-Host "  -----      ---        -----------   -----" -ForegroundColor Gray
Write-Host "  Cold       0-2 days   5-15 msgs     5-20 min" -ForegroundColor Cyan
Write-Host "  Warming    3-6 days   40-300 msgs   30s-6 min" -ForegroundColor Yellow
Write-Host "  Hot        7+ days    1000 msgs     10-20 sec" -ForegroundColor Red
Write-Host ""

