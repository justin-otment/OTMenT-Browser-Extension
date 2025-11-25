import undetected_chromedriver as uc
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import os
import sys
import time
import subprocess

def launch_with_local_extension():
    EXTENSION_PATH = os.environ.get("EXTENSION_PATH")
    DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
    GOOGLE_USER = os.environ.get("GOOGLE_USER")
    GOOGLE_PASS = os.environ.get("GOOGLE_PASS")
    CHROME_BIN = os.environ.get("CHROME_BIN", "/usr/bin/google-chrome")

    if not EXTENSION_PATH:
        raise RuntimeError("EXTENSION_PATH environment variable is missing!")
    if not GOOGLE_USER or not GOOGLE_PASS:
        raise RuntimeError("GOOGLE_USER and GOOGLE_PASS environment variables are required!")

    print("[OTMenT] Using local extension:", EXTENSION_PATH)
    print("[OTMenT] Debug mode:", "ON (non‑headless)" if DEBUG else "OFF (still non‑headless)")
    print("[OTMenT] Chrome binary:", CHROME_BIN)

    # Log Chrome version
    try:
        version = subprocess.check_output([CHROME_BIN, "--version"]).decode().strip()
        print("[OTMenT] Chrome version:", version)
    except Exception:
        print("[OTMenT] Could not determine Chrome version")

    options = Options()

    # Load extension: .crx packaged or unpacked folder
    if EXTENSION_PATH.endswith(".crx"):
        options.add_extension(EXTENSION_PATH)
    else:
        options.add_argument(f"--load-extension={EXTENSION_PATH}")

    # Force non‑headless mode always
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-software-rasterizer")
    options.add_argument("--disable-setuid-sandbox")

    driver = None
    screenshot_path = "automation-screenshot.png"

    try:
        # Explicitly point to Chrome binary installed in CI
        driver = uc.Chrome(
            options=options,
            browser_executable_path=CHROME_BIN
        )

        # Navigate to Google login
        driver.get("https://accounts.google.com/")
        print("[OTMenT] Navigated to Google Sign‑In")

        wait = WebDriverWait(driver, 40)  # longer timeout

        # Enter email
        email_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, 'input[type="email"]')))
        email_input.send_keys(GOOGLE_USER)
        driver.find_element(By.ID, "identifierNext").click()
        print("[OTMenT] Entered email")

        # Enter password
        password_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, 'input[type="password"]')))
        password_input.send_keys(GOOGLE_PASS)
        driver.find_element(By.ID, "passwordNext").click()
        print("[OTMenT] Entered password")

        # Wait for login to complete or detect 2FA
        try:
            wait.until(EC.title_contains("Google"))
            print("[OTMenT] Logged into Google account successfully")
        except TimeoutException:
            print("[OTMenT] Login may require additional verification (2FA or recovery).")

        # Optional: navigate to target URL after login
        target_url = "https://www.peoplesearchnow.com/address/629-west-lightwood-street_citrus-springs-fl"
        driver.get(target_url)
        print("[OTMenT] Navigated to target URL")
        print("[OTMenT] Page title:", driver.title)

        driver.save_screenshot(screenshot_path)
        print(f"[OTMenT] Screenshot captured at {screenshot_path}")

        # Keep browser open for inspection if DEBUG=true (skip in CI)
        if DEBUG and os.environ.get("CI") != "true":
            print("[OTMenT] Debug mode active — keeping browser open for manual inspection.")
            time.sleep(60)

    except TimeoutException as te:
        print("[OTMenT] Timeout while loading page:", te)
        try:
            if driver:
                driver.save_screenshot(screenshot_path)
                print(f"[OTMenT] Timeout screenshot captured at {screenshot_path}")
        except Exception:
            print("[OTMenT] Could not capture screenshot on timeout.")
        sys.exit(1)
    except Exception as e:
        print("[OTMenT] Automation failed:", e)
        try:
            if driver:
                driver.save_screenshot(screenshot_path)
                print(f"[OTMenT] Error screenshot captured at {screenshot_path}")
        except Exception:
            print("[OTMenT] Could not capture screenshot on error.")
        sys.exit(1)
    finally:
        try:
            if driver:
                driver.save_screenshot(screenshot_path)
                print(f"[OTMenT] Final screenshot captured at {screenshot_path}")
        except Exception:
            print("[OTMenT] Could not capture final screenshot.")
        if driver:
            driver.quit()
            print("[OTMenT] Browser closed.")

if __name__ == "__main__":
    launch_with_local_extension()
