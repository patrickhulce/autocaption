import csv
import re
import sys

from urllib.parse import urlparse

DEFAULT_CSV_FILE_PATH = "./examples/test.csv"


def get_csv_file_path():
    if len(sys.argv) > 1:
        return sys.argv[1]

    return DEFAULT_CSV_FILE_PATH


def clean_url(url):
    if url.startswith('//'):
        url = 'https:' + url

    url = url.strip()
    url = re.sub(r'["’”\']+( .*)?$', '', url)
    url = url.replace('[/img]', '')
    url = url.replace('[/url]', '')
    return url.strip().replace('[/img]', '').replace('[/url]', '')


def read_rows():
    csv_file_path = get_csv_file_path()
    rows = []

    with open(csv_file_path, newline='') as csvfile:
        reader = csv.DictReader(csvfile, delimiter=',', quotechar='"')
        for row in reader:
            transformed_row = {header.lower(): value for header,
                               value in row.items()}
            try:
                transformed_row['url'] = clean_url(transformed_row['url'])
                transformed_row['url_parsed'] = urlparse(
                    transformed_row['url'])

                if 'width' in transformed_row and isinstance(transformed_row['width'], str) and len(transformed_row['width']) > 0:
                    transformed_row['width'] = float(transformed_row['width'])
                if 'height' in transformed_row and isinstance(transformed_row['height'], str) and len(transformed_row['height']) > 0:
                    transformed_row['height'] = float(
                        transformed_row['height'])

                rows.append(transformed_row)
            except Exception as err:
                transformed_row['failed'] = True
                transformed_row['error'] = err
                rows.append(transformed_row)

    return rows
