#Requires AutoHotkey v2
#SingleInstance Force
SetTitleMatchMode 2
SetControlDelay -1
SetMouseDelay -1
SetWinDelay -1
SetKeyDelay -1
SetWorkingDir A_ScriptDir
Persistent

; ============================================
; === Paths and Constants ===
; ============================================
vpnPath         := "C:\Users\Administrator\Desktop\OTMenT\VPN"
authFile        := vpnPath "\auth.txt"
ovpnGuiExe      := "C:\Program Files\OpenVPN\bin\openvpn-gui.exe"
chromePath      := "C:\Program Files\Google\Chrome\Application\chrome.exe"
url             := "https://www.fastpeoplesearch.com/address/123-main-street_98001"
extensionId     := "gaphhobpkalbamfioeeggcjkejannpmj"

; === Settings ===
retryLimit      := 3
vpnConnectDelay := 8000
chromeLoadDelay := 6000
lastConfig      := ""
lastPublicIP    := ""

; === Tray Setup ===
TraySetIcon("shell32.dll", 44)
TrayTip("Automation", "Script Started", 3)

; ============================================
; Ensure auth-user-pass directive exists
; ============================================
EnsureAuthDirective(filePath, authFile) {
    txt := FileRead(filePath, "UTF-8")
    if !RegExMatch(txt, "i)auth-user-pass")
        FileAppend("`nauth-user-pass " authFile "`n", filePath, "UTF-8")
}

; ============================================
; Get current public IP
; ============================================
GetPublicIP() {
    try {
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("GET", "https://api.ipify.org", false)
        http.Send()
        return Trim(http.ResponseText)
    } catch {
        return ""
    }
}

; ============================================
; Check if VPN is connected
; ============================================
CheckVPNConnection(configName) {
    global ovpnGuiExe
    cmd := '"' ovpnGuiExe '" --command status "' configName '"'
    try {
        RunWait(cmd, , "Hide")
    } catch {
        return false
    }
    title := WinGetTitle("ahk_exe openvpn-gui.exe")
    return (InStr(title, configName) > 0)
}

; ============================================
; Connect VPN with random UDP config
; ============================================
ConnectVPN() {
    global vpnPath, ovpnGuiExe, authFile, lastConfig, vpnConnectDelay, retryLimit, lastPublicIP
    configs := []
    Loop Files, vpnPath "\*.ovpn"
        if InStr(A_LoopFileName, "udp")
            configs.Push(A_LoopFileName)
    if (configs.Length = 0) {
        MsgBox("No UDP .ovpn configs found in: " vpnPath)
        ExitApp
    }

    ; Pick random config (not same as last one)
    Loop {
        idx := Random(1, configs.Length)
        chosenFile := configs[idx]
    } Until (chosenFile != lastConfig || configs.Length = 1)
    lastConfig := chosenFile

    configPath := vpnPath "\" chosenFile
    configName := RegExReplace(chosenFile, "\.ovpn$", "")
    EnsureAuthDirective(configPath, authFile)

    ; Disconnect old VPN
    Run('*RunAs "' ovpnGuiExe '" --command disconnect_all', , "Hide")
    Sleep(2500)

    attempt := 0
    while attempt < retryLimit {
        attempt++
        Run('*RunAs "' ovpnGuiExe '" --command connect "' configName '"', , "Hide")
        Sleep(vpnConnectDelay + attempt * 2000)
        if CheckVPNConnection(configName) {
            newIP := GetPublicIP()
            if (newIP != "" && newIP != lastPublicIP) {
                lastPublicIP := newIP
                TrayTip("VPN", "Connected: " configName "`nNew IP: " newIP, 5)
                return configName
            }
        }
    }
    TrayTip("VPN Error", "Failed to confirm VPN connection after " retryLimit " attempts!", 5)
    return ""
}

; ============================================
; Clear Chrome browsing data (AutoHotkey v2)
; ============================================
#Warn LocalSameAsGlobal, Off  ; stop false "WinGet never assigned" warnings

ClearBrowserData() {
    global chromePath

    ; --------------------
    ; Gather chrome windows
    ; --------------------
    winList := WinGetList("ahk_exe chrome.exe")
    if (winList.Length = 0) {
        TrayTip("Chrome", "⚠ Chrome is not running.", 3)
    } else {
        ids := []
        for hwnd in winList
            ids.Push(hwnd)

        ; Close each Chrome window gracefully
        for hwnd in ids {
            h := "ahk_id " hwnd
            if !WinExist(h)
                continue

            WinClose(h)
            Sleep(700)

            if WinExist(h) {
                WinActivate(h)
                if WinWaitActive(h, , 2)
                    Send("!{F4}")
                Sleep(700)
            }

            if WinExist(h) {
                PostMessage(0x0010, 0, 0, , h) ; WM_CLOSE
                Sleep(700)
            }

            Sleep(150)
        }
        Sleep(800)
        TrayTip("Chrome", "Closed all Chrome windows (graceful).", 2)
    }

    ; ---------------------------------------
    ; Clear browsing data (Ctrl+Shift+Del)
    ; ---------------------------------------
    Send("^+{Del}")
    Sleep(2000)

    ControlClick("x871 y537", "ahk_exe chrome.exe", , "Left", 1, "NA")
    Sleep(2000)

    Send("^w") ; close leftover tab/dialog
    Sleep(2000)

    return true
}

; ============================================
; Perform automated browser actions
; ============================================
DoBrowserAutomation() {
    global chromePath, url, chromeLoadDelay

    ; --- Open Chrome / New Tab ---
    if WinExist("ahk_exe chrome.exe") {
        WinActivate("ahk_exe chrome.exe")
        WinWaitActive("ahk_exe chrome.exe", , 5)
        Sleep(500)
    } else {
        Run('"' chromePath '" --remote-debugging-port=9222 --new-window')
        WinWait("ahk_exe chrome.exe", , 10)
        WinActivate("ahk_exe chrome.exe")
        Sleep(500)
    }

    ; --- Clear browser data immediately ---
    ClearBrowserData()
    Sleep(500)

    ; --- Navigate to target URL ---
    Send("^t")
    Sleep(400)
    Send(url "{Enter}")

    Sleep(1500)
    
    ; --- Reload current page twice ---
    Loop 3 {
        Send("{F6}")
        Sleep(300)
        Send("{Enter}")
        Sleep(1000)
    }
    Sleep(chromeLoadDelay)
    WinMaximize("ahk_exe chrome.exe")
    Sleep(13000)

    ; --- Example virtual clicks ---
    ControlClick("x0 y303", "ahk_exe chrome.exe", , "Left", 1, "NA")
    Sleep(2000)

    ControlClick("x562 y303", "ahk_exe chrome.exe", , "Left", 1, "NA")
    Sleep(3000)

    Send("^w")   ; Close the current tab
    Sleep(1500)

    RefreshAllChromeTabs()
}

; ============================================
; Refresh all Chrome tabs (via extension)
; ============================================
RefreshAllChromeTabs() {
    if !WinExist("ahk_exe chrome.exe") {
        TrayTip("Chrome", "⚠ Chrome is not running.", 3)
        return false
    }
    WinActivate("ahk_exe chrome.exe")
    WinWaitActive("ahk_exe chrome.exe", , 5)
    Sleep(300)
    Send("^+r")  ; Reload all tabs
    Sleep(3000)
    Send("^1")   ; Go to first tab
    Sleep(1200)
    ControlClick("x346 y167", "ahk_exe chrome.exe", , "Left", 1, "NA")
    return true
}

; ============================================
; === Main Execution: Loop every 3 minutes ===
; ============================================
Loop {
    configName := ConnectVPN()
    if (configName != "")
        DoBrowserAutomation()

    Sleep(200000)  ; 2 minutes (120,000 ms)
}
