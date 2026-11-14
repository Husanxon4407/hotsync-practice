"""
HotSync: download_firms.py

Downloads the NASA FIRMS yearly "all countries" fire archives:
    - MODIS        2000 -> 2025  (26 zip files)
    - VIIRS S-NPP  2012 -> 2025  (14 zip files)

No login is needed. The files are big (about 7 GB in total), so the script:
    - checks that drive D: has enough free space before it starts,
    - skips files that are already fully downloaded,
    - downloads into "<name>.part" and renames it only when it is complete,
      so a half-downloaded file never looks like a finished one,
    - continues a broken download from where it stopped (resume).

Run it from the hotsync-practice folder:
    python download_firms.py
"""

import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import config

# ---------------------------------------------------------------------------
# CONFIG: the folder comes from config.py, shared by every script.
# ---------------------------------------------------------------------------
DATA_DIR = str(config.DATA_DIR)          # D:\hotsync_data\data_raw

BASE_URL = "https://firms.modaps.eosdis.nasa.gov/data/country/zips/"
MODIS_YEARS = range(2000, 2026)   # range() stops BEFORE 2026 -> 2000..2025
VIIRS_YEARS = range(2012, 2026)   # 2012..2025
MIN_FREE_GB = 8                   # stop if D: has less than this free
RETRIES = 5                       # how many times to retry a broken download
CHUNK = 1024 * 1024               # read 1 MB at a time


def file_list():
    """All the zip names we want, MODIS first, then VIIRS."""
    names = [f"modis_{y}_all_countries.zip" for y in MODIS_YEARS]
    names += [f"viirs-snpp_{y}_all_countries.zip" for y in VIIRS_YEARS]
    return names


def check_free_space(folder):
    """Stop the script if the drive has less than MIN_FREE_GB free."""
    drive = Path(folder).anchor          # "D:\" from "D:\hotsync_data\..."
    free_gb = shutil.disk_usage(drive).free / 1e9
    print(f"Free space on {drive}: {free_gb:.1f} GB (need {MIN_FREE_GB} GB)")
    if free_gb < MIN_FREE_GB:
        print(f"WARNING: not enough free space on {drive}. Stopping.")
        sys.exit(1)


def remote_size(url):
    """Ask the server how big the file is (HEAD = headers only, no data)."""
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return int(resp.headers["Content-Length"])


def download(name, folder):
    """Download one file. Returns 'skipped', 'done' or 'failed'."""
    url = BASE_URL + name
    final = Path(folder) / name
    part = final.with_name(name + ".part")

    for attempt in range(1, RETRIES + 1):
        try:
            total = remote_size(url)

            # Already finished earlier, and the size matches -> nothing to do.
            if final.exists() and final.stat().st_size == total:
                return "skipped"

            # Resume: if a .part file exists, ask only for the missing bytes.
            have = part.stat().st_size if part.exists() else 0
            if have > total:          # strange leftover -> start again
                part.unlink()
                have = 0
            req = urllib.request.Request(url)
            if have:
                req.add_header("Range", f"bytes={have}-")

            with urllib.request.urlopen(req, timeout=120) as resp, \
                    open(part, "ab" if have else "wb") as f:
                # 206 = "here is the part you asked for". If the server sends
                # the whole file (200) instead, we must start from zero.
                if have and resp.status != 206:
                    f.seek(0)
                    f.truncate()
                    have = 0
                done = have
                last_print = 0
                while chunk := resp.read(CHUNK):
                    f.write(chunk)
                    done += len(chunk)
                    if time.time() - last_print > 5:   # progress every 5 s
                        print(f"    {done / 1e6:8.1f} / {total / 1e6:.1f} MB"
                              f" ({done / total:.0%})", flush=True)
                        last_print = time.time()

            if part.stat().st_size != total:
                raise IOError(f"size {part.stat().st_size} != {total}")
            part.replace(final)       # complete -> give it the real name
            return "done"

        except (urllib.error.URLError, OSError, ValueError) as e:
            print(f"    attempt {attempt}/{RETRIES} failed: {e}", flush=True)
            time.sleep(5 * attempt)   # wait a bit longer each time
    return "failed"


def main():
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
    check_free_space(DATA_DIR)

    names = file_list()
    print(f"Saving {len(names)} files into {DATA_DIR}\n")
    results = {}
    start = time.time()
    for i, name in enumerate(names, 1):
        print(f"[{i}/{len(names)}] {name}", flush=True)
        results[name] = download(name, DATA_DIR)
        print(f"    -> {results[name]}", flush=True)

    # Short report at the end.
    print(f"\nFinished in {(time.time() - start) / 60:.1f} min")
    for status in ("done", "skipped", "failed"):
        n = [k for k, v in results.items() if v == status]
        print(f"  {status}: {len(n)}")
        if status == "failed":
            for k in n:
                print(f"    {k}")
    size = sum(p.stat().st_size for p in Path(DATA_DIR).glob("*.zip"))
    print(f"Total size of zips in folder: {size / 1e9:.2f} GB")
    sys.exit(1 if any(v == "failed" for v in results.values()) else 0)


if __name__ == "__main__":
    main()
