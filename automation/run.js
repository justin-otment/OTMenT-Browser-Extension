import undetected_chromedriver as uc
from selenium.webdriver.chrome.options import Options
import os

def launch_with_local_extension():
    EXTENSION_PATH = os.environ.get("EXTENSION_PATH")
    DEBUG = os.environ.get("DEBUG", "false").lower() == "true"

    if not EXTENSION_PATH:
        raise RuntimeError("EXTENSION_PATH environment variable is missing!")

    print("[OTMenT] Using local extension:", EXTENSION_PATH)
    print("[OTMenT] Debug mode:", "ON (headless=False)" if DEBUG else "OFF (headless=True)")

    options = Options()

    # Load unpacked extension folder
    if EXTENSION_PATH.endswith(".crx"):
        options.add_extension(EXTENSION_PATH)
    else:
        options.add_argument(f"--load-extension={EXTENSION_PATH}")

    # Headless mode: extensions usually require a visible browser
    if not DEBUG:
        # uc headless mode is experimental; better to keep visible
        options.add_argument("--headless=new")

    driver = uc.Chrome(options=options)

    try:
        driver.get("https://example.com")
        print("[OTMenT] Chrome launched with extension!")
        print("[OTMenT] Page title:", driver.title)

        # Optional: screenshot for CI debugging
        driver.save_screenshot("automation-screenshot.png")
        print("[OTMenT] Screenshot captured.")
    finally:
        driver.quit()
        print("[OTMenT] Browser closed.")

if __name__ == "__main__":
    try:
        launch_with_local_extension()
    except Exception as e:
        print("[OTMenT] Automation failed:", e)
        exit(1)