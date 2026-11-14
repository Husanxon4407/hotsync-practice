"""
HotSync: config.py

All folder paths in ONE place. Every other script imports from here,
so if the data moves to another drive, we change only this file.

The big data lives OUTSIDE the repo (on drive D:), because it is too big
for GitHub. Only small, processed files go into the repo (web/data/).
"""

from pathlib import Path

# Folder of this repo (where this file is).
REPO_DIR = Path(__file__).parent

# Big data on drive D: (never committed to git).
DATA_ROOT = Path(r"D:\hotsync_data")
DATA_DIR = DATA_ROOT / "data_raw"        # downloaded FIRMS zips, 2000-2025
DATA_2026_DIR = DATA_DIR / "2026"        # optional 2026 world CSV files
WORK_DIR = DATA_ROOT / "data_work"       # in-between files (parquet, etc.)
CHECKS_DIR = DATA_ROOT / "checks"        # check images (PNG) to look at

# Small files the website reads (these ARE committed to git).
WEB_DATA_DIR = REPO_DIR / "web" / "data"


def make_folders():
    """Create every data folder if it doesn't exist yet."""
    for folder in (DATA_DIR, DATA_2026_DIR, WORK_DIR, CHECKS_DIR):
        folder.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    # "python config.py" creates the folders and shows where they are.
    make_folders()
    for name in ("DATA_DIR", "DATA_2026_DIR", "WORK_DIR", "CHECKS_DIR",
                 "WEB_DATA_DIR"):
        path = globals()[name]
        print(f"{name:14s} {path}  (exists: {path.exists()})")
