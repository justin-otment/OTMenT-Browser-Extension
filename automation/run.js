import undetected_chromedriver as uc
from selenium.webdriver.chrome.options import Options
import os
import sys

def launch_with_local_extension():
    EXTENSION_PATH = os.environ.get("EXTENSION_PATH")
    DEBUG = os.environ.get("DEBUG", "false").lower() == "true"

    if not EXTENSION_PATH:
        raise RuntimeError("EXTENSION_PATH environment variable is missing!")

    print("[OTMenT] Using local extension:", EXTENSION_PATH)
    print("[OTMenT] Debug mode:", "ON (headless=False)" if DEBUG else "OFF (headless=True)")

    options = Options()

    # Load unpacked extension folder or CRX
    if EXTENSION_PATH.endswith(".crx"):
        if os.path.exists(EXTENSION_PATH):
            options.add_extension(EXTENSION_PATH)
        else:
            raise FileNotFoundError(f"Extension file not found: {EXTENSION_PATH}")
    else:
        resolved_path = os.path.abspath(EXTENSION_PATH)
        if os.path.exists(resolved_path):
            options.add_argument(f"--load-extension={resolved_path}")
        else:
            raise FileNotFoundError(f"Extension folder not found: {resolved_path}")

    # Headless mode: extensions usually require a visible browser
    if not DEBUG:
        # uc headless mode is experimental; use new headless flag
        options.add_argument("--headless=new")
        options.add_argument("--disable-gpu")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")

    # Launch browser
    driver = uc.Chrome(options=options)

    try:
        driver.get("https://example.com")
        print("[OTMenT] Chrome launched with extension!")
        print("[OTMenT] Page title:", driver.title)

        # Optional: screenshot for CI debugging
        screenshot_path = "automation-screenshot.png"
        driver.save_screenshot(screenshot_path)
        print(f"[OTMenT] Screenshot captured at {screenshot_path}")
    finally:
        driver.quit()
        print("[OTMenT] Browser closed.")

if __name__ == "__main__":
    try:
        launch_with_local_extension()
    except Exception as e:
        print("[OTMenT] Automation failed:", e)
        sys.exit(1)
