import gspread
from google.oauth2.service_account import Credentials
import json
import os
import sys

def run_sheets_automation():
    SERVICE_ACCOUNT_FILE = "automation/secrets/service-account.json"
    CONFIG_FILE = "automation/secrets/config.json"

    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        raise RuntimeError("Service account JSON file is missing!")
    if not os.path.exists(CONFIG_FILE):
        raise RuntimeError("Config file is missing!")

    # Load config
    with open(CONFIG_FILE) as f:
        cfg = json.load(f)

    spreadsheet_id = cfg.get("spreadsheetId")
    sheet_name = cfg.get("sheetName")
    detail_sheet_name = cfg.get("detailSheetName")

    if not spreadsheet_id or not sheet_name:
        raise RuntimeError("Spreadsheet ID and sheet name must be provided in config.json")

    SCOPES = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive"
    ]

    try:
        creds = Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
        client = gspread.authorize(creds)

        # Open the spreadsheet and worksheet
        sheet = client.open_by_key(spreadsheet_id).worksheet(sheet_name)
        records = sheet.get_all_records()
        print("[OTMenT] Retrieved records from sheet:", sheet_name)
        print(records)

        # Optionally work with detail sheet
        if detail_sheet_name:
            detail_sheet = client.open_by_key(spreadsheet_id).worksheet(detail_sheet_name)
            detail_records = detail_sheet.get_all_records()
            print("[OTMenT] Retrieved records from detail sheet:", detail_sheet_name)
            print(detail_records)

    except Exception as e:
        print("[OTMenT] Sheets automation failed:", e)
        sys.exit(1)

if __name__ == "__main__":
    run_sheets_automation()
