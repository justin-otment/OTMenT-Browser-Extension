#!/usr/bin/env python3
"""
csvOrganizer.py

Process a lead-list CSV with columns:
  Site, First Name, Last Name,
  Phone 1…5 + Phone Type 1…5,
  Email 1…3

Outputs one row per phone or email, preserving Site & Owner names.
"""

import csv
import re
import sys
import os
import argparse

# -------------------------------------------------------------------
# Use these exact defaults for your environment
DEFAULT_INPUT  = r"C:\Users\DELL\Documents\Onyot.ai\Lead_List-Generator\python tests\externals\Cape-Sep-2-2025.csv"
DEFAULT_OUTPUT = r"C:\Users\DELL\Documents\Onyot.ai\Lead_List-Generator\python tests\externals\Cape-Sep-2-2025-processed.csv"
# -------------------------------------------------------------------

def clean_email(html_email: str) -> str:
    """Strip HTML tags from an email string."""
    return re.sub(r'<.*?>', '', (html_email or '').strip())

def process_data(input_path: str, output_path: str):
    """Read input_path, transform rows, and write to output_path."""
    with open(input_path, mode='r', encoding='utf-8', newline='') as src:
        reader = csv.DictReader(src)
        rows = list(reader)

    fieldnames = ['Site','First Name','Last Name','Phone Number','Phone Type','Email']
    with open(output_path, mode='w', encoding='utf-8', newline='') as dst:
        writer = csv.DictWriter(dst, fieldnames=fieldnames)
        writer.writeheader()

        for row in rows:
            site       = row.get('Site', '').strip()
            first_name = row.get('First Name', '').strip()
            last_name  = row.get('Last Name', '').strip()

            # Gather phone entries
            phone_entries = []
            for i in range(1, 6):
                num_key  = f'Phone {i}'
                type_key = f'Phone Type {i}'
                num  = row.get(num_key, '').strip()
                ptype = row.get(type_key, '').strip()
                if num:
                    phone_entries.append((num, ptype))

            # Gather cleaned emails
            emails = []
            for i in range(1, 4):
                raw = row.get(f'Email {i}', '').strip()
                if raw:
                    emails.append(clean_email(raw))

            # Determine how many output rows
            max_items = max(len(phone_entries), len(emails), 1)

            for idx in range(max_items):
                phone_num, phone_type = ('', '')
                if idx < len(phone_entries):
                    phone_num, phone_type = phone_entries[idx]

                email_addr = ''
                if idx < len(emails):
                    email_addr = emails[idx]

                writer.writerow({
                    'Site':         site,
                    'First Name':   first_name,
                    'Last Name':    last_name,
                    'Phone Number': phone_num,
                    'Phone Type':   phone_type,
                    'Email':        email_addr
                })

def main():
    parser = argparse.ArgumentParser(
        description="Clean & reorganize your lead-list CSV."
    )
    parser.add_argument(
        'input_file',
        nargs='?',
        default=DEFAULT_INPUT,
        help='Source CSV (default: %(default)s)'
    )
    parser.add_argument(
        'output_file',
        nargs='?',
        default=DEFAULT_OUTPUT,
        help='Processed CSV (default: %(default)s)'
    )
    args = parser.parse_args()

    if not os.path.isfile(args.input_file):
        sys.stderr.write(f"Error: Input file not found: {args.input_file}\n")
        sys.exit(1)

    try:
        process_data(args.input_file, args.output_file)
        print(f"✅ Processed data saved to {args.output_file}")
    except Exception as e:
        sys.stderr.write(f"❌ Processing failed: {e}\n")
        sys.exit(2)

if __name__ == '__main__':
    main()