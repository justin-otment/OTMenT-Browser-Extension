import undetected_chromedriver as uc
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException
import os
import sys
import time

def launch_with_local_extension():
    EXTENSION_PATH = os.environ.get("EXTENSION_PATH")
    DEBUG = os.environ.get("DEBUG", "false").lower() == "true"

    if not EXTENSION_PATH:
        raise RuntimeError("EXTENSION_PATH environment variable is missing!")

    print("[OTMenT] Using local extension:", EXTENSION_PATH)
    print("[OTMenT] Debug mode:", "ON (headless=False)" if DEBUG else "OFF (headless=True)")

    options = Options()

    # Load extension: .crx packaged or unpacked folder
    if EXTENSION_PATH.endswith(".crx"):
        options.add_extension(EXTENSION_PATH)
    else:
        options.add_argument(f"--load-extension={EXTENSION_PATH}")

    # Headless mode: extensions usually require a visible browser
    if not DEBUG:
        options.add_argument("--headless=new")

    driver = None
    try:
        driver = uc.Chrome(options=options)

        target_url = "https://www.peoplesearchnow.com/address/629-west-lightwood-street_citrus-springs-fl"
        driver.get(target_url)
        print("[OTMenT] Chrome launched with extension!")
        print("[OTMenT] Initial page title:", driver.title)

        # Retry loop if Cloudflare challenge appears
        max_attempts = 5
        for attempt in range(max_attempts):
            if driver.title.strip().lower() == "just a moment...":
                print(f"[OTMenT] Cloudflare challenge detected (attempt {attempt+1}/{max_attempts}). Waiting...")
                time.sleep(10)  # wait before retry
                driver.get(target_url)
            else:
                break

        print("[OTMenT] Final page title:", driver.title)

        # Optional: screenshot for CI debugging
        screenshot_path = "automation-screenshot.png"
        driver.save_screenshot(screenshot_path)
        print(f"[OTMenT] Screenshot captured at {screenshot_path}")

    except TimeoutException as te:
        print("[OTMenT] Timeout while loading page:", te)
        sys.exit(1)
    except Exception as e:
        print("[OTMenT] Automation failed:", e)
        sys.exit(1)
    finally:
        if driver:
            driver.quit()
            print("[OTMenT] Browser closed.")

if __name__ == "__main__":
    launch_with_local_extension()