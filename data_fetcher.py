"""
HKJC Data Fetcher
-----------------
Fetches live and historical race data via the HKJC GraphQL API.
Uses the same endpoint as the hkjc-api npm package:
  https://info.cld.hkjc.com/graphql/base/
"""
import json
import time
import requests
import pandas as pd
from datetime import datetime, date
from typing import Optional


# ---------------------------------------------------------------------------
# GraphQL endpoint
# ---------------------------------------------------------------------------
GRAPHQL_URL = "https://info.cld.hkjc.com/graphql/base/"

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Origin": "https://bet.hkjc.com",
    "Referer": "https://bet.hkjc.com/",
}

# Query extracted from bet.hkjc.com frontend bundle (main.27c3f033.js)
_RACE_MEETINGS_QUERY = """
fragment raceFragment on Race {
    id
    no
    status
    raceName_en
    raceName_ch
    postTime
    country_en
    country_ch
    distance
    wageringFieldSize
    go_en
    go_ch
    ratingType
    raceTrack {
      description_en
      description_ch
    }
    raceCourse {
      description_en
      description_ch
      displayCode
    }
    claCode
    raceClass_en
    raceClass_ch
    judgeSigns {
      value_en
    }
  }

fragment racingBlockFragment on RaceMeeting {
    jpEsts: pmPools(oddsTypes: [WIN,PLA,TCE,TRI,FF,QTT,DT,TT,SixUP], filters: ["jackpot", "estimatedDividend"]) {
      leg { number races }
      oddsType jackpot estimatedDividend mergedPoolId
    }
    poolInvs: pmPools(oddsTypes: [WIN,PLA,QIN,QPL,CWA,CWB,CWC,IWN,FCT,TCE,TRI,FF,QTT,DBL,TBL,DT,TT,SixUP]) {
      id
      leg { races }
    }
    penetrometerReadings(filters:["first"]) { reading readingTime }
    hammerReadings(filters:["first"]) { reading readingTime }
    changeHistories(filters:["top3"]) {
      type time raceNo runnerNo
      horseName_ch horseName_en
      jockeyName_ch jockeyName_en
      scratchHorseName_ch scratchHorseName_en
      handicapWeight scrResvIndicator
    }
  }

query raceMeetings($date: String, $venueCode: String) {
            timeOffset {
              rc
            }
            activeMeetings : raceMeetings
            {
              id
              venueCode
              date
              status
              races {
                no
                postTime
                status
                wageringFieldSize
              }
            }
            raceMeetings(date: $date, venueCode: $venueCode)
            {
              id
              status
              venueCode
              date
              totalNumberOfRace
              currentNumberOfRace
              dateOfWeek
              meetingType
              totalInvestment
              country {
                code
                namech
                nameen
                seq
              }
              races {
                ...raceFragment
                runners {
                    id
                    no
                    standbyNo
                    status
                    name_ch
                    name_en
                    horse {
                      id
                      code
                    }
                    color
                    barrierDrawNumber
                    handicapWeight
                    currentWeight
                    currentRating
                    internationalRating
                    gearInfo
                    racingColorFileName
                    allowance
                    trainerPreference
                    last6run
                    saddleClothNo
                    trumpCard
                    priority
                    finalPosition
                    deadHeat
                    winOdds
                    jockey {
                      code
                      name_en
                      name_ch
                    }
                    trainer {
                      code
                      name_en
                      name_ch
                    }
                }
              }
              obSt: pmPools(oddsTypes: [WIN, PLA]) {
                leg { races }
                oddsType
                comingleStatus
              }
              poolInvs: pmPools(oddsTypes: [WIN,PLA,QIN,QPL,CWA,CWB,CWC,IWN,FCT,TCE,TRI,FF,QTT,DBL,TBL,DT,TT,SixUP]) {
                id
                leg { number races }
                status
                sellStatus
                oddsType
                investment
                mergedPoolId
                lastUpdateTime
              }
              ...racingBlockFragment
              pmPools(oddsTypes: []) {
                id
              }
              jkcInstNo : foPools(oddsTypes: [JKC], filters: ["top"]) {
                instNo
              }
              tncInstNo : foPools(oddsTypes: [TNC], filters: ["top"]) {
                instNo
              }
            }
        }
"""

RACE_DATE_FMT = "%Y-%m-%d"


# ---------------------------------------------------------------------------
# GraphQL helper
# ---------------------------------------------------------------------------

def _gql(query: str, variables: Optional[dict] = None) -> dict:
    body = {"query": query}
    if variables:
        body["variables"] = variables
    resp = requests.post(GRAPHQL_URL, json=body, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    data = resp.json()
    if "errors" in data and data.get("data") is None:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data.get("data") or {}


# ---------------------------------------------------------------------------
# Live API helpers
# ---------------------------------------------------------------------------

def get_race_card(race_date: Optional[str] = None, venue: str = "HV") -> dict:
    """
    Fetch the full race card (runners + current odds) for a given date/venue.

    Returns dict:
        {date, venue, races: [{race_no, class, distance, going, course,
                               runners: [{horse, jockey, trainer, draw,
                                          declar_wt, act_wt, win_odds}]}]}
    """
    if race_date is None:
        race_date = date.today().strftime(RACE_DATE_FMT)

    data = _gql(_RACE_MEETINGS_QUERY, {"date": race_date, "venueCode": venue})
    meetings = data.get("raceMeetings") or []
    if not meetings:
        return {"date": race_date, "venue": venue, "races": []}

    return _parse_meeting(meetings[0], race_date, venue)


def get_results(race_date: str, venue: str = "HV") -> pd.DataFrame:
    """
    Fetch official results for a completed race day.
    Returns DataFrame (one row per runner) with 'won' column derived from finalPosition.
    """
    data = _gql(_RACE_MEETINGS_QUERY, {"date": race_date, "venueCode": venue})
    meetings = data.get("raceMeetings") or []
    if not meetings:
        return pd.DataFrame()
    return _meeting_to_df(meetings[0], race_date, venue)


def get_active_meetings() -> list:
    """Return list of currently active meeting dicts {venueCode, date}."""
    data = _gql(_RACE_MEETINGS_QUERY, {})
    return data.get("activeMeetings") or []


# ---------------------------------------------------------------------------
# Internal parsers
# ---------------------------------------------------------------------------

def _parse_meeting(meeting: dict, race_date: str, venue: str) -> dict:
    """Convert a raceMeetings GraphQL node to our internal card format."""
    races = []
    for race in meeting.get("races", []):
        runners = []
        for r in race.get("runners", []):
            runners.append({
                "horse_no":   r.get("no"),
                "horse":      r.get("name_en"),
                "horse_ch":   r.get("name_ch"),
                "horse_id":   (r.get("horse") or {}).get("code"),
                "jockey":     (r.get("jockey") or {}).get("code"),
                "jockey_ch":  (r.get("jockey") or {}).get("name_ch"),
                "trainer":    (r.get("trainer") or {}).get("code"),
                "trainer_ch": (r.get("trainer") or {}).get("name_ch"),
                "draw":       _safe_int(r.get("barrierDrawNumber")),
                "declar_wt":  _safe_float(r.get("handicapWeight")),
                "act_wt":     _safe_float(r.get("currentWeight")),
                "win_odds":   _safe_float(r.get("winOdds")),
            })
        races.append({
            "race_no":  race.get("no"),
            "class":    race.get("raceClass_en", ""),
            "distance": _safe_int(race.get("distance")),
            "going":    race.get("go_en", ""),
            "course":   (race.get("raceCourse") or {}).get("displayCode", ""),
            "pool":     None,
            "runners":  runners,
        })
    return {"date": race_date, "venue": venue, "races": races}


def _meeting_to_df(meeting: dict, race_date: str, venue: str) -> pd.DataFrame:
    """Flatten a GraphQL meeting node into a results DataFrame."""
    rows = []
    for race in meeting.get("races", []):
        race_no  = race.get("no")
        class_   = race.get("raceClass_en", "")
        dist     = _safe_int(race.get("distance"))
        going    = race.get("go_en", "")
        course   = (race.get("raceCourse") or {}).get("displayCode", "")

        for r in race.get("runners", []):
            rows.append({
                "date":      race_date,
                "location":  venue,
                "race_no":   race_no,
                "class":     class_,
                "distance":  dist,
                "going":     going,
                "course":    course,
                "pool":      None,
                "place":     _safe_int(r.get("finalPosition")),
                "horse":     r.get("name_en"),
                "horse_id":  (r.get("horse") or {}).get("code"),
                "jockey":    (r.get("jockey") or {}).get("code"),
                "trainer":   (r.get("trainer") or {}).get("code"),
                "act_wt":    _safe_float(r.get("currentWeight")),
                "declar_wt": _safe_float(r.get("handicapWeight")),
                "draw":      _safe_int(r.get("barrierDrawNumber")),
                "lbw":       None,   # not exposed by the API
                "time":      None,   # not exposed by the API
                "win_odds":  _safe_float(r.get("winOdds")),
            })
    df = pd.DataFrame(rows)
    if "place" in df.columns:
        df["won"] = (pd.to_numeric(df["place"], errors="coerce") == 1).astype(int)
    return df


# ---------------------------------------------------------------------------
# CSV / historical data loader
# ---------------------------------------------------------------------------

REQUIRED_COLS = [
    "date", "location", "race_no", "class", "distance", "going", "course",
    "pool", "place", "horse_id", "horse", "jockey", "trainer",
    "act_wt", "declar_wt", "draw", "lbw", "time", "win_odds",
]

OPTIONAL_COLS = ["age", "finish_pos"]


def load_historical_csv(path: str) -> pd.DataFrame:
    """
    Load a historical CSV (produced by build_dataset.py or a third-party scrape).
    Flexible column aliasing handles different naming conventions.
    """
    df = pd.read_csv(path, low_memory=False)
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    aliases = {
        "actual_weight":     "act_wt",
        "declare_weight":    "declar_wt",
        "declared_weight":   "declar_wt",
        "race_number":       "race_no",
        "win_odd":           "win_odds",
        "finishing_time":    "time",
        "finish_time":       "time",
        "horse_name":        "horse",
        "jockey_name":       "jockey",
        "trainer_name":      "trainer",
        "position":          "place",
        "finish_position":   "place",
        "finishing_position":"place",
        "venue":             "location",
        "racecourse":        "location",
        "barrier":           "draw",
        "barrier_draw":      "draw",
        "going_condition":   "going",
    }
    df.rename(columns={k: v for k, v in aliases.items() if k in df.columns},
              inplace=True)

    df = _cast_types(df)
    df = df.sort_values(["date", "location", "race_no", "draw"]).reset_index(drop=True)
    return df


# ---------------------------------------------------------------------------
# Type casting
# ---------------------------------------------------------------------------

def _cast_types(df: pd.DataFrame) -> pd.DataFrame:
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
    for col in ["place", "race_no", "draw", "age"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ["act_wt", "declar_wt", "win_odds", "pool", "lbw"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    if "place" in df.columns and "won" not in df.columns:
        df["won"] = (df["place"] == 1).astype(int)
    return df


def _safe_int(v) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _safe_float(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
