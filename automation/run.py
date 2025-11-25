import gspread
from google.oauth2.service_account import Credentials
import json, os, sys

SERVICE_ACCOUNT_FILE = "automation/secrets/service-account.json"
EXTENSION_PATH = os.environ.get("EXTENSION_PATH", "GitHub-Onyot")
CONFIG_FILE = os.path.join(EXTENSION_PATH, "config.json")

def run_sheets_automation():
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        print("[OTMenT] Service account JSON missing")
        sys.exit(1)
    if not os.path.exists(CONFIG_FILE):
        print(f"[OTMenT] Config file missing at {CONFIG_FILE}")
        sys.exit(1)

    with open(CONFIG_FILE) as f:
        cfg = json.load(f)

    spreadsheet_id = cfg.get("spreadsheetId")
    sheet_name = cfg.get("sheetName")
    detail_sheet_name = cfg.get("detailSheetName")

    if not spreadsheet_id or not sheet_name:
        print("[OTMenT] Missing spreadsheetId or sheetName in bundled config.json")
        sys.exit(1)

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]

    try:
        creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=scopes)
        client = gspread.authorize(creds)

        sheet = client.open_by_key(spreadsheet_id).worksheet(sheet_name)
        records = sheet.get_all_records()
        print(f"[OTMenT] Retrieved {len(records)} rows from sheet '{sheet_name}'")

        if detail_sheet_name:
            detail_sheet = client.open_by_key(spreadsheet_id).worksheet(detail_sheet_name)
            detail_records = detail_sheet.get_all_records()
            print(f"[OTMenT] Retrieved {len(detail_records)} rows from detail sheet '{detail_sheet_name}'")

    except Exception as e:
        print("[OTMenT] Sheets automation failed:", e)
        sys.exit(1)

if __name__ == "__main__":
    run_sheets_automation()
