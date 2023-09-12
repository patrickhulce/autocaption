import re
import os
import requests

DATA_DIRECTORY = os.path.join(os.path.dirname(
    os.path.realpath(__file__)), '../data/images')


def sanitize_filename(filename):
    filename = filename.lower()
    filename = filename.replace('https://', '')
    filename = re.sub(r'[^a-z0-9]+', '_', filename)
    return filename[:120]


def get_extension_from_url(url):
    extension = r'\.(png|jpg|jpeg|gif|webp|svg)(\?|$|#)'
    match = re.search(extension, url, re.IGNORECASE)

    if match:
        return match.group(1)
    else:
        return 'jpg'


def get_filepath_for_url(url):
    filename = sanitize_filename(url) + '.' + get_extension_from_url(url)
    return os.path.join(DATA_DIRECTORY, filename)


def ensure_directory_exists_for_file(filepath):
    directory = os.path.dirname(filepath)
    if not os.path.exists(directory):
        os.makedirs(directory)


def download(url):
    filepath = get_filepath_for_url(url)
    ensure_directory_exists_for_file(filepath)
    filename = os.path.basename(filepath)

    if os.path.exists(filepath):
        print(f"{filename} already exists.")
        return filepath

    print(f"Downloading {url}...")
    response = requests.get(url)
    if response.status_code == 200:
        with open(filepath, 'wb') as file:
            file.write(response.content)
    else:
        raise Exception(
            f'Failed to download {url} to {filename} with status code {response.status_code}')

    return filepath
