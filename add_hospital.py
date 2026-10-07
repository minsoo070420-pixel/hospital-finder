#!/usr/bin/env python3
"""Add hospitals to insurance-data.json and reviews-data.json without hand-editing JSON.

Usage (run from the map folder):

  python3 add_hospital.py find "Johns Hopkins" --near "Baltimore, MD"
      Look up OpenStreetMap hospitals by name near a place and print the exact
      `name` tags (these are what the app uses as keys). Shows which are already
      in your data files.

  python3 add_hospital.py add "Johns Hopkins" --near "Baltimore, MD"
      Same lookup, then asks which one you mean and walks you through the
      insurance + review fields. Writes both files.

  python3 add_hospital.py add --key "exact osm name"
      Skip the lookup if you already know the exact OSM name tag.

  python3 add_hospital.py check
      Validate both files (matching keys, required fields, known specialties).

Only the two JSON files in this folder are ever modified. Nothing is pushed.
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
INSURANCE_FILE = os.path.join(HERE, "insurance-data.json")
REVIEWS_FILE = os.path.join(HERE, "reviews-data.json")

USER_AGENT = "hospital-finder-add-script/1.0 (https://github.com/minsoo070420-pixel/hospital-finder)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
DEFAULT_SPECIALTY = "General / Acute Care"
STAR_LABELS = ["5", "4", "3", "2", "1"]


# ---------------------------------------------------------------- file helpers

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    # Same formatting as the existing files, so git diffs show only the new entry.
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def make_key(name):
    # Must match lookupInsurance/lookupReviews in app.js: name.trim().toLowerCase()
    return name.strip().lower()


# ------------------------------------------------------------------- network

def _ssl_context():
    # python.org installs of Python on macOS ship without CA certificates until
    # "Install Certificates.command" is run, which makes every HTTPS call fail.
    # Prefer certifi if present, then the macOS/Linux system bundle.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if os.path.exists(bundle):
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


def http_json(url, data=None, timeout=25):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def geocode(place):
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", place)
    if m:
        return float(m.group(1)), float(m.group(2)), place
    try:
        results = http_json(NOMINATIM_URL + "?" + urllib.parse.urlencode(
            {"q": place, "format": "json", "limit": 1}))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        sys.exit(f"Could not look up {place!r} ({e}). Check your internet connection, "
                 f"or pass coordinates like --near \"39.2961,-76.5929\".")
    if not results:
        sys.exit(f"Could not find a place called {place!r}. Try adding the country.")
    r = results[0]
    return float(r["lat"]), float(r["lon"]), r.get("display_name", place)


def search_osm_hospitals(term, lat, lon, radius):
    safe = re.sub(r'["\\]', "", term)
    query = f"""[out:json][timeout:20];
(
  nwr["amenity"="hospital"]["name"~"{safe}",i](around:{radius},{lat},{lon});
);
out tags center;"""
    # Ask all mirrors at once; first good answer wins. Each runs in a daemon thread
    # with a hard deadline, because a stalled server can outlast socket timeouts.
    import queue
    import threading

    last_err = None
    for round_ in range(2):
        results = queue.Queue()

        def worker(url):
            host = urllib.parse.urlparse(url).hostname
            try:
                data = http_json(url, {"data": query})
                # Overloaded servers answer 200 with an empty list plus a "remark".
                if data.get("remark"):
                    raise RuntimeError(data["remark"])
                results.put(("ok", host, data.get("elements", [])))
            except Exception as e:  # noqa: BLE001 - report any failure and move on
                results.put(("err", host, str(e)))

        for url in OVERPASS_URLS:
            threading.Thread(target=worker, args=(url,), daemon=True).start()
        print("  asking OpenStreetMap servers ...", flush=True)
        deadline = time.time() + 35
        pending = len(OVERPASS_URLS)
        while pending:
            try:
                kind, host, payload = results.get(timeout=max(0.1, deadline - time.time()))
            except queue.Empty:
                last_err = last_err or "no response in 35s"
                break
            pending -= 1
            if kind == "ok":
                return payload
            last_err = f"{host}: {payload}"
            print(f"    {host} failed ({payload})", flush=True)
        if round_ == 0:
            print("  servers busy, retrying in 3s ...", flush=True)
            time.sleep(3)
    sys.exit(f"All OpenStreetMap servers failed ({last_err}). Try again in a minute, "
             f"or use --key with the exact name.")


def find_candidates(term, near, radius):
    lat, lon, label = geocode(near)
    print(f"Searching near: {label}  (radius {radius / 1000:g} km)")
    elements = search_osm_hospitals(term, lat, lon, radius)
    seen, out = set(), []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name or name in seen:
            continue
        seen.add(name)
        addr = ", ".join(tags[k] for k in ("addr:housenumber", "addr:street", "addr:city", "addr:state")
                         if tags.get(k))
        out.append({"name": name, "address": addr or "(no address in OSM)", "type": el["type"], "id": el["id"]})
    return out


# ------------------------------------------------------------------- prompts

def ask(prompt, default=None, required=True):
    suffix = f" [{default}]" if default not in (None, "") else ""
    while True:
        val = input(f"{prompt}{suffix}: ").strip()
        if not val and default is not None:
            return default
        if val or not required:
            return val
        print("  (required)")


def ask_number(prompt, cast, lo=None, hi=None, required=True):
    while True:
        raw = ask(prompt, required=required)
        if not raw and not required:
            return None
        try:
            val = cast(raw.replace(",", ""))
        except ValueError:
            print("  Please enter a number.")
            continue
        if (lo is not None and val < lo) or (hi is not None and val > hi):
            print(f"  Must be between {lo} and {hi}.")
            continue
        return val


def ask_list(prompt, hint):
    print(f"{prompt}\n  {hint}")
    items = []
    while True:
        line = input("  > ").strip()
        if not line:
            if items:
                return items
            print("  (enter at least one)")
            continue
        items.append(line)


def choose_specialty(existing):
    specialties = sorted(existing)
    if DEFAULT_SPECIALTY in specialties:
        specialties.remove(DEFAULT_SPECIALTY)
        specialties.insert(0, DEFAULT_SPECIALTY)
    print("\nType of care:")
    for i, s in enumerate(specialties, 1):
        print(f"  {i:>2}. {s}")
    print("  Or type a brand-new category name.")
    while True:
        raw = ask("Pick a number or type a name", default="1")
        if raw.isdigit() and 1 <= int(raw) <= len(specialties):
            return specialties[int(raw) - 1]
        if not raw.isdigit():
            return raw


def collect_topics():
    print("\nReview topics (optional) — only ones you actually saw, e.g. Google's topic chips.")
    print("  Format: Label=count   (blank line to finish)")
    topics = []
    while True:
        line = input("  > ").strip()
        if not line:
            return topics
        m = re.fullmatch(r"(.+?)\s*=\s*(\d+)", line)
        if not m:
            print("  Use Label=count, e.g. parking=42")
            continue
        topics.append([m.group(1), int(m.group(2))])


def collect_breakdown(review_count):
    print("\nStar breakdown (optional) — real counts only, never estimates.")
    if ask("Add it? (y/N)", default="n").lower() != "y":
        return None
    counts = [ask_number(f"  {s}-star count", int, lo=0) for s in STAR_LABELS]
    total = sum(counts)
    if total != review_count:
        print(f"  Note: breakdown sums to {total} but reviewCount is {review_count}. "
              f"Fine if Google's numbers are rounded — otherwise double-check.")
    return counts


# ------------------------------------------------------------------ commands

def pick_candidate(candidates, insurance, reviews):
    print()
    for i, c in enumerate(candidates, 1):
        key = make_key(c["name"])
        flags = []
        if key in insurance:
            flags.append("insurance ✓")
        if key in reviews:
            flags.append("reviews ✓")
        status = f"   [already in: {', '.join(flags)}]" if flags else ""
        print(f"  {i}. {c['name']}\n     {c['address']}{status}")
    return candidates


def cmd_find(args):
    insurance, reviews = load_json(INSURANCE_FILE), load_json(REVIEWS_FILE)
    candidates = find_candidates(args.name, args.near, args.radius)
    if not candidates:
        print(f"\nNo amenity=hospital named like {args.name!r} found. Large campuses are often "
              f"split into differently named buildings — try a shorter search word, a bigger "
              f"--radius, or check openstreetmap.org.")
        return
    pick_candidate(candidates, insurance, reviews)
    print("\nUse the name exactly as shown (the script lowercases it for you).")


def cmd_add(args):
    insurance, reviews = load_json(INSURANCE_FILE), load_json(REVIEWS_FILE)

    if args.key:
        name = args.key.strip()
        print(f"Using key as given: {make_key(name)!r}  (not verified against OpenStreetMap)")
    else:
        if not args.name or not args.near:
            sys.exit("Give a name and --near, e.g.  add \"Johns Hopkins\" --near \"Baltimore, MD\"  "
                     "(or use --key).")
        candidates = find_candidates(args.name, args.near, args.radius)
        if not candidates:
            sys.exit("No matching OpenStreetMap hospital found. See `find` tips, or use --key.")
        pick_candidate(candidates, insurance, reviews)
        idx = ask_number("\nWhich one? (number)", int, lo=1, hi=len(candidates))
        name = candidates[idx - 1]["name"]

    key = make_key(name)
    if key in insurance or key in reviews:
        where = [n for n, d in (("insurance-data.json", insurance), ("reviews-data.json", reviews)) if key in d]
        print(f"\n{key!r} already exists in {' and '.join(where)}.")
        if ask("Overwrite it? (y/N)", default="n").lower() != "y":
            sys.exit("Nothing changed.")

    existing_specialties = {v.get("specialty") for k, v in insurance.items()
                            if k != "_readme" and isinstance(v, dict) and v.get("specialty")}
    existing_specialties.add(DEFAULT_SPECIALTY)

    print(f"\n=== Insurance for {name} ===")
    insurances = ask_list("Insurances accepted (one per line, blank line to finish).",
                          "Get these from the hospital's website or by calling. Don't guess.")
    specialty = choose_specialty(existing_specialties)
    note = ask("Short note (optional, shown in popup)", required=False)
    er_url = ask("Live ER wait-time page URL (optional — only if the hospital publishes one)", required=False)

    ins_entry = {"insurances": insurances, "specialty": specialty}
    if note:
        ins_entry["note"] = note
    if er_url:
        ins_entry["erWaitUrl"] = er_url

    print(f"\n=== Reviews for {name} ===")
    print("Use the real numbers shown on Google Maps today.")
    rating = ask_number("Overall rating (e.g. 4.2)", float, lo=1, hi=5)
    review_count = ask_number("Number of reviews", int, lo=0)
    as_of = ask("Data captured (YYYY-MM)", default=date.today().strftime("%Y-%m"))
    print("Summary: write 1-3 sentences in your own words about what reviewers actually say.")
    summary = ask("Summary")
    topics = collect_topics()
    breakdown = collect_breakdown(review_count)

    rev_entry = {"rating": rating, "reviewCount": review_count, "asOf": as_of, "summary": summary}
    if topics:
        rev_entry["topics"] = topics
    if breakdown:
        rev_entry["ratingBreakdown"] = breakdown

    print("\n--- Preview ---")
    print(f'insurance-data.json  "{key}":')
    print(json.dumps(ins_entry, indent=2, ensure_ascii=False))
    print(f'reviews-data.json    "{key}":')
    print(json.dumps(rev_entry, indent=2, ensure_ascii=False))
    if ask("\nSave both? (Y/n)", default="y").lower() != "y":
        sys.exit("Nothing changed.")

    insurance[key] = ins_entry
    reviews[key] = rev_entry
    save_json(INSURANCE_FILE, insurance)
    save_json(REVIEWS_FILE, reviews)
    print(f"\nSaved. Reload the app (Cmd+Shift+R) and search near the hospital to see it.")
    print("Then commit when you're happy:  git add insurance-data.json reviews-data.json && git commit")
    problems = validate(load_json(INSURANCE_FILE), load_json(REVIEWS_FILE))
    if problems:
        print("\nWarning — validation found problems:")
        for p in problems:
            print("  -", p)


def validate(insurance, reviews):
    problems = []
    ik = {k for k in insurance if k != "_readme"}
    rk = {k for k in reviews if k != "_readme"}
    for k in sorted(ik - rk):
        problems.append(f"{k!r} is in insurance-data.json but not reviews-data.json")
    for k in sorted(rk - ik):
        problems.append(f"{k!r} is in reviews-data.json but not insurance-data.json")
    for k in sorted(ik | rk):
        if k != k.strip().lower():
            problems.append(f"key {k!r} is not trimmed/lowercase, so the app will never match it")
    for k in sorted(ik):
        v = insurance[k]
        if not isinstance(v, dict):
            problems.append(f"{k!r}: insurance entry is not an object")
            continue
        if not v.get("insurances") or not isinstance(v["insurances"], list):
            problems.append(f"{k!r}: missing or empty 'insurances' list")
        if not v.get("specialty"):
            problems.append(f"{k!r}: missing 'specialty'")
    for k in sorted(rk):
        v = reviews[k]
        if not isinstance(v, dict):
            problems.append(f"{k!r}: review entry is not an object")
            continue
        for field in ("rating", "reviewCount", "asOf", "summary"):
            if field not in v:
                problems.append(f"{k!r}: missing '{field}'")
        r = v.get("rating")
        if isinstance(r, (int, float)) and not 1 <= r <= 5:
            problems.append(f"{k!r}: rating {r} outside 1-5")
        b = v.get("ratingBreakdown")
        if b is not None and (not isinstance(b, list) or len(b) != 5):
            problems.append(f"{k!r}: ratingBreakdown must be 5 numbers [5★..1★]")
    return problems


def cmd_check(_args):
    insurance, reviews = load_json(INSURANCE_FILE), load_json(REVIEWS_FILE)
    problems = validate(insurance, reviews)
    n = len({k for k in insurance if k != "_readme"})
    if problems:
        print(f"{len(problems)} problem(s) found:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print(f"OK — {n} hospitals, both files consistent.")


def main():
    p = argparse.ArgumentParser(description="Add hospitals to the app's data files.")
    sub = p.add_subparsers(dest="cmd", required=True)

    for name, fn, help_ in (("find", cmd_find, "look up exact OpenStreetMap names"),
                            ("add", cmd_add, "add a hospital (interactive)")):
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("name", nargs="?", help="part of the hospital's name")
        sp.add_argument("--near", help='place name or "lat,lon", e.g. "Baltimore, MD"')
        sp.add_argument("--radius", type=int, default=15000, help="search radius in meters (default 15000)")
        if name == "add":
            sp.add_argument("--key", help="exact OSM name tag; skips the lookup")
        sp.set_defaults(fn=fn)

    sp = sub.add_parser("check", help="validate both data files")
    sp.set_defaults(fn=cmd_check)

    args = p.parse_args()
    if args.cmd == "find" and (not args.name or not args.near):
        p.error('find needs a name and --near, e.g.  find "Johns Hopkins" --near "Baltimore, MD"')
    try:
        args.fn(args)
    except KeyboardInterrupt:
        sys.exit("\nCancelled. Nothing changed.")


if __name__ == "__main__":
    main()
