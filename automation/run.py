import gspread
from google.oauth2.service_account import Credentials
import json
import os
import sys

SERVICE_ACCOUNT_FILE = "automation/secrets/service-account.json"
CONFIG_FILE = "automation/secrets/config.json"

def run_sheets_automation():
    # Verify files exist
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        print("[OTMenT] Service account JSON missing")
        sys.exit(1)
    if not os.path.exists(CONFIG_FILE):
        print("[OTMenT] Config file missing")
        sys.exit(1)

    # Load config
    with open(CONFIG_FILE) as f:
        cfg = json.load(f)

    spreadsheet_id = cfg.get("spreadsheetId")
    sheet_name = cfg.get("sheetName")
    detail_sheet_name = cfg.get("detailSheetName")

    if not spreadsheet_id or not sheet_name:
        print("[OTMenT] Missing spreadsheetId or sheetName in config.json")
        sys.exit(1)

    # Define scopes
    SCOPES = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]

    try:
        # Authenticate with service account
        creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
        client = gspread.authorize(creds)

        # Open main sheet
        sheet = client.open_by_key(spreadsheet_id).worksheet(sheet_name)
        records = sheet.get_all_records()
        print(f"[OTMenT] Retrieved {len(records)} rows from sheet '{sheet_name}'")

        # Optionally open detail sheet
        if detail_sheet_name:
            detail_sheet = client.open_by_key(spreadsheet_id).worksheet(detail_sheet_name)
            detail_records = detail_sheet.get_all_records()
            print(f"[OTMenT] Retrieved {len(detail_records)} rows from detail sheet '{detail_sheet_name}'")

        # Example: write a diagnostic value back
        sheet.update_cell(1, 1, "Automation ran successfully")
        print("[OTMenT] Wrote diagnostic marker to cell A1")

    except Exception as e:
        print("[OTMenT] Sheets automation failed:", e)
        sys.exit(1)

if __name__ == "__main__":
    run_sheets_automation()
