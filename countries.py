"""
HotSync: countries.py

Two jobs:
  1. build_geojson(): make data/countries.geojson ONCE from Natural Earth
     (free world map, 1:50m). Every country shape gets a "firms" name that
     matches the FIRMS zip file names (e.g. "United_Kingdom").
  2. assign_country(df): for points WITHOUT a country (2026 world files,
     API data in Stage 6), find which country each point is in.

Why polygons and not boxes? Country boxes overlap (e.g. Uzbekistan's box
covers parts of Kazakhstan, Tajikistan...), so a box would count one fire
in two countries. A polygon is the real border, so each fire goes to one.

Build the file once:
    .venv\\Scripts\\python countries.py
"""

import json
import re
import unicodedata
import urllib.request
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

import config

NE_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
          "master/geojson/ne_50m_admin_0_countries.geojson")
GEOJSON = config.REPO_DIR / "data" / "countries.geojson"

# Natural Earth name -> FIRMS name, where they don't match by themselves.
# The disputed areas follow what FIRMS does (checked in the zips: Morocco
# has points in Western Sahara, Somalia has points in Somaliland).
NAME_FIX = {
    "North Macedonia": "Macedonia_Former_Yugoslav_Republic_of",
    "Republic of the Congo": "Republic_of_Congo",
    "South Georgia and the Islands":
        "South_Georgia_and_South_Sandwich_Islands",
    "Western Sahara": "Morocco",
    "Somaliland": "Somalia",
    "Northern Cyprus": "Cyprus",
    "Macao S.A.R": "China",
    "Vatican": "Italy",
    "Monaco": "France",
    "Ashmore and Cartier Islands": "Australia",
    "Indian Ocean Territories": "Australia",
}

# Natural Earth draws some overseas areas INSIDE another country's shape,
# but FIRMS has a separate file for them. We cut them out by location:
# (FIRMS name, west, south, east, north) -> the parts inside this box.
SPLIT_PARTS = {
    "France": [("French_Guiana", -55, 2, -51, 6),
               ("Guadeloupe", -62, 15.8, -61, 16.6),
               ("Martinique", -61.3, 14.3, -60.7, 15),
               ("Mayotte", 44.9, -13.1, 45.3, -12.6),
               ("Reunion", 55, -21.5, 56, -20.8)],
    "Norway": [("Svalbard_and_Jan_Mayen", 10, 74, 35, 81),
               ("Svalbard_and_Jan_Mayen", -10, 70.5, -7, 71.5)],
}

# Points just outside every polygon (coasts are simplified at 1:50m)
# go to the nearest country if it is closer than this (degrees, ~10 km).
NEAREST_MAX = 0.1


def norm(s):
    """'Côte d'Ivoire' and 'Cote_d_Ivoire' -> 'cotedivoire' (easy to compare)."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore")
    return re.sub(r"[^a-z0-9]", "", s.decode().lower())


def firms_names():
    """All country names used in the FIRMS zips (from the file names)."""
    import zipfile
    names = set()
    for z in sorted(config.DATA_DIR.glob("*_all_countries.zip")):
        with zipfile.ZipFile(z) as f:
            names |= {re.sub(r"^.*_\d{4}_", "", Path(m).stem)
                      for m in f.namelist() if m.endswith(".csv")}
    return names


def build_geojson():
    """Download Natural Earth, give every shape its FIRMS name, save."""
    print(f"Downloading {NE_URL}")
    with urllib.request.urlopen(NE_URL, timeout=120) as r:
        ne = json.load(r)

    firms = firms_names()
    by_norm = {norm(n): n for n in firms}
    # Fields to try, best first. The first field that matches wins.
    fields = ["ADMIN", "NAME", "NAME_LONG", "GEOUNIT", "NAME_EN",
              "FORMAL_EN", "BRK_NAME", "NAME_SORT", "NAME_ALT", "NAME_CIAWF"]

    shapes = {}      # FIRMS name -> list of shapely geometries
    no_match = []
    for ft in ne["features"]:
        p = ft["properties"]
        geom = shape(ft["geometry"])
        name = NAME_FIX.get(p["ADMIN"])
        if not name:
            name = next((by_norm[norm(p[f])] for f in fields
                         if p.get(f) and norm(p[f]) in by_norm), None)
        if not name:
            no_match.append(p["ADMIN"])
            continue
        # Cut overseas parts out of France / Norway.
        parts = list(getattr(geom, "geoms", [geom]))
        for target, w, s, e, n in SPLIT_PARTS.get(p["ADMIN"], []):
            box = shapely.box(w, s, e, n)
            inside = [g for g in parts if box.contains(g.representative_point())]
            parts = [g for g in parts if g not in inside]
            shapes.setdefault(target, []).extend(inside)
        shapes.setdefault(name, []).extend(parts)

    features = []
    for name in sorted(shapes):
        geom = unary_union(shapes[name])
        # Round coordinates to 3 decimals (~100 m): smaller file, same use.
        geom = shapely.set_precision(geom, 0.001)
        features.append({"type": "Feature",
                         "properties": {"firms": name,
                                        "name": name.replace("_", " ")},
                         "geometry": mapping(geom)})

    GEOJSON.parent.mkdir(parents=True, exist_ok=True)
    with open(GEOJSON, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f,
                  separators=(",", ":"))

    print(f"Saved {len(features)} countries -> {GEOJSON} "
          f"({GEOJSON.stat().st_size / 1e6:.1f} MB)")
    print(f"Map shapes with no FIRMS file (points there get no country): "
          f"{no_match}")
    missing = sorted(firms - set(shapes))
    print(f"FIRMS names with no map shape (too small for 1:50m): {missing}")


# ---------------------------------------------------------------------------
# assign_country(df): used for world files (2026) and the Stage 6 robot.
# ---------------------------------------------------------------------------
_TREE = None


def _load():
    """Read countries.geojson once and build a fast search index (STRtree)."""
    global _TREE
    if _TREE is None:
        with open(GEOJSON, encoding="utf-8") as f:
            feats = json.load(f)["features"]
        geoms = [shape(ft["geometry"]) for ft in feats]
        names = np.array([ft["properties"]["firms"] for ft in feats])
        # STRtree = an index of boxes, so we only test the few polygons
        # near each point, not all 240.
        _TREE = (shapely.STRtree(geoms), names)
    return _TREE


def assign_country(df):
    """Add a 'country' column (FIRMS name, or None if in no country)."""
    tree, names = _load()
    pts = shapely.points(df["longitude"].to_numpy(),
                         df["latitude"].to_numpy())
    country = np.full(len(df), None, dtype=object)

    # 1) Points inside a polygon. query() gives pairs (point nr, polygon nr).
    p_idx, g_idx = tree.query(pts, predicate="within")
    country[p_idx] = names[g_idx]

    # 2) Points in no polygon (sea, simplified coast): nearest country,
    #    if it is closer than NEAREST_MAX degrees.
    rest = np.flatnonzero(country == None)  # noqa: E711 (numpy needs ==)
    if len(rest):
        r_idx, g_idx = tree.query_nearest(pts[rest], max_distance=NEAREST_MAX)
        country[rest[r_idx]] = names[g_idx]

    return df.assign(country=country)


if __name__ == "__main__":
    build_geojson()
