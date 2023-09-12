import csv

from common.csv import read_rows
from common.images import download


def main():
    for row in read_rows():
        try:
            download(row['url'])
        except:
            print(f"Failed to process {row['url']}")


if __name__ == "__main__":
    main()
