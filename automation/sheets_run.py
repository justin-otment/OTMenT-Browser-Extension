import gspread
from google.oauth2.service_account import Credentials
import json
import sys
import os

SERVICE_ACCOUNT_FILE = "automation/secrets/service-account.json"
CONFIG_FILE = "automation/secrets/config.json"

def main():
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        print("[OTMenT] Service account JSON missing")
        sys.exit(1)
    if not os.path.exists(CONFIG_FILE):
        print("[OTMenT] Config file missing")
        sys.exit(1)

    with open(CONFIG_FILE) as f:
        cfg = json.load(f)

    spreadsheet_id = cfg.get("spreadsheetId")
    sheet_name = cfg.get("sheetName")
    detail_sheet_name = cfg.get("detailSheetName")

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
    main()
